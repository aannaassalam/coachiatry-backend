import type { Request } from "express";
import Redis from "ioredis";
import { redisConnection } from "../utils/redis";

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

// Reuse this singleton Redis client
const redis = new Redis(redisConnection);

class RedisSessionStore {
    private makeKey(sessionId: string) {
        return `${SESS_PREFIX}${sessionId}`;
    }

    private async load(sessionId: string): Promise<SessionBag | null> {
        const raw = await redis.get(this.makeKey(sessionId));
        if (!raw) return null;
        try {
            return JSON.parse(raw) as SessionBag;
        } catch {
            return null;
        }
    }

    private async save(bag: SessionBag) {
        await redis.set(
            this.makeKey(bag.id),
            JSON.stringify(bag),
            "EX",
            SESS_TTL_SEC // refresh TTL each write
        );
    }

    async upsert(sessionId: string, userId: string): Promise<SessionBag> {
        const existing = await this.load(sessionId);
        if (existing) {
            existing.updatedAt = Date.now();
            await this.save(existing);
            return existing;
        }

        const bag: SessionBag = {
            id: sessionId,
            userId,
            turns: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await this.save(bag);
        return bag;
    }

    async appendTurn(sessionId: string, role: ChatTurn["role"], text: string) {
        const bag = await this.load(sessionId);
        if (!bag) return;
        bag.turns.push({ role, text, ts: Date.now() });

        if (bag.turns.length > MAX_TURNS)
            bag.turns.splice(0, bag.turns.length - MAX_TURNS);

        bag.updatedAt = Date.now();
        await this.save(bag);
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
