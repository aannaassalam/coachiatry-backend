import { Queue } from "bullmq";
import { redisConnection } from "../redis";

export const messageQueue = new Queue("message-queue", {
    connection: redisConnection,
});
