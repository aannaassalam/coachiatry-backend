import "dotenv/config";

import mongoose from "mongoose";

import connectDb from "../config/db.config";
import TranscriptionModel from "../model/transcriptionModel";
import TranscriptSegmentModel from "../model/transcriptSegmentModel";

// READ-ONLY diagnostic. Reports the storage state of every transcript so we
// can see exactly what's migrated, what still has a legacy array, and what
// would be VISIBLE under the current list filter — without changing anything.
//
//   npx ts-node src/scripts/auditSegments.ts
//
// Pass a meetingId to inspect a single meeting:
//   npx ts-node src/scripts/auditSegments.ts wxm-xhkt-pch

async function run() {
    await connectDb();

    const meetingId = process.argv[2];
    const baseFilter = meetingId ? { meetingId } : {};

    const docs = await TranscriptionModel.find(baseFilter)
        .select("_id title source meetingId segmentCount transcriptions user")
        .lean();

    let extension = 0;
    let withArray = 0;
    let withSegmentCount = 0;
    let withCollectionRows = 0;
    let visibleUnderFilter = 0;
    const hidden: any[] = [];

    for (const d of docs) {
        const isExt = d.source === "extension";
        const arrayLen = (d as any).transcriptions?.length ?? 0;
        const segCount = d.segmentCount ?? 0;
        const collRows = await TranscriptSegmentModel.countDocuments({
            transcription: d._id,
        });

        if (isExt) extension += 1;
        if (arrayLen > 0) withArray += 1;
        if (segCount > 0) withSegmentCount += 1;
        if (collRows > 0) withCollectionRows += 1;

        // Mirror the list filter: manual, OR segmentCount>0, OR has array.
        const visible =
            !isExt || segCount > 0 || arrayLen > 0;
        if (visible) visibleUnderFilter += 1;
        else
            hidden.push({
                _id: String(d._id),
                title: d.title,
                meetingId: d.meetingId,
                segmentCount: segCount,
                arrayLen,
                collectionRows: collRows,
            });

        if (meetingId) {
            console.log({
                _id: String(d._id),
                title: d.title,
                source: d.source,
                segmentCount: segCount,
                arrayLen,
                collectionRows: collRows,
                user: String(d.user),
                wouldBeVisible: visible,
            });
        }
    }

    console.log("──────── audit summary ────────");
    console.log("total transcripts:        ", docs.length);
    console.log("  extension:              ", extension);
    console.log("  with legacy array:      ", withArray);
    console.log("  with segmentCount > 0:  ", withSegmentCount);
    console.log("  with rows in collection:", withCollectionRows);
    console.log("visible under list filter:", visibleUnderFilter);
    console.log("hidden under list filter: ", hidden.length);
    if (hidden.length) console.log("hidden docs:", hidden.slice(0, 20));

    await mongoose.disconnect();
    process.exit(0);
}

run().catch(async (err) => {
    console.error("Audit failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
