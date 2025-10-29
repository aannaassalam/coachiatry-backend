import Redis, { RedisOptions } from "ioredis";

export const redisConnection: RedisOptions = {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    tls: process.env.NODE_ENV === "production" ? {} : undefined,
};

export async function verifyRedisConnection() {
    try {
        const client = new Redis(redisConnection);

        const result = await client.ping(); // Redis PING command
        console.log("✅ Redis connected successfully:", result);

        await client.quit();
        return true;
    } catch (error) {
        console.error("❌ Redis connection failed:", error);
        return false;
    }
}
