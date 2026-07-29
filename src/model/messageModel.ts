import mongoose, { Schema } from "mongoose";

import { IMessageDocument } from "../constants/interfaces/IMessage";

const messageSchema = new Schema<IMessageDocument>(
    {
        chat: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "Chat",
        },
        sender: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        type: {
            type: String,
            enum: ["text", "image", "video", "file", "system"],
            default: "text",
        },
        content: {
            type: String,
        },
        files: [
            {
                url: {
                    type: String,
                    required: true,
                },
                type: {
                    type: String,
                    required: true,
                },
                size: {
                    type: Number,
                    required: true,
                },
                thumbnailUrl: {
                    type: String,
                },
                duration: {
                    type: Number,
                },
            },
        ],
        reactions: [
            {
                user: {
                    type: mongoose.Types.ObjectId,
                    required: true,
                    ref: "User",
                },
                emoji: {
                    type: String,
                    required: true,
                },
                reactedAt: {
                    type: Date,
                    required: true,
                },
            },
        ],
        replyTo: {
            type: mongoose.Types.ObjectId,
            ref: "Message",
            default: null,
        },
        scheduledAt: { type: Date },
        // BullMQ job id of the pending "send" job, so an edit can find and
        // remove the exact queued job before re-scheduling.
        jobId: { type: String, default: null },
        repeat: {
            type: String,
            enum: ["none", "once", "daily", "weekly", "monthly", "yearly"],
            default: "none",
        },
        status: {
            type: String,
            enum: ["pending", "sent", "delivered", "seen", "failed"],
            default: "pending",
        },
        deletedAt: { type: Date },
        // Declared explicitly instead of being left to `timestamps: true`,
        // which adds it as an IMMUTABLE path — that silently discarded the
        // message worker's restamp when a scheduled message fires. Mongoose
        // still fills this in on insert; it is only now writable afterwards.
        createdAt: { type: Date, immutable: false },
    },
    {
        timestamps: true,
    }
);

messageSchema.index({ chat: 1, createdAt: -1 }); // get latest messages fast
messageSchema.index({ sender: 1, createdAt: -1 }); // filter user’s messages
messageSchema.index({ replyTo: 1 }); // for threaded replies
messageSchema.index({ scheduledAt: 1 });
// Unread-count aggregation: messages in a chat from other senders after a time
messageSchema.index({ chat: 1, sender: 1, createdAt: -1 });
// Chat message list filters on { chat, scheduledAt: null } sorted by createdAt
messageSchema.index({ chat: 1, scheduledAt: 1, createdAt: -1 });
// Scheduled-message lists filter on { sender, scheduledAt: { $ne: null } }
messageSchema.index({ sender: 1, scheduledAt: 1 });

const MessageModel = mongoose.model<IMessageDocument>("Message", messageSchema);
export default MessageModel;
