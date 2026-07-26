import { Request, Response, NextFunction } from "express";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import MessageModel from "../model/messageModel";
import { sendResponse } from "../utils/response";
import { PipelineStage, Types } from "mongoose";
import { messageQueue } from "../utils/queues/messageQueue";
import { isChatMember } from "../utils/authorize";

export const getMessages = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const room = req.params?.roomId;

        if (!room) {
            return next(new AppError("No Room provided", 401));
        }

        // NOTE: membership is enforced by route middleware
        // (`authorizeChatMembership`) on the user-facing route. Coach/admin/
        // manager routes are role-gated instead, so they can legitimately read
        // a client's room without being a member. Mirrors the chat router.

        // Clamp pagination: floor page/limit at 1, cap limit so a request like
        // ?limit=1000000 can't pull everything into memory, and a non-numeric
        // value can't produce a NaN skip (→ 500).
        const page = Math.max(
            1,
            parseInt((req.query.page as string) || "1", 10) || 1,
        );
        const limit = Math.min(
            100,
            Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20),
        );
        const skip = (page - 1) * limit;

        // pipeline
        const pipeline: PipelineStage[] = [
            // Only chats where this user is a member
            {
                $match: {
                    chat: Types.ObjectId.createFromHexString(room),
                    scheduledAt: null,
                },
            },

            {
                $lookup: {
                    from: "users",
                    localField: "sender",
                    foreignField: "_id",
                    as: "sender",
                },
            },
            {
                $unwind: {
                    path: "$sender",
                    preserveNullAndEmptyArrays: true,
                },
            },

            {
                $lookup: {
                    from: "messages",
                    localField: "replyTo",
                    foreignField: "_id",
                    as: "replyTo",
                },
            },
            {
                $unwind: {
                    path: "$replyTo",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $lookup: {
                    from: "users",
                    localField: "replyTo.sender",
                    foreignField: "_id",
                    as: "replyTo.sender",
                },
            },
            {
                $unwind: {
                    path: "$replyTo.sender",
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Sort by updatedAt / lastMessage
            {
                $sort: { createdAt: -1 },
            },

            // Pagination
            { $skip: skip },
            { $limit: limit },
        ];

        const messages = await MessageModel.aggregate(pipeline);

        const total = await MessageModel.countDocuments({
            chat: room,
            scheduledAt: null,
        });

        const totalPages = Math.ceil(total / limit);

        return sendResponse(res, 200, "Messages retrieved successfully", {
            data: messages,
            meta: {
                results: messages.length,
                limit,
                currentPage: page,
                totalPages,
                totalCount: total,
            },
        });
    }
);

// Remove any previously-queued send job for this message, then enqueue a fresh
// one for its current scheduledAt. The client sends an absolute UTC timestamp,
// so the delay is plain epoch math — independent of the server's timezone.
// We persist the BullMQ job id so a later edit can find and replace this exact
// job instead of leaving a stale one to fire at the old time.
async function rescheduleSend(msg: any) {
    if (msg.jobId) {
        try {
            const existing = await messageQueue.getJob(msg.jobId);
            if (existing) await existing.remove();
        } catch (err) {
            console.error(`Failed to remove old job ${msg.jobId}:`, err);
        }
    }

    const delay = Math.max(0, new Date(msg.scheduledAt).getTime() - Date.now());

    const job = await messageQueue.add(
        "sendMessage",
        { messageId: msg._id },
        { delay, attempts: 3 },
    );

    msg.jobId = job.id;
    await msg.save();
}

export const scheduleMessage = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const { message, scheduledAt, frequency, chatId } = req.body;

        if (!scheduledAt || isNaN(new Date(scheduledAt).getTime())) {
            return next(new AppError("A valid scheduledAt is required", 400));
        }
        // Guard against past/now times, which would otherwise resolve to a
        // zero delay and send the message immediately.
        if (new Date(scheduledAt).getTime() <= Date.now()) {
            return next(
                new AppError("Scheduled time must be in the future", 400),
            );
        }

        if (!(await isChatMember(chatId, userId))) {
            return next(
                new AppError("You are not a member of this chat", 403),
            );
        }

        const msg = await MessageModel.create({
            sender: userId,
            chat: chatId,
            content: message,
            scheduledAt: new Date(scheduledAt),
            repeat: frequency || "none",
        });

        await rescheduleSend(msg);

        sendResponse(res, 200, "Message scheduled successfully", msg);
    }
);

