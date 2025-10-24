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
        repeat: {
            type: String,
            enum: ["none", "daily", "weekly", "monthly", "yearly"],
            default: "none",
        },
        status: {
            type: String,
            enum: ["pending", "sent", "delivered", "seen", "failed"],
            default: "pending",
        },
        deletedAt: { type: Date },
    },
    {
        timestamps: true,
    }
);

messageSchema.index({ chat: 1, createdAt: -1 }); // get latest messages fast
messageSchema.index({ sender: 1, createdAt: -1 }); // filter user’s messages
messageSchema.index({ replyTo: 1 }); // for threaded replies
messageSchema.index({ scheduledAt: 1 });

const MessageModel = mongoose.model<IMessageDocument>("Message", messageSchema);
export default MessageModel;
