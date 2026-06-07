import mongoose from "mongoose";
import UserModel from "../model/userModel";

// Fields stripped from any populated hierarchy node before it leaves the API.
export const HIERARCHY_SELECT =
    "-password -otp -otpExpires -passwordResetToken -passwordResetExpires -__v -fcmTokens";

// Collect everyone ABOVE a user (their coach -> manager -> admin chain).
// Walks UP the `assignedCoach` graph starting from the given user. Returns an
// array of ObjectIds (ancestors only; the user themself is NOT included).
export async function getManagementTreeIds(userId: any) {
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
    return result?.[0]?.treeIds || [];
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
