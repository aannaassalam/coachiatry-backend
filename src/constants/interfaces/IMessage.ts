import mongoose, { Document, Schema } from "mongoose";
import { ObjectId } from "mongoose";

export interface IMessage extends Document {
    _id: ObjectId;
    chatId: ObjectId;
    senderId: ObjectId;
    type: "text" | "image" | "video" | "file" | "system";
    content: String;
    files: [
        {
            url: String;
            type: String;
            size: Number;
            thumbnailUrl: String;
            duration: Number;
        },
    ];
    reactions: [
        {
            userId: ObjectId;
            emoji: String;
            reactedAt: Date;
        },
    ];
    replyTo: ObjectId;
    scheduledAt: Date;
    sentAt: Date;
    status: "pending" | "sent" | "delivered" | "seen" | "failed";
    deletedAt: Date;
}
