import { Request, Response, NextFunction } from "express";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import MessageModel from "../model/messageModel";
import { sendResponse } from "../utils/response";
import { PipelineStage, Types } from "mongoose";

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
