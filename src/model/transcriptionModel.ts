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
        // LEGACY embedded transcript segments. As of the per-segment model
        // (TranscriptSegment collection) NEW captions are no longer pushed
        // here — this is retained only so pre-migration documents stay
        // readable via the dual-read path (loadTranscriptSegments). Once all
        // documents are migrated this can be dropped.
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
        // Number of utterances stored in the TranscriptSegment collection for
        // this transcription. Maintained incrementally on each new segment so
        // "is this transcript empty?" / the list's segment count never has to
        // load the segments themselves. > 0 also marks a doc as living in the
        // new per-segment model (vs. the legacy embedded array).
        segmentCount: {
            type: Number,
            default: 0,
        },
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
// The list query filters by user and sorts by createdAt desc — this compound
// index lets Mongo satisfy both from the index instead of sorting in memory.
transcriptionSchema.index({ user: 1, createdAt: -1 });
transcriptionSchema.index(
    { user: 1, meetingId: 1, source: 1 },
    { unique: true, partialFilterExpression: { meetingId: { $type: "string" } } }
);

const TranscriptionModel = mongoose.model<ITranscriptionDocument>(
    "Transcription",
    transcriptionSchema
);
export default TranscriptionModel;
