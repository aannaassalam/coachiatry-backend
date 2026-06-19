import mongoose, { Schema } from "mongoose";

import { ITranscriptSegmentDocument } from "../constants/interfaces/ITranscriptSegment";

const transcriptSegmentSchema = new Schema<ITranscriptSegmentDocument>(
    {
        transcription: {
            type: mongoose.Types.ObjectId,
            ref: "Transcription",
            required: true,
            index: true,
        },
        user: {
            type: mongoose.Types.ObjectId,
            ref: "User",
            required: true,
        },
        seq: {
            type: String,
            required: true,
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
    {
        timestamps: true,
    }
);

// The dedupe/upsert key: a caption retransmit for the same utterance updates
// the existing segment in place rather than inserting a duplicate.
transcriptSegmentSchema.index(
    { transcription: 1, seq: 1 },
    { unique: true }
);

// Reads stream segments in insertion order. _id is monotonic, so paginated /
// incremental ("everything after cursor X") fetches sort on it directly.
transcriptSegmentSchema.index({ transcription: 1, _id: 1 });

const TranscriptSegmentModel = mongoose.model<ITranscriptSegmentDocument>(
    "TranscriptSegment",
    transcriptSegmentSchema
);

export default TranscriptSegmentModel;
