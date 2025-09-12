import mongoose, { Schema } from "mongoose";

import { IDocument } from "../constants/interfaces/IDocument";

const documentSchema = new Schema<IDocument>(
    {
        title: {
            type: String,
            required: [true, "Please enter transcription title!"],
        },
        user: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        tag: {
            type: String,
            default: null,
        },
        content: {
            type: String,
            required: [true, "Please provide content for document!"],
        },
        active: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

documentSchema.index({ title: 1 });

const DocumentModel = mongoose.model<IDocument>("Document", documentSchema);
export default DocumentModel;
