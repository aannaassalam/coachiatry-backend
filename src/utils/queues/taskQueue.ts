import { Queue } from "bullmq";
import { redisConnection } from "../redis";

export const taskQueue = new Queue("task-queue", {
    connection: redisConnection,
});
