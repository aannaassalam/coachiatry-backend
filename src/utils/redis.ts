import Redis, { RedisOptions } from "ioredis";

// Connection *options* — not a connection. BullMQ takes this and builds its own
// dedicated connections per Queue/Worker, which it needs: its blocking commands
// (BZPOPMIN) occupy a socket for the whole duration of the block and cannot
// share one. Leave the queues and workers pointed here.
//
// For everything non-blocking (caching, AI sessions, OAuth state) use
// getCacheClient() instead — one shared socket rather than one per caller.
export const redisConnection: RedisOptions = {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    tls: process.env.NODE_ENV === "production" ? {} : undefined,
};

let cacheClient: Redis | null = null;

/**
 * The shared client for ordinary (non-blocking) Redis work. One socket for the
 * whole process — ioredis pipelines concurrent commands over it, so callers do
 * not queue behind each other.
 *
 * Deliberately NOT for:
 *   - BullMQ, which needs dedicated connections for its blocking commands.
 *   - A Socket.IO Redis adapter, whose subscriber connection cannot run normal
 *     commands once it enters subscriber mode. Give it its own duplicate() pair.
 */
export function getCacheClient(): Redis {
    if (cacheClient) return cacheClient;

    cacheClient = new Redis({
        ...redisConnection,
        // Redis is optional infrastructure here — bootstrap() in server.ts logs
        // a warning and carries on when it is unreachable — so a command must
        // never hang a request waiting for it. Left to itself, ioredis queues
        // commands until the connection is back, which is an unbounded wait.
        //
        // A cache hit is ~1ms, so anything still outstanding after a second
        // means Redis is unhealthy and the caller should go to Mongo instead.
        // (Note: enableOfflineQueue:false looks like the obvious way to get
        // this, but it also rejects commands issued during the initial connect
        // and every reconnect, so the first request after boot fails against a
        // perfectly healthy Redis. A timeout covers the down case without
        // breaking the connecting case.)
        commandTimeout: 1000,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 200, 5000),
    });

    // An ioredis client with no 'error' listener emits an *unhandled* 'error'
    // event. That would escape to the process-level handler in server.ts, which
    // is a crash net rather than somewhere to route routine reconnect noise.
    cacheClient.on("error", (err) => {
        console.error("[redis] cache client error:", err.message);
    });

    return cacheClient;
}

/**
 * Boot-time probe. Waits for the connection to come up rather than racing it —
 * a TLS handshake to a managed Redis can take longer than the per-command
 * timeout, and reporting a healthy Redis as unreachable on every deploy trains
 * people to ignore the log line.
 */
export async function verifyRedisConnection(timeoutMs = 10_000) {
    const client = getCacheClient();
    try {
        if (client.status !== "ready") await waitForReady(client, timeoutMs);
        const result = await client.ping();
        console.log("✅ Redis connected successfully:", result);
        return true;
    } catch (error) {
        console.error(
            "❌ Redis connection failed:",
            (error as Error).message
        );
        return false;
    }
}

function waitForReady(client: Redis, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            client.off("ready", onReady);
            client.off("error", onError);
        };
        const onReady = () => {
            cleanup();
            resolve();
        };
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`not ready after ${timeoutMs}ms`));
        }, timeoutMs);

        client.once("ready", onReady);
        client.once("error", onError);
    });
}

export async function closeRedis() {
    if (!cacheClient) return;

    const client = cacheClient;
    cacheClient = null;
    try {
        await client.quit();
    } catch {
        // quit() only fails if the connection is already gone; make sure the
        // socket and its retry timer are torn down either way, or shutdown
        // hangs waiting on a client that will never reconnect.
        client.disconnect();
    }
}
