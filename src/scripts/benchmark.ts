// Before/after benchmark for the Redis caching work: `npm run bench:cache`.
//
// Runs each hot path in its old (uncached / unbounded) form and its new one over
// the same seeded data, against a throwaway in-memory Mongo — it never touches a
// real database.
//
// Read the RATIOS, not the absolute numbers. Mongo here is in-process and
// answers in microseconds; a real Atlas query is a network round trip costing
// milliseconds. That makes this benchmark *understate* the win for `protect` and
// the hierarchy lookup in production, where the saved call is a remote one. The
// data-volume figure is the exception: bytes are bytes, and 35x less of them off
// disk matters more over a network, not less.
import "dotenv/config";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = process.env.JWT_SECRET || "bench-secret";

import UserModel from "../model/userModel";
import TaskModel from "../model/taskModel";
import DocumentModel from "../model/documentModel";
import CategoryModel from "../model/categoryModel";
import StatusModel from "../model/statusModel";
import { protect } from "../controllers/authController";
import { buildContext } from "../ai/context";
import { getManagementTreeIds } from "../utils/hierarchy";
import { getCacheClient, closeRedis } from "../utils/redis";

const N_TASKS = 400;
const N_DOCS = 300;
const DOC_KB = 20;
const REPS = 60;

let mongod: MongoMemoryServer;

async function time(label: string, reps: number, fn: () => Promise<any>) {
    // warm-up so we don't measure JIT/connection setup
    await fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) await fn();
    const t1 = process.hrtime.bigint();
    const totalMs = Number(t1 - t0) / 1e6;
    return { label, totalMs, perOp: totalMs / reps };
}

function report(before: any, after: any, unit = "ms") {
    const speedup = before.perOp / after.perOp;
    const pct = ((1 - after.perOp / before.perOp) * 100).toFixed(1);
    console.log(`   before : ${before.perOp.toFixed(2)} ${unit}/op`);
    console.log(`   after  : ${after.perOp.toFixed(2)} ${unit}/op`);
    console.log(`   → ${speedup.toFixed(1)}x faster (${pct}% less time)\n`);
}

