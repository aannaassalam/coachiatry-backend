import { Worker } from "bullmq";
import socket from "../../config/socket.config"; // assuming you export io from your socket setup
import MessageModel from "../../model/messageModel";
import { messageQueue } from "../queues/messageQueue";
import { redisConnection } from "../redis";
import { sendMessageNotification } from "../messagingNotifications";
import { touchChatLastMessage } from "../chatActivity";

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

            // Schedule the next occurrence and remember its job id so an edit
            // can find and replace it.
            const delay = Math.max(0, next.getTime() - Date.now());
            const nextJob = await messageQueue.add(
                "sendMessage",
                { messageId },
                { delay, attempts: 3 },
            );

            template.scheduledAt = next;
            template.jobId = nextJob.id;
            await template.save();
        } else {
            // Mark one-time schedule as done
            template.status = "sent";
            template.scheduledAt = null;
            template.jobId = null;
            await template.save();

            sentMessage = template;
        }
        // The scheduled message has now actually been sent, so it becomes the
        // chat's latest activity. Without this the conversation list would show
        // (and order by) the previous message, and a chat whose only traffic is
        // scheduled would never move — this worker never touched the chat
        // document before.
        await touchChatLastMessage({
            _id: sentMessage._id,
            chat: sentMessage.chat,
            sender: sentMessage.sender,
            content: sentMessage.content,
            type: sentMessage.type,
            status: sentMessage.status,
            createdAt: sentMessage.createdAt,
        });

        sendMessageNotification({
            chatId: template.chat.toString(),
            senderId: template.sender.toString(),
            message: template,
        }).catch((err) =>
            console.error("[push] scheduled notification failed:", err),
        );
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
