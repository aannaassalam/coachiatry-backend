/**
 * Run: npx ts-node --transpile-only src/model/messageModel.test.ts
 * No DB needed — this only exercises schema behaviour on an in-memory document.
 */
import assert from "assert";
import MessageModel from "./messageModel";

// A scheduled message is stamped with its SEND time when the worker fires it
// (see utils/workers/messageWorker.ts). `timestamps: true` would add createdAt
// as an immutable path, which silently discards that write on an already-saved
// document — the message would keep the time the schedule was created and sort
// into the chat history in the past.
const scheduledAt = new Date("2030-01-01T18:00:00.000Z");

const doc = new MessageModel({
    chat: "507f1f77bcf86cd799439011",
    sender: "507f1f77bcf86cd799439012",
    content: "hi",
    scheduledAt,
});
// Immutability only bites once the document is no longer new.
doc.isNew = false;
doc.createdAt = scheduledAt;

assert.strictEqual(
    doc.createdAt?.toISOString(),
    scheduledAt.toISOString(),
    "createdAt must stay writable so a fired schedule can be restamped",
);

console.log("ok: createdAt is writable after insert");
