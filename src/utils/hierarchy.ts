import mongoose from "mongoose";
import UserModel from "../model/userModel";
import { cached, cacheKeys } from "./cache";

// The ancestor chain changes only when an admin reassigns a coach, but it was
// recomputed with a $graphLookup on every task/document/transcription access
// (see utils/authorize). Cached per user and invalidated from userModel's schema
// middleware, which flushes the whole namespace on any assignedCoach write —
// reassigning a coach changes the chain for everyone BELOW them too, not just
// the edited user.
//
// The TTL is short because this gates authorization: it is the backstop for
// anything the invalidation hooks can't see (a direct mongo edit), not the
// primary mechanism.
const HIERARCHY_TTL_SEC = 300;

// Fields stripped from any populated hierarchy node before it leaves the API.
export const HIERARCHY_SELECT =
    "-password -otp -otpExpires -passwordResetToken -passwordResetExpires -__v -fcmTokens";

// Collect everyone ABOVE a user (their coach -> manager -> admin chain).
// Walks UP the `assignedCoach` graph starting from the given user. Returns an
// array of ObjectIds (ancestors only; the user themself is NOT included).
// Returns ancestor ids as STRINGS. Every caller already does `.map(String)` on
// the result, and Mongoose casts strings back to ObjectIds inside queries.
export async function getManagementTreeIds(userId: any): Promise<string[]> {
    return cached(cacheKeys.hierarchy(String(userId)), HIERARCHY_TTL_SEC, async () => {
        const result = await UserModel.aggregate([
            { $match: { _id: new mongoose.Types.ObjectId(userId) } },
            {
                $graphLookup: {
                    from: "users",
                    startWith: "$assignedCoach",
                    connectFromField: "assignedCoach",
                    connectToField: "_id",
                    as: "managementTree",
                    maxDepth: 10,
                },
            },
            { $project: { treeIds: "$managementTree._id" } },
        ]);
        return (result?.[0]?.treeIds || []).map(String) as string[];
    });
}

// Flatten a nested coach->manager->admin tree (each node populated on
// `assignedCoach`) into one deduplicated array, level by level (breadth-first),
// stripping each node's own `assignedCoach`.
export function flattenHierarchy(roots: any): any[] {
    const flat: any[] = [];
    const seen = new Set<string>();
    let level: any[] = Array.isArray(roots) ? [...roots] : [];

    while (level.length) {
        const nextLevel: any[] = [];
        for (const node of level) {
            if (!node || !node._id) continue;
            const { assignedCoach: children, ...rest } = node;
            const id = String(node._id);
            if (!seen.has(id)) {
                seen.add(id);
                flat.push(rest);
            }
            if (Array.isArray(children)) nextLevel.push(...children);
        }
        level = nextLevel;
    }
    return flat;
}

// Return the flattened coach->manager->admin hierarchy (full user docs) for a
// given user, matching the shape `getMe` returns on `assignedCoach`.
export async function getFlattenedHierarchy(userId: any): Promise<any[]> {
    const user = await UserModel.findById(userId)
        .populate({
            path: "assignedCoach", // the user's coaches
            select: HIERARCHY_SELECT,
            populate: {
                path: "assignedCoach", // each coach's managers
                select: HIERARCHY_SELECT,
                populate: {
                    path: "assignedCoach", // each manager's admin
                    select: HIERARCHY_SELECT,
                },
            },
        })
        .lean();

    if (!user) return [];
    return flattenHierarchy(user.assignedCoach);
}
