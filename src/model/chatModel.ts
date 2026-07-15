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
        // Sort key for the conversation list: the time of the newest real
        // message, falling back to the chat's own creation time so it is ALWAYS
        // set. The list used to sort on a computed
        // `$ifNull(lastMessage.createdAt, createdAt)`, which no index can serve,
        // forcing a blocking in-memory sort across every one of the user's chats
        // on every load. A always-present stored field can be indexed, which
        // also lets the page be cut before the expensive per-chat lookups run.
        //
        // Maintained by touchChatLastMessage() — every writer must go through
        // it (see utils/chatActivity).
        lastMessageAt: {
            type: Date,
            default: Date.now,
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
chatSchema.index({ "members.user": 1, type: 1 });
// Serves the conversation list: match this user's chats, then walk them already
// ordered — no in-memory sort, and the page can be sliced before any $lookup.
chatSchema.index({ "members.user": 1, lastMessageAt: -1 });

const ChatModel = mongoose.model<IChatDocument>("Chat", chatSchema);
export default ChatModel;
