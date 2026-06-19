import { Document, ObjectId } from "mongoose";

// A single finalized utterance, stored as its OWN document (one row per
// utterance) instead of an element inside Transcription.transcriptions[].
//
// Why a dedicated collection: the embedded-array model rewrote (and linearly
// scanned) an ever-growing document on every caption write, and a long
// multi-speaker meeting eventually blew past MongoDB's 16 MB per-document
// ceiling — which crashed writes mid-meeting. One doc per utterance makes each
// write an O(log n) indexed upsert, removes the size ceiling entirely, and
// lets reads paginate / fetch incrementally.
export interface ITranscriptSegment {
    // Parent transcription this utterance belongs to.
    transcription: ObjectId;
    // Denormalized owner — lets us authorize / query segments without first
    // loading the parent transcription.
    user: ObjectId;
    // Stable per-utterance id minted by the extension's caption aggregator.
    // `(transcription, seq)` is unique so a retransmit upserts in place
    // instead of inserting a duplicate.
    seq: string;
    name: string;
    profile: string;
    text: string;
    // The time the utterance was first observed (kept stable so segments sort
    // correctly even though they commit only after the speaker pauses).
    timestamp: Date;
}

export interface ITranscriptSegmentDocument
    extends ITranscriptSegment,
        Document {
    createdAt: Date;
    updatedAt: Date;
}
