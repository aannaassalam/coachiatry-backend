import "dotenv/config";

import mongoose from "mongoose";

import connectDb from "../config/db.config";
import TranscriptionModel from "../model/transcriptionModel";
import TranscriptSegmentModel from "../model/transcriptSegmentModel";

// One-time migration: copy every legacy embedded-array segment
// (Transcription.transcriptions[]) into the dedicated TranscriptSegment
// collection, and stamp segmentCount on the parent.
//
//   npx ts-node src/scripts/migrateTranscriptSegments.ts
//   (or, after build:  node build/scripts/migrateTranscriptSegments.js)
//
// Safe to re-run: each segment is upserted on the unique {transcription, seq}
// key, and a transcript that already has segmentCount > 0 is skipped. The
// legacy array is left in place so reads keep working throughout — the
// dual-read path simply prefers the new collection once it's populated.

async function run() {
    await connectDb();

    // Only docs that still carry embedded segments and haven't been migrated.
    const cursor = TranscriptionModel.find({
        "transcriptions.0": { $exists: true },
        $or: [
            { segmentCount: { $exists: false } },
            { segmentCount: { $lte: 0 } },
        ],
    })
        .select("_id user transcriptions")
        .lean()
        .cursor();

    let docsMigrated = 0;
    let segmentsMigrated = 0;

    for (
        let doc = await cursor.next();
        doc != null;
        doc = await cursor.next()
    ) {
        const segments = doc.transcriptions ?? [];
        if (segments.length === 0) continue;

        const ops = segments.map((seg: any, idx: number) => {
            // Legacy rows may predate stable seqs — synthesize a deterministic
            // one from the index so re-runs stay idempotent.
            const seq =
                seg.seq && String(seg.seq) !== ""
                    ? String(seg.seq)
                    : `legacy-${idx}`;
            return {
                updateOne: {
                    filter: { transcription: doc._id, seq },
                    update: {
                        $set: {
                            name: seg.name ?? "Unknown",
                            text: seg.text ?? "",
                            timestamp: seg.timestamp ?? new Date(),
                        },
                        $setOnInsert: {
                            transcription: doc._id,
                            user: doc.user,
                            seq,
                            profile: seg.profile ?? "",
                        },
                    },
                    upsert: true,
                },
            };
        });

        if (ops.length > 0) {
            await TranscriptSegmentModel.bulkWrite(ops, { ordered: false });
        }

        const count = await TranscriptSegmentModel.countDocuments({
            transcription: doc._id,
        });
        await TranscriptionModel.updateOne(
            { _id: doc._id },
            { $set: { segmentCount: count } }
        );

        docsMigrated += 1;
        segmentsMigrated += ops.length;
        if (docsMigrated % 50 === 0) {
            console.log(
                `… ${docsMigrated} transcripts, ${segmentsMigrated} segments so far`
            );
        }
    }

    console.log(
        `Migration complete: ${docsMigrated} transcripts, ${segmentsMigrated} segments.`
    );
    await mongoose.disconnect();
    process.exit(0);
}

run().catch(async (err) => {
    console.error("Migration failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