async function main() {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: "bench" });
    const client = getCacheClient();

    console.log("Seeding…");
    // A 4-level coach chain: user -> coach -> manager -> admin
    const admin = await UserModel.create({ fullName: "Admin", email: "a@x.com", role: "admin", verified: true });
    const manager = await UserModel.create({ fullName: "Mgr", email: "m@x.com", role: "manager", assignedCoach: [admin._id], verified: true });
    const coach = await UserModel.create({ fullName: "Coach", email: "c@x.com", role: "coach", assignedCoach: [manager._id], verified: true });
    const user = await UserModel.create({ fullName: "User", email: "u@x.com", role: "user", assignedCoach: [coach._id], verified: true, otp: "123456", fcmTokens: ["t1", "t2"] });
    const uid = user._id.toString();

    const cat = await CategoryModel.create({ title: "Work", user: user._id, color: { bg: "#fff", text: "#000" }, public: true });
    const status = await StatusModel.create({ title: "To Do", user: user._id, color: { bg: "#fff", text: "#000" } });

    await TaskModel.insertMany(
        Array.from({ length: N_TASKS }, (_, i) => ({
            title: `Task ${i}`, description: "d".repeat(200),
            user: user._id, category: cat._id, status: status._id,
        })) as any
    );
    const body = "<p>" + "x".repeat(DOC_KB * 1024) + "</p>";
    await DocumentModel.insertMany(
        Array.from({ length: N_DOCS }, (_, i) => ({
            title: `Doc ${i}`, content: body, user: user._id, tag: cat._id,
        })) as any
    );
    console.log(`Seeded: ${N_TASKS} tasks, ${N_DOCS} docs @ ${DOC_KB}KB each (~${((N_DOCS * DOC_KB) / 1024).toFixed(1)}MB of document bodies)\n`);

    const token = jwt.sign({ id: uid }, process.env.JWT_SECRET!);
    const runProtect = () =>
        new Promise<void>((resolve) => {
            const req: any = { headers: { authorization: `Bearer ${token}` } };
            protect(req, {} as any, (() => resolve()) as any);
        });

    // ── 1. protect ──────────────────────────────────────────────────────────
    console.log("1. protect — auth on EVERY authenticated request");
    const protectBefore = await time("uncached", REPS, async () => {
        await client.del(`user:${uid}`); // force a miss each time = old behavior
        await runProtect();
    });
    await runProtect(); // warm
    const protectAfter = await time("cached", REPS, runProtect);
    // subtract the DEL we added to the "before" loop so it's a fair comparison
    const delCost = await time("del-only", REPS, async () => { await client.del(`user:${uid}`); });
    protectBefore.perOp -= delCost.perOp;
    report(protectBefore, protectAfter);

    // ── 2. buildContext ─────────────────────────────────────────────────────
    console.log("2. buildContext — runs on every AI request");
    const oldBuildContext = async () => {
        const [tasksRaw, documentsRaw, categories] = await Promise.all([
            TaskModel.find({ user: uid }).populate("status category user").sort({ createdAt: -1 }).lean(),
            DocumentModel.find({ user: uid }).populate("tag user").sort({ createdAt: -1 }).lean(),
            CategoryModel.find({ $or: [{ public: true }, { user: uid }] }).lean(),
        ]);
        // the old excerpt work
        documentsRaw.map((d: any) => (typeof d.content === "string" ? d.content.substring(0, 300) : ""));
        return { tasksRaw, documentsRaw, categories };
    };
    const ctxBefore = await time("old", 12, oldBuildContext);
    await client.flushdb();
    const ctxAfter = await time("new", 12, () => buildContext({ userId: uid, page: "general" }));
    report(ctxBefore, ctxAfter);

    // How much data actually crosses the wire, which is the real story here.
    const oldRows: any = await oldBuildContext();
    const newCtx: any = await buildContext({ userId: uid, page: "general" });
    const oldBytes = Buffer.byteLength(JSON.stringify(oldRows));
    const newBytes = Buffer.byteLength(JSON.stringify(newCtx));
    console.log(`   documents read from Mongo:`);
    console.log(`   before : ${(oldBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   after  : ${(newBytes / 1024).toFixed(0)} KB`);
    console.log(`   → ${(oldBytes / newBytes).toFixed(0)}x less data off disk per AI request\n`);

    // ── 3. hierarchy ────────────────────────────────────────────────────────
    console.log("3. getManagementTreeIds — $graphLookup on every task/doc access");
    const hierBefore = await time("uncached", REPS, async () => {
        await client.del(`hierarchy:${uid}`);
        await getManagementTreeIds(uid);
    });
    await getManagementTreeIds(uid); // warm
    const hierAfter = await time("cached", REPS, () => getManagementTreeIds(uid));
    hierBefore.perOp -= delCost.perOp;
    report(hierBefore, hierAfter);

    // ── 4. Composite: what one authenticated task-open costs ────────────────
    console.log("4. Composite — one authenticated request that checks task access");
    const compBefore = await time("uncached", REPS, async () => {
        await client.del(`user:${uid}`, `hierarchy:${uid}`);
        await runProtect();
        await getManagementTreeIds(uid);
    });
    await runProtect();
    await getManagementTreeIds(uid);
    const compAfter = await time("cached", REPS, async () => {
        await runProtect();
        await getManagementTreeIds(uid);
    });
    compBefore.perOp -= delCost.perOp;
    report(compBefore, compAfter);

    await client.flushdb();
    await closeRedis();
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
        await mongod?.stop().catch(() => {});
        setTimeout(() => process.exit(process.exitCode ?? 0), 200);
    });
