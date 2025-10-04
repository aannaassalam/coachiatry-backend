import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface IStatus extends Document {
    title: string;
    user: ObjectId;
    public: boolean;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
