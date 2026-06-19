import "dotenv/config";

import mongoose from "mongoose";

import connectDb from "../config/db.config";
import TranscriptionModel from "../model/transcriptionModel";
import TranscriptSegmentModel from "../model/transcriptSegmentModel";

// Follow-up to migrateTranscriptSegments: once segments live in the
// TranscriptSegment collection, the legacy embedded `transcriptions` array is
// dead weight — but it makes every document huge, so the server still reads
// those big docs off disk just to render the list (a projection only saves
// network, not the disk read). This script $unsets the array, shrinking each
// document so list/detail metadata reads are fast.
//
//   npx ts-node src/scripts/cleanupLegacyArrays.ts
//   (or, after build:  node build/scripts/cleanupLegacyArrays.js)
//
// SAFETY: a doc's array is cleared ONLY when the per-segment collection holds
// at least as many segments as the array — i.e. it's provably migrated. Any
// doc that isn't fully migrated is skipped and logged, never touched. Safe to
// re-run.

async function run() {
    await connectDb();

    const cursor = TranscriptionModel.find({
        "transcriptions.0": { $exists: true },
    })
        .select("_id transcriptions")
        .lean()
        .cursor();

    let cleared = 0;
    let skipped = 0;

    for (
        let doc = await cursor.next();
        doc != null;
        doc = await cursor.next()
    ) {
        const arrayLen = doc.transcriptions?.length ?? 0;
        const migratedCount = await TranscriptSegmentModel.countDocuments({
            transcription: doc._id,
        });

        if (migratedCount >= arrayLen && arrayLen > 0) {
            await TranscriptionModel.updateOne(
                { _id: doc._id },
                {
                    $unset: { transcriptions: "" },
                    $set: { segmentCount: migratedCount },
                }
            );
            cleared += 1;
        } else {
            // Not (fully) migrated — leave it intact and report it.
            skipped += 1;
            console.warn(
                `[cleanup] SKIP ${doc._id}: array=${arrayLen} migrated=${migratedCount} (run migrate:segments first)`
            );
        }

        if ((cleared + skipped) % 50 === 0) {
            console.log(`… processed ${cleared + skipped} (cleared ${cleared})`);
        }
    }

    console.log(
        `Cleanup complete: cleared ${cleared} document(s), skipped ${skipped}.`
    );
    await mongoose.disconnect();
    process.exit(0);
}

run().catch(async (err) => {
    console.error("Cleanup failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
