import moment from "moment";
import { Request, Response, NextFunction } from "express";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import MessageModel from "../model/messageModel";
import { sendResponse } from "../utils/response";
import { PipelineStage, Types } from "mongoose";
import { messageQueue } from "../utils/queues/messageQueue";

export const getMessages = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const room = req.params?.roomId;

        if (!room) {
            return next(new AppError("No Room provided", 401));
        }

        const page = parseInt((req.query.page as string) || "1", 10);
        const limit = parseInt((req.query.limit as string) || "20", 10);
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

export const scheduleMessage = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const { message, date, time, frequency, chatId } = req.body;

        const msg = await MessageModel.create({
            sender: userId,
            chat: chatId,
            content: message,
            scheduledAt: moment(`${date} ${time}`, "YYYY-MM-DD HH:mm").toDate(),
            repeat: frequency || "none",
        });

        const delay = new Date(msg.scheduledAt).getTime() - Date.now();

        await messageQueue.add(
            "sendMessage",
            { messageId: msg._id },
            {
                delay: Math.max(delay, 0),
                attempts: 3, // retry logic
            }
        );

        sendResponse(res, 200, "Message scheduled successfully", msg);
    }
);

export const editScheduleMessage = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const messageId = req.params?.messageId;
        const { message, date, time, frequency } = req.body;

        const msg = await MessageModel.findByIdAndUpdate(messageId, {
            content: message,
            scheduledAt: moment(`${date} ${time}`, "YYYY-MM-DD HH:mm").toDate(),
            repeat: frequency || "none",
        });

        const oldJob = await messageQueue.getJob(msg._id);
        if (oldJob) {
            await oldJob.remove();
            console.log(`🗑️ Removed old job for message ${msg._id}`);

            const delay = new Date(msg.scheduledAt).getTime() - Date.now();

            await messageQueue.add(
                "sendMessage",
                { messageId: msg._id },
                {
                    jobId: msg._id,
                    delay: Math.max(delay, 0),
                    attempts: 3, // retry logic
                }
            );
        }

        sendResponse(res, 200, "Message edited successfully", msg);
    }
);

export const getScheduleMessages = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;

        const page = parseInt((req.query.page as string) || "1", 10);
        const limit = parseInt((req.query.limit as string) || "20", 10);
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
                    localField: "chat",
                    foreignField: "_id",
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
