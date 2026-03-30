/**
 * Migration script: Creates direct chatrooms between all admins and all other users.
 *
 * Usage:
 *   npx ts-node-dev src/scripts/create-admin-chatrooms.ts
 *
 * Requires MONGODB_URI in .env
 * Safe to run multiple times — skips existing chats.
 */

import "dotenv/config";
import mongoose from "mongoose";
import UserModel from "../model/userModel";
import ChatModel from "../model/chatModel";

async function run() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("MONGODB_URI is not defined in .env");
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log("Connected to MongoDB");

    const admins = await UserModel.find({ role: "admin", active: true });
    const allUsers = await UserModel.find({ active: true });

    console.log(
        `Found ${admins.length} admin(s) and ${allUsers.length} total user(s)`,
    );

    let created = 0;
    let skipped = 0;

    for (const admin of admins) {
        for (const user of allUsers) {
            // Skip self
            if (admin._id.toString() === user._id.toString()) continue;
            // Check if a direct chat already exists between these two
            const existing = await ChatModel.findOne({
                type: "direct",
                "members.user": { $all: [admin._id, user._id] },
                $expr: { $eq: [{ $size: "$members" }, 2] },
            });

            if (existing) {
                skipped++;
                continue;
            }

            await ChatModel.create({
                type: "direct",
                createdBy: admin._id,
                members: [
                    { user: admin._id, role: "member" },
                    { user: user._id, role: "member" },
                ],
                isDeletable: true,
            });

            console.log(
                `Created chat: ${admin.fullName} (admin) ↔ ${user.fullName} (${user.role})`,
            );
            created++;
        }
    }

    console.log(`\nDone! Created: ${created}, Skipped (already exists): ${skipped}`);
    await mongoose.disconnect();
    process.exit(0);
}

run().catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
});
