import { Document, ObjectId } from "mongoose";

export interface ITranscription {
    // Stable per-row identifier from the extension content script. Used by
    // the caption socket handler to upsert in place as a row's text grows,
    // instead of pushing a new segment every time.
    seq?: string;
    name: string;
    profile: string;
    text: string;
    timestamp: Date;
}

export type TranscriptionSource = "extension" | "manual";

export interface ITranscriptionDocument extends Document {
    title: string;
    user: ObjectId;
    transcriptions: ITranscription[];
    active: boolean;
    // Populated when the document was created from the browser extension
    // capturing a live Google Meet session.
    meetingId?: string;
    startedAt?: Date;
    endedAt?: Date;
    source?: TranscriptionSource;
    createdAt: Date;
    updatedAt: Date;
}
