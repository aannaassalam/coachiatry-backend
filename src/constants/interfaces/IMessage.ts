import mongoose, { Document, Schema } from "mongoose";
import { ObjectId } from "mongoose";

export interface IMessageDocument extends Document {
    chat: ObjectId;
    sender: ObjectId;
    type: "text" | "image" | "video" | "file" | "system";
    content: String;
    files: {
        url: String;
        type: String;
        size: Number;
        thumbnailUrl: String;
        duration: Number;
    }[];
    reactions: {
        user: ObjectId;
        emoji: String;
        reactedAt: Date;
    }[];
    replyTo: ObjectId;
    scheduledAt: Date;
    jobId: string | null;
    repeat: "none" | "daily" | "weekly" | "monthly" | "yearly";
    createdAt: Date;
    updatedAt: Date;
    status: "pending" | "sent" | "delivered" | "seen" | "failed";
    deletedAt: Date;
}
