import { Worker } from "bullmq";
import socket from "../../config/socket.config"; // assuming you export io from your socket setup
import { redisConnection } from "../redis";
import TaskModel from "../../model/taskModel";
import MessageModel from "../../model/messageModel";
import ChatModel from "../../model/chatModel";
import moment from "moment";
import { taskQueue } from "../queues/taskQueue";

export function getNextOccurrence(current: Date, repeat: string): Date {
    const next = new Date(current);
    switch (repeat) {
        case "daily":
            next.setDate(next.getDate() + 1);
            break;
        case "weekly":
            next.setDate(next.getDate() + 7);
            break;
        case "monthly":
            next.setMonth(next.getMonth() + 1);
            break;
        case "yearly":
            next.setFullYear(next.getFullYear() + 1);
            break;
    }
    return next;
}

export const taskWorker = new Worker(
    "task-queue",
    async (job) => {
        const { taskId } = job.data;
        const io = socket.getIO();

        const task = await TaskModel.findById(taskId).populate("status");
        if (!task) return;

        if (!task.active || !task.dueDate) return;

        const chat = await ChatModel.findOne({
            "members.user": task.user,
            name: "Coachiatry",
            isDeletable: false,
        });

        const dueTimeText = moment(task.dueDate).format("hh:mm A");

        const sentMessage = await MessageModel.create({
            chat: chat._id,
            sender: task.user,
            content: `${(task.status as any).title}: ${task.title} is due today by ${dueTimeText}`,
            type: "text",
            status: "delivered",
        });

        io.to(String(chat._id)).emit("new_message", sentMessage);
    },
    { connection: redisConnection }
);

taskWorker.on("completed", (job) => {
    console.log(`✅ Task job completed: ${job.id}`);
});

taskWorker.on("failed", (job, err) => {
    console.error(`❌ Task job failed: ${job.id}`, err);
});
