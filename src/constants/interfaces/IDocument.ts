import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface IDocument extends Document {
    title: string;
    user: ObjectId;
    tag: ObjectId;
    content: string;
    shareId?: string;
    sharedWith: string[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
