import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface IChatDocument extends Document {
    type: "direct" | "group";
    name?: String;
    groupPhoto?: String;
    createdBy: ObjectId;
    members: [
        {
            user: ObjectId;
            role: "member" | "admin" | "owner";
            joinedAt: Date;
            lastReadAt: Date;
        },
    ];
    lastMessage: {
        message: ObjectId;
        sender: ObjectId;
        content: string;
        type: "text" | "image" | "video" | "file" | "system";
        sentAt: Date;
        status: "pending" | "sent" | "delivered" | "seen" | "failed";
    } | null;
    /** Newest real message's time, defaulting to the chat's creation time. */
    lastMessageAt: Date;
    isDeletable?: Boolean;
    createdAt: Date;
    updatedAt: Date;
}
