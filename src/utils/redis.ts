import { RedisOptions } from "ioredis";

export const redisConnection: RedisOptions = {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    tls: process.env.NODE_ENV === "production" ? {} : undefined,
};
