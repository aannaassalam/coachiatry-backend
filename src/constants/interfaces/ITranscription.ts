import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface ITranscription {
    name: string;
    profile: string;
    text: string;
    timestamp: Date;
}

export interface ITranscriptionDocument extends Document {
    title: string;
    user: ObjectId;
    transcriptions: ITranscription[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
