import mongoose, { Schema } from "mongoose";

import { ITranscriptionDocument } from "../constants/interfaces/ITranscription";

const transcriptionSchema = new Schema<ITranscriptionDocument>(
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
        transcriptions: [
            {
                name: {
                    type: String,
                    required: true,
                },
                profile: {
                    type: String,
                    required: true,
                },
                text: {
                    type: String,
                    required: true,
                },
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

transcriptionSchema.index({ title: 1 });

const TranscriptionModel = mongoose.model<ITranscriptionDocument>(
    "Transcription",
    transcriptionSchema
);
export default TranscriptionModel;
