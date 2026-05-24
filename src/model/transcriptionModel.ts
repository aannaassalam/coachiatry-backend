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
                seq: {
                    type: String,
                    index: true,
                },
                name: {
                    type: String,
                    default: "Unknown",
                },
                profile: {
                    type: String,
                    default: "",
                },
                text: {
                    type: String,
                    required: true,
                },
                timestamp: {
                    type: Date,
                    required: true,
                },
            },
        ],
        active: {
            type: Boolean,
            default: true,
        },
        // Set when the transcription was captured by the browser extension
        // from a live Google Meet. `meetingId` is the Meet code (e.g.
        // "abc-defg-hij"). `(user, meetingId, source)` is unique so the
        // extension's first caption can upsert if "meeting/start" was missed.
        meetingId: {
            type: String,
        },
        startedAt: {
            type: Date,
        },
        endedAt: {
            type: Date,
        },
        source: {
            type: String,
            enum: ["extension", "manual"],
            default: "manual",
        },
    },
    {
        timestamps: true,
    }
);

transcriptionSchema.index({ title: 1 });
transcriptionSchema.index({ user: 1 });
transcriptionSchema.index(
    { user: 1, meetingId: 1, source: 1 },
    { unique: true, partialFilterExpression: { meetingId: { $type: "string" } } }
);

const TranscriptionModel = mongoose.model<ITranscriptionDocument>(
    "Transcription",
    transcriptionSchema
);
export default TranscriptionModel;
