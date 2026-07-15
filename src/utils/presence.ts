import { getCacheClient } from "./redis";

// Cross-instance presence tracking.
//
// Sockets for one user can land on different instances, so "is this user
// online?" cannot be answered from process memory alone. Each user gets a Redis
// sorted set of their live socket ids, scored by the last heartbeat:
//
//   presence:<userId>  ZSET  { <socketId> -> <last heartbeat ms> }
//
// A sorted set rather than a plain set because an instance that crashes never
// runs its disconnect handlers, and its socket ids would otherwise linger in the
// set forever — leaving the user permanently "online" for as long as any other
// instance keeps the key alive. Scoring by heartbeat lets a reader ignore (and
// clean up) entries nobody has refreshed lately, so a crashed instance's
// sockets age out on their own.
//
// A process-local mirror is kept alongside it. If Redis is unreachable, presence
// falls back to that mirror, which is exactly the single-instance behavior the
// app had before — degrade to today, never to "everyone is offline".

const PRESENCE_PREFIX = "presence:";
/** An entry not refreshed within this window is treated as dead. */
const STALE_MS = 90_000;
/** Heartbeat cadence — comfortably inside STALE_MS so live sockets never lapse. */
const HEARTBEAT_MS = 30_000;
/** Whole-key TTL, so a user with no live instances disappears on their own. */
const KEY_TTL_SEC = 300;

const key = (userId: string) => `${PRESENCE_PREFIX}${userId}`;

/** Sockets connected to THIS instance: userId -> socketIds. */
const localSockets = new Map<string, Set<string>>();

export async function addSocket(userId: string, socketId: string) {
    if (!localSockets.has(userId)) localSockets.set(userId, new Set());
    localSockets.get(userId)!.add(socketId);

    try {
        await getCacheClient()
            .multi()
            .zadd(key(userId), Date.now(), socketId)
            .expire(key(userId), KEY_TTL_SEC)
            .exec();
    } catch (err) {
        warn("addSocket", err);
    }
}

/**
 * Remove a socket. Returns true when the user has no live sockets left anywhere
 * — i.e. when the caller should broadcast them offline.
 */
export async function removeSocket(
    userId: string,
    socketId: string
): Promise<boolean> {
    const local = localSockets.get(userId);
    local?.delete(socketId);
    if (local && local.size === 0) localSockets.delete(userId);

    const stillLocal = (localSockets.get(userId)?.size ?? 0) > 0;
    if (stillLocal) return false; // another socket here — definitely still online

    try {
        const client = getCacheClient();
        await client.zrem(key(userId), socketId);
        return !(await hasLiveEntries(userId));
    } catch (err) {
        warn("removeSocket", err);
        // Redis unavailable — fall back to what this instance can see.
        return true;
    }
}

export async function isUserOnline(userId: string): Promise<boolean> {
    if ((localSockets.get(userId)?.size ?? 0) > 0) return true;
    try {
        return await hasLiveEntries(userId);
    } catch (err) {
        warn("isUserOnline", err);
        return false;
    }
}

/** True if ANY of the given users is online. Used for delivery receipts. */
export async function isAnyUserOnline(userIds: string[]): Promise<boolean> {
    for (const id of userIds) {
        if ((localSockets.get(id)?.size ?? 0) > 0) return true;
    }
    try {
        const client = getCacheClient();
        const cutoff = Date.now() - STALE_MS;
        const pipeline = client.pipeline();
        for (const id of userIds) pipeline.zcount(key(id), cutoff, "+inf");
        const res = await pipeline.exec();
        if (!res) return false;
        return res.some(([err, count]) => !err && (count as number) > 0);
    } catch (err) {
        warn("isAnyUserOnline", err);
        return false;
    }
}

async function hasLiveEntries(userId: string): Promise<boolean> {
    const client = getCacheClient();
    const now = Date.now();
    // Drop anything a crashed instance left behind before counting.
    await client.zremrangebyscore(key(userId), "-inf", now - STALE_MS);
    return (await client.zcard(key(userId))) > 0;
}

/**
 * Debounce the "mark undelivered messages delivered" sweep across the fleet.
 * Was a per-process Map, which let N instances each run the sweep once per
 * window. Returns true if the caller should run it.
 */
export async function claimDeliveredSweep(
    userId: string,
    windowSec: number
): Promise<boolean> {
    try {
        const res = await getCacheClient().set(
            `sweep:${userId}`,
            "1",
            "EX",
            windowSec,
            "NX"
        );
        return res === "OK";
    } catch (err) {
        warn("claimDeliveredSweep", err);
        // Redis down: err on the side of running it. The sweep is idempotent —
        // it only flips "sent" to "delivered" — so a duplicate is wasted work,
        // never wrong data.
        return true;
    }
}

/** Drop the debounce so a genuine return from offline sweeps immediately. */
export async function releaseDeliveredSweep(userId: string) {
    try {
        await getCacheClient().del(`sweep:${userId}`);
    } catch (err) {
        warn("releaseDeliveredSweep", err);
    }
}

let heartbeat: NodeJS.Timeout | null = null;

/** Keep this instance's sockets from ageing out of the presence sets. */
export function startPresenceHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
        void (async () => {
            if (localSockets.size === 0) return;
            try {
                const now = Date.now();
                const pipeline = getCacheClient().pipeline();
                for (const [userId, socketIds] of localSockets) {
                    for (const socketId of socketIds) {
                        pipeline.zadd(key(userId), now, socketId);
                    }
                    pipeline.expire(key(userId), KEY_TTL_SEC);
                }
                await pipeline.exec();
            } catch (err) {
                warn("heartbeat", err);
            }
        })();
    }, HEARTBEAT_MS);
    heartbeat.unref(); // never hold the process open
}

export function stopPresenceHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
}

/** Best-effort cleanup of this instance's entries during graceful shutdown. */
export async function clearLocalPresence() {
    try {
        const pipeline = getCacheClient().pipeline();
        for (const [userId, socketIds] of localSockets) {
            for (const socketId of socketIds) pipeline.zrem(key(userId), socketId);
        }
        await pipeline.exec();
    } catch (err) {
        warn("clearLocalPresence", err);
    }
    localSockets.clear();
}

function warn(op: string, err: unknown) {
    console.warn(`[presence] ${op} failed:`, (err as Error).message);
}
