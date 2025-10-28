import mongoose, { Schema } from "mongoose";

import { IChatDocument } from "../constants/interfaces/IChat";

const chatSchema = new Schema<IChatDocument>(
    {
        type: {
            type: String,
            enum: ["direct", "group"],
            default: "direct",
        },
        name: {
            type: String,
        },
        groupPhoto: {
            type: String,
        },
        createdBy: {
            type: mongoose.Types.ObjectId,
            ref: "User",
            required: [true, "Created by is required"],
        },
        members: [
            {
                user: {
                    type: mongoose.Types.ObjectId,
                    required: true,
                    ref: "User",
                },
                role: {
                    type: String,
                    enum: ["member", "admin", "owner"],
                    default: "member",
                },
                joinedAt: {
                    type: Date,
                    default: Date.now,
                },
                lastReadAt: {
                    type: Date,
                    default: Date.now,
                },
            },
        ],
        lastMessage: {
            message: { type: mongoose.Types.ObjectId },
            sender: { type: mongoose.Types.ObjectId, ref: "User" },
            content: { type: String },
            type: {
                type: String,
                enum: ["text", "image", "video", "file", "system"],
                default: null,
            },
            status: {
                type: String,
                enum: ["pending", "sent", "delivered", "seen", "failed"],
                default: "pending",
            },
            sentAt: { type: Date },
        },
        isDeletable: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

chatSchema.index({ type: 1 });
chatSchema.index({ "members.user": 1 });

const ChatModel = mongoose.model<IChatDocument>("Chat", chatSchema);
export default ChatModel;