export const editScheduleMessage = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const messageId = req.params?.messageId;
        const { message, scheduledAt, frequency } = req.body;

        if (!scheduledAt || isNaN(new Date(scheduledAt).getTime())) {
            return next(new AppError("A valid scheduledAt is required", 400));
        }
        if (new Date(scheduledAt).getTime() <= Date.now()) {
            return next(
                new AppError("Scheduled time must be in the future", 400),
            );
        }

        // Only the user who scheduled the message may edit it.
        const existing = await MessageModel.findById(messageId);
        if (!existing) {
            return next(new AppError("Scheduled message not found", 404));
        }
        if (existing.sender.toString() !== req.user._id.toString()) {
            return next(
                new AppError("You are not allowed to edit this message", 403),
            );
        }
        // Only genuine scheduled drafts are editable. Without this, passing an
        // already-delivered message's id would stamp scheduledAt on it and
        // queue it to be sent again.
        if (!existing.scheduledAt) {
            return next(
                new AppError("This message is not scheduled", 400),
            );
        }

        const msg = await MessageModel.findByIdAndUpdate(
            messageId,
            {
                content: message,
                scheduledAt: new Date(scheduledAt),
                repeat: frequency || "none",
            },
            { new: true },
        );

        if (!msg) {
            return next(new AppError("Scheduled message not found", 404));
        }

        await rescheduleSend(msg);

        sendResponse(res, 200, "Message edited successfully", msg);
    }
);

export const deleteScheduleMessage = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const messageId = req.params?.messageId;

        const existing = await MessageModel.findById(messageId);
        if (!existing) {
            return next(new AppError("Scheduled message not found", 404));
        }
        if (existing.sender.toString() !== req.user._id.toString()) {
            return next(
                new AppError("You are not allowed to delete this message", 403),
            );
        }
        // Guard against deleting an already-delivered message via this route.
        if (!existing.scheduledAt) {
            return next(new AppError("This message is not scheduled", 400));
        }

        // Cancel the queued send so it never fires.
        if (existing.jobId) {
            try {
                const job = await messageQueue.getJob(existing.jobId);
                if (job) await job.remove();
            } catch (err) {
                console.error(
                    `Failed to remove job ${existing.jobId}:`,
                    err,
                );
            }
        }

        await MessageModel.findByIdAndDelete(messageId);

        sendResponse(res, 200, "Scheduled message deleted", null);
    }
);

export const getScheduleMessages = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;

        // Clamp pagination: floor page/limit at 1, cap limit so a request like
        // ?limit=1000000 can't pull everything into memory, and a non-numeric
        // value can't produce a NaN skip (→ 500).
        const page = Math.max(
            1,
            parseInt((req.query.page as string) || "1", 10) || 1,
        );
        const limit = Math.min(
            100,
            Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20),
        );
        const skip = (page - 1) * limit;

        // pipeline
        const pipeline: PipelineStage[] = [
            // Only chats where this user is a member
            {
                $match: {
                    sender: userId,
                    scheduledAt: { $ne: null },
                },
            },

            {
                $lookup: {
                    from: "users",
                    localField: "sender",
                    foreignField: "_id",
                    as: "sender",
                },
            },
            {
                $unwind: {
                    path: "$sender",
                    preserveNullAndEmptyArrays: true,
                },
            },

            {
                $lookup: {
                    from: "chats",
                    let: { chatId: "$chat" }, // Pass the message's chat ID to the pipeline
                    pipeline: [
                        // a. Match the chat document
                        { $match: { $expr: { $eq: ["$_id", "$$chatId"] } } },

                        // b. Unwind members so we can look up individual users.
                        // Preserve empties: a plain $unwind DROPS a chat whose
                        // members array is empty (a group everyone has left),
                        // which made the whole `chat` field come back undefined
                        // and blew up the scheduled-messages table.
                        {
                            $unwind: {
                                path: "$members",
                                preserveNullAndEmptyArrays: true,
                            },
                        },

                        // c. Lookup the User details for this specific member
                        {
                            $lookup: {
                                from: "users",
                                localField: "members.user", // Assuming this is the ObjectId in members array
                                foreignField: "_id",
                                as: "members.user",
                            },
                        },

                        // d. Unwind the user (since lookup returns an array)
                        {
                            $unwind: {
                                path: "$members.user",
                                preserveNullAndEmptyArrays: true,
                            },
                        },

                        // e. Group the members back into the chat document
                        {
                            $project: {
                                // Keep the chat's root fields (for $group later)
                                root: "$$ROOT",
                                // Select only _id and name for the user object
                                "members.user": {
                                    _id: "$members.user._id",
                                    fullName: "$members.user.fullName",
                                },
                                // Keep the member's specific fields (e.g., role)
                                "members._id": "$members._id",
                                "members.role": "$members.role",
                                // You must include all fields you need from the 'members' sub-document here
                            },
                        },
                        // *** END OF NEW STEP ***

                        // e. Group the members back into the chat document
                        {
                            $group: {
                                _id: "$_id",
                                members: {
                                    $push: {
                                        _id: "$members._id",
                                        role: "$members.role",
                                        user: "$members.user", // Use the projected user here
                                    },
                                },
                                // Keep the original chat fields (name, groupAdmin, etc.)
                                root: { $first: "$root" }, // Use the root we saved in the $project stage
                            },
                        },

                        // f. Merge the new 'members' array back into the original chat object
                        {
                            $replaceRoot: {
                                newRoot: {
                                    $mergeObjects: [
                                        "$root",
                                        { members: "$members" },
                                    ],
                                },
                            },
                        },
                    ],
                    as: "chat",
                },
            },
            {
                $unwind: {
                    path: "$chat",
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Sort by updatedAt / lastMessage
            {
                $sort: { createdAt: -1 },
            },

            // Pagination
            { $skip: skip },
            { $limit: limit },
        ];

        const messages = await MessageModel.aggregate(pipeline);

        const total = await MessageModel.countDocuments({
            sender: userId,
            scheduledAt: { $ne: null },
        });

        const totalPages = Math.ceil(total / limit);

        return sendResponse(
            res,
            200,
            "Scheduled Messages retrieved successfully",
            {
                data: messages,
                meta: {
                    results: messages.length,
                    limit,
                    currentPage: page,
                    totalPages,
                    totalCount: total,
                },
            }
        );
    }
);

