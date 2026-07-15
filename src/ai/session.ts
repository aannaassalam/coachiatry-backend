import type { Request } from "express";
import { getCacheClient } from "../utils/redis";

export type ChatTurn = {
    role: "user" | "model";
    text: string;
    ts: number;
};

export type SessionBag = {
    id: string;
    userId: string;
    turns: ChatTurn[];
    createdAt: number;
    updatedAt: number;
};

const SESS_PREFIX = "ai_sess:";
const SESS_TTL_SEC = 60 * 60; // 1 hour
const MAX_TURNS = 20;

// Immutable once the session is created; the turns live in a separate list.
type SessionMeta = Pick<SessionBag, "id" | "userId" | "createdAt">;

// Storage layout:
//   ai_sess:<id>        -> JSON metadata, written once at creation
//   ai_sess:<id>:turns  -> LIST of JSON-encoded ChatTurn, oldest first
//
// Turns are a list rather than an array inside the metadata blob because
// appending has to be atomic. Callers in LLMController fire appendTurn without
// awaiting it (~15 sites), so a read-modify-write cycle interleaves with itself
// even within a single request: the "user" turn and the "model" turn both read
// the same state and the second SET drops the first turn. RPUSH has no such
// window — concurrent appends all land, and Redis applies them in the order the
// commands arrive, so the un-awaited call sites stay correctly ordered.
class RedisSessionStore {
    private metaKey(sessionId: string) {
        return `${SESS_PREFIX}${sessionId}`;
    }

    private turnsKey(sessionId: string) {
        return `${SESS_PREFIX}${sessionId}:turns`;
    }

    private async load(sessionId: string): Promise<SessionBag | null> {
        try {
            const res = await getCacheClient()
                .pipeline()
                .get(this.metaKey(sessionId))
                .lrange(this.turnsKey(sessionId), 0, -1)
                .exec();
            if (!res) return null;

            const [[metaErr, metaRaw], [turnsErr, turnsRaw]] = res;
            if (metaErr) throw metaErr;
            if (turnsErr) throw turnsErr;
            if (!metaRaw) return null; // expired or never created

            const meta = JSON.parse(metaRaw as string) as SessionMeta;
            const turns = (turnsRaw as string[]).reduce<ChatTurn[]>(
                (acc, raw) => {
                    try {
                        acc.push(JSON.parse(raw) as ChatTurn);
                    } catch {
                        // Drop the unreadable turn rather than the conversation.
                    }
                    return acc;
                },
                []
            );

            return {
                id: meta.id,
                userId: meta.userId,
                createdAt: meta.createdAt,
                turns,
                updatedAt: turns.at(-1)?.ts ?? meta.createdAt,
            };
        } catch (err) {
            // Redis is optional (see bootstrap() in server.ts), and conversation
            // history is a nice-to-have. Degrade to a session with no history
            // rather than failing the whole AI request.
            console.warn(
                "[ai/session] load failed, continuing without history:",
                (err as Error).message
            );
            return null;
        }
    }

    async upsert(sessionId: string, userId: string): Promise<SessionBag> {
        const now = Date.now();
        const fresh: SessionBag = {
            id: sessionId,
            userId,
            turns: [],
            createdAt: now,
            updatedAt: now,
        };

        try {
            const meta: SessionMeta = { id: sessionId, userId, createdAt: now };
            // NX so a concurrent upsert of the same session can't reset
            // createdAt or wipe the metadata out from under an active chat.
            const created = await getCacheClient().set(
                this.metaKey(sessionId),
                JSON.stringify(meta),
                "EX",
                SESS_TTL_SEC,
                "NX"
            );
            if (created) return fresh;

            const existing = await this.load(sessionId);
            if (!existing) return fresh; // raced with an expiry

            await this.touch(sessionId);
            return existing;
        } catch (err) {
            console.warn(
                "[ai/session] upsert failed, using an ephemeral session:",
                (err as Error).message
            );
            return fresh;
        }
    }

    async appendTurn(sessionId: string, role: ChatTurn["role"], text: string) {
        const turn: ChatTurn = { role, text, ts: Date.now() };
        try {
            await getCacheClient()
                .multi()
                .rpush(this.turnsKey(sessionId), JSON.stringify(turn))
                .ltrim(this.turnsKey(sessionId), -MAX_TURNS, -1)
                .expire(this.turnsKey(sessionId), SESS_TTL_SEC)
                .expire(this.metaKey(sessionId), SESS_TTL_SEC)
                .exec();
            // If the session has expired, this leaves an orphan turns list with
            // no metadata. load() keys off the metadata, so the orphan is
            // invisible and expires on its own — an append can't resurrect a
            // dead session.
        } catch (err) {
            console.warn(
                "[ai/session] appendTurn failed, turn not persisted:",
                (err as Error).message
            );
        }
    }

    /** Refresh the TTL on both keys so an active conversation doesn't expire. */
    private async touch(sessionId: string) {
        await getCacheClient()
            .pipeline()
            .expire(this.metaKey(sessionId), SESS_TTL_SEC)
            .expire(this.turnsKey(sessionId), SESS_TTL_SEC)
            .exec();
    }

    async get(sessionId: string): Promise<SessionBag | null> {
        return this.load(sessionId);
    }
}

export const sessionStore = new RedisSessionStore();

export function getOrCreateSessionId(req: Request): string {
    const header = (req.headers["x-session-id"] as string) || "";
    const query = (req.query.sessionId as string) || "";
    const cookie = (req as any).cookies?.ai_session || "";

    const candidate = header || query || cookie;
    if (candidate) return candidate;

    return generateSessionId();
}

function generateSessionId(): string {
    return `sess_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}
