import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface ICategory extends Document {
    title: string;
    user: ObjectId;
    color: {
        bg: string;
        text: string;
    };
    public: boolean;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
