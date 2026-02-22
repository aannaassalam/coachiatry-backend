import { Worker } from "bullmq";
import socket from "../../config/socket.config"; // assuming you export io from your socket setup
import MessageModel from "../../model/messageModel";
import { messageQueue } from "../queues/messageQueue";
import { redisConnection } from "../redis";
import { sendMessageNotification } from "../messagingNotifications";

function getNextOccurrence(current: Date, repeat: string): Date {
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

export const messageWorker = new Worker(
    "message-queue",
    async (job) => {
        const { messageId } = job.data;
        const io = socket.getIO();
        const template = await MessageModel.findById(messageId);
        if (!template) return;

        // Create a new "sent" message
        let sentMessage;

        // Handle repeating schedules
        if (template.repeat && template.repeat !== "none") {
            sentMessage = await MessageModel.create({
                chat: template.chat,
                sender: template.sender,
                content: template.content,
                files: template.files,
                type: template.type,
                replyTo: template.replyTo,
                createdAt: template.scheduledAt, // 🕓 use the scheduled time
                status: "sent",
            });

            const next = getNextOccurrence(
                template.scheduledAt,
                template.repeat,
            );

            // Update the original schedule
            template.scheduledAt = next;
            await template.save();

            // Schedule next job
            const delay = next.getTime() - Date.now();
            await messageQueue.add("sendMessage", { messageId }, { delay });
        } else {
            // Mark one-time schedule as done
            template.status = "sent";
            template.scheduledAt = null;
            await template.save();

            sentMessage = template;
        }
        sendMessageNotification({
            chatId: template.chat.toString(),
            senderId: template.sender.toString(),
            message: template,
        });
        io?.to(String(template.chat)).emit("new_message", sentMessage);
    },
    { connection: redisConnection },
);

messageWorker.on("completed", (job) => {
    console.log(`✅ Message job completed: ${job.id}`);
});

messageWorker.on("failed", (job, err) => {
    console.error(`❌ Message job failed: ${job.id}`, err);
});
