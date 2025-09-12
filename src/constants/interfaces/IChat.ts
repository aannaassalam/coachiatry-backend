import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface IChat extends Document {
    _id: ObjectId;
    type: "direct" | "group";
    name?: String;
    createdBy: ObjectId;
    members: [
        {
            userId: ObjectId;
            role: "member" | "admin" | "owner";
            joinedAt: Date;
            lastReadAt: Date;
        },
    ];
    lastMessage: {
        messageId: ObjectId;
        senderId: ObjectId;
        content: string;
        type: "text" | "image" | "video" | "file" | "system";
        sentAt: Date;
    } | null;
    createdAt: Date;
    updatedAt: Date;
}
