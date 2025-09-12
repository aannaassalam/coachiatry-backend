import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface IDocument extends Document {
    title: string;
    user: ObjectId;
    tag?: string;
    content: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
