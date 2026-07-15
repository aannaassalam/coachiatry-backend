import { getCacheClient } from "./redis";

// Fail-open cache helpers.
//
// Redis is optional infrastructure here — bootstrap() in server.ts logs a
// warning and serves traffic without it. So every read and write below swallows
// its errors and lets the caller fall through to Mongo. A cache outage must
// cost latency, never availability: the moment a cache miss can 500 a request,
// Redis has quietly become a single point of failure for the whole app.
//
// The one deliberate exception is OAuth state in oauthExtensionController, which
// does NOT use these helpers because it must fail closed.

/** Key namespaces. Keep them here so invalidation sites are greppable. */
export const cacheKeys = {
    user: (id: string) => `user:${id}`,
    hierarchy: (id: string) => `hierarchy:${id}`,
    // Keyed by a hash of the filter, not by user: the call sites use genuinely
    // different filters ({public:true} vs {public:true,user:null}) and
    // collapsing them onto one key would silently change what each one sees.
    reference: (model: string, hash: string) => `ref:${model}:${hash}`,
    aiIntent: (hash: string) => `ai:intent:${hash}`,
    aiLock: (userId: string, hash: string) => `ai:lock:${userId}:${hash}`,
    count: (model: string, hash: string) => `count:${model}:${hash}`,
    unread: (chatId: string, userId: string) => `unread:${chatId}:${userId}`,
};

export async function cacheGet<T>(key: string): Promise<T | null> {
    try {
        const raw = await getCacheClient().get(key);
        return raw === null ? null : (JSON.parse(raw) as T);
    } catch (err) {
        warn("get", key, err);
        return null;
    }
}

export async function cacheSet(key: string, value: unknown, ttlSec: number) {
    try {
        await getCacheClient().set(key, JSON.stringify(value), "EX", ttlSec);
    } catch (err) {
        warn("set", key, err);
    }
}

export async function cacheDel(...keys: string[]) {
    if (!keys.length) return;
    try {
        await getCacheClient().del(...keys);
    } catch (err) {
        warn("del", keys.join(","), err);
    }
}

/**
 * Read-through cache. On a miss — or any Redis trouble at all — runs `produce`
 * and returns its result, caching it only on a clean round trip.
 *
 * `produce` errors are NOT swallowed: a failing Mongo query is a real error and
 * must surface. Only cache errors are absorbed.
 */
export async function cached<T>(
    key: string,
    ttlSec: number,
    produce: () => Promise<T>
): Promise<T> {
    const hit = await cacheGet<T>(key);
    if (hit !== null) return hit;

    const value = await produce();
    // Don't store null/undefined: it's indistinguishable from a miss on read,
    // so it would re-run `produce` every time anyway while burning a key.
    if (value !== null && value !== undefined) await cacheSet(key, value, ttlSec);
    return value;
}

/**
 * Delete every key matching a pattern, without KEYS (which blocks the server
 * and would stall every other client while it walks the keyspace).
 */
export async function cacheDelPattern(pattern: string) {
    try {
        const client = getCacheClient();
        let cursor = "0";
        do {
            const [next, keys] = await client.scan(
                cursor,
                "MATCH",
                pattern,
                "COUNT",
                100
            );
            cursor = next;
            if (keys.length) await client.del(...keys);
        } while (cursor !== "0");
    } catch (err) {
        warn("delPattern", pattern, err);
    }
}

function warn(op: string, key: string, err: unknown) {
    console.warn(`[cache] ${op} ${key} failed:`, (err as Error).message);
}