export const getScheduleMessagesByCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.params.userId;

        // Clamp pagination: floor page/limit at 1, cap limit so a request like
        // ?limit=1000000 can't pull everything into memory, and a non-numeric
        // value can't produce a NaN skip (→ 500).
        const page = Math.max(
            1,
            parseInt((req.query.page as string) || "1", 10) || 1,
        );
        const limit = Math.min(
            100,
            Math.max(1, parseInt((req.query.limit as string) || "20", 10) || 20),
        );
        const skip = (page - 1) * limit;

        // pipeline
        const pipeline: PipelineStage[] = [
            // Only chats where this user is a member
            {
                $match: {
                    sender: Types.ObjectId.createFromHexString(userId),
                    scheduledAt: { $ne: null },
                },
            },

            {
                $lookup: {
                    from: "users",
                    localField: "sender",
                    foreignField: "_id",
                    as: "sender",
                },
            },
            {
                $unwind: {
                    path: "$sender",
                    preserveNullAndEmptyArrays: true,
                },
            },

            {
                $lookup: {
                    from: "chats",
                    let: { chatId: "$chat" }, // Pass the message's chat ID to the pipeline
                    pipeline: [
                        // a. Match the chat document
                        { $match: { $expr: { $eq: ["$_id", "$$chatId"] } } },

                        // b. Unwind members so we can look up individual users.
                        // Preserve empties: a plain $unwind DROPS a chat whose
                        // members array is empty (a group everyone has left),
                        // which made the whole `chat` field come back undefined
                        // and blew up the scheduled-messages table.
                        {
                            $unwind: {
                                path: "$members",
                                preserveNullAndEmptyArrays: true,
                            },
                        },

                        // c. Lookup the User details for this specific member
                        {
                            $lookup: {
                                from: "users",
                                localField: "members.user", // Assuming this is the ObjectId in members array
                                foreignField: "_id",
                                as: "members.user",
                            },
                        },

                        // d. Unwind the user (since lookup returns an array)
                        {
                            $unwind: {
                                path: "$members.user",
                                preserveNullAndEmptyArrays: true,
                            },
                        },

                        // e. Group the members back into the chat document
                        {
                            $project: {
                                // Keep the chat's root fields (for $group later)
                                root: "$$ROOT",
                                // Select only _id and name for the user object
                                "members.user": {
                                    _id: "$members.user._id",
                                    fullName: "$members.user.fullName",
                                },
                                // Keep the member's specific fields (e.g., role)
                                "members._id": "$members._id",
                                "members.role": "$members.role",
                                // You must include all fields you need from the 'members' sub-document here
                            },
                        },
                        // *** END OF NEW STEP ***

                        // e. Group the members back into the chat document
                        {
                            $group: {
                                _id: "$_id",
                                members: {
                                    $push: {
                                        _id: "$members._id",
                                        role: "$members.role",
                                        user: "$members.user", // Use the projected user here
                                    },
                                },
                                // Keep the original chat fields (name, groupAdmin, etc.)
                                root: { $first: "$root" }, // Use the root we saved in the $project stage
                            },
                        },

                        // f. Merge the new 'members' array back into the original chat object
                        {
                            $replaceRoot: {
                                newRoot: {
                                    $mergeObjects: [
                                        "$root",
                                        { members: "$members" },
                                    ],
                                },
                            },
                        },
                    ],
                    as: "chat",
                },
            },
            {
                $unwind: {
                    path: "$chat",
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Sort by updatedAt / lastMessage
            {
                $sort: { createdAt: -1 },
            },

            // Pagination
            { $skip: skip },
            { $limit: limit },
        ];

        const messages = await MessageModel.aggregate(pipeline);

        const total = await MessageModel.countDocuments({
            sender: userId,
            scheduledAt: { $ne: null },
        });

        const totalPages = Math.ceil(total / limit);

        return sendResponse(
            res,
            200,
            "Scheduled Messages retrieved successfully",
            {
                data: messages,
                meta: {
                    results: messages.length,
                    limit,
                    currentPage: page,
                    totalPages,
                    totalCount: total,
                },
            }
        );
    }
);
