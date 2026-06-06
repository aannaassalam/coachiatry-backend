import mongoose, { Schema, Document, ObjectId } from "mongoose";
import { v4 as uuidv4 } from "uuid";

export interface IGroupInvite extends Document {
    chat: ObjectId;
    email: string;
    token: string;
    invitedBy: ObjectId;
    // Set once the invite has been consumed so a link can't be reused.
    acceptedBy?: ObjectId | null;
    acceptedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const groupInviteSchema = new Schema<IGroupInvite>(
    {
        chat: {
            type: mongoose.Types.ObjectId,
            ref: "Chat",
            required: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        token: {
            type: String,
            required: true,
            unique: true,
            default: uuidv4,
        },
        invitedBy: {
            type: mongoose.Types.ObjectId,
            ref: "User",
            required: true,
        },
        acceptedBy: {
            type: mongoose.Types.ObjectId,
            ref: "User",
            default: null,
        },
        acceptedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

// One open invite per (chat, email). Re-inviting reuses/refreshes the same row.
groupInviteSchema.index({ chat: 1, email: 1 }, { unique: true });
groupInviteSchema.index({ email: 1, acceptedBy: 1 });

const GroupInviteModel = mongoose.model<IGroupInvite>(
    "GroupInvite",
    groupInviteSchema
);
export default GroupInviteModel;
