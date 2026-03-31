import mongoose, { Schema } from "mongoose";
import { v4 as uuidv4 } from "uuid";

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
            type: mongoose.Types.ObjectId,
            ref: "Category",
        },
        content: {
            type: String,
            required: [true, "Please provide content for document!"],
        },
        shareId: {
            type: String,
            default: uuidv4,
        },
        sharedWith: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],
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
documentSchema.index({ user: 1 });
documentSchema.index({ shareId: 1 });

const DocumentModel = mongoose.model<IDocument>("Document", documentSchema);
export default DocumentModel;
