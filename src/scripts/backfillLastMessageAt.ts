import "dotenv/config";
import mongoose from "mongoose";

import ChatModel from "../model/chatModel";
import MessageModel from "../model/messageModel";

// Backfill `chat.lastMessageAt` — run ONCE before deploying the conversation
// list that sorts on it.
//
// The field is the list's sort key. Existing chats don't have it, and the
// schema default only applies to newly created documents — so without this every
// pre-existing chat would sort as `null` and the list order would be wrong (in
// Mongo, missing sorts alongside null rather than being skipped).
//
// Sets it to the newest real message's createdAt, matching what the list's
// $lookup picks, and falls back to the chat's own createdAt for empty chats.
//
// Idempotent: re-running only recomputes. Safe to run against a live database —
// it writes one chat at a time and never touches messages.
//
//   npx ts-node src/scripts/backfillLastMessageAt.ts          # dry run
//   npx ts-node src/scripts/backfillLastMessageAt.ts --write   # apply

const WRITE = process.argv.includes("--write");
const BATCH = 500;

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(
        `Connected. Mode: ${WRITE ? "WRITE" : "DRY RUN (pass --write to apply)"}\n`
    );

    const total = await ChatModel.countDocuments({});
    console.log(`Chats to process: ${total}`);

    let processed = 0;
    let updated = 0;
    let empty = 0;

    const cursor = ChatModel.find({}, { _id: 1, createdAt: 1, lastMessageAt: 1 })
        .lean()
        .cursor();

    const ops: any[] = [];
    const flush = async () => {
        if (!ops.length) return;
        if (WRITE) await ChatModel.bulkWrite(ops, { ordered: false });
        ops.length = 0;
    };

    for await (const chat of cursor as any) {
        processed++;

        // The newest message that has actually been sent. `scheduledAt: null`
        // matches the list's own filter — a message still queued for later must
        // not count as the chat's latest activity.
        const [newest] = await MessageModel.find(
            { chat: chat._id, scheduledAt: null },
            { createdAt: 1 }
        )
            .sort({ createdAt: -1 })
            .limit(1)
            .lean();

        const value: Date = newest?.createdAt ?? chat.createdAt;
        if (!newest) empty++;

        const current = chat.lastMessageAt
            ? new Date(chat.lastMessageAt).getTime()
            : null;
        if (current === value.getTime()) continue;

        updated++;
        ops.push({
            updateOne: {
                filter: { _id: chat._id },
                update: { $set: { lastMessageAt: value } },
            },
        });
        if (ops.length >= BATCH) await flush();

        if (processed % 1000 === 0) {
            console.log(`  ${processed}/${total} scanned, ${updated} to update`);
        }
    }
    await flush();

    console.log(
        `\nDone. Scanned ${processed}, ${updated} ${WRITE ? "updated" : "would be updated"}, ` +
            `${empty} chats have no messages (fell back to chat.createdAt).`
    );
    if (!WRITE) console.log("Dry run — nothing was written. Re-run with --write.");

    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error("Backfill failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
