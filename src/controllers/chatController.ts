import { NextFunction, Request, Response } from "express";
import ChatModel from "../model/chatModel";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import { PipelineStage, Types } from "mongoose";
import {
    multipartComplete,
    multiPartUrls,
    startMultipartUpload,
} from "../utils/aws";

export const getAllConversations = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id; // assuming you attach user in auth middleware
        if (!userId) {
            return next(new AppError("Unauthorized", 401));
        }

        const page = parseInt((req.query.page as string) || "1", 10);
        const limit = parseInt((req.query.limit as string) || "20", 10);
        const skip = (page - 1) * limit;

        // pipeline
        const pipeline: PipelineStage[] = [
            // Only chats where this user is a member
            {
                $match: {
                    "members.user": userId,
                },
            },

            // Project user-specific member info
            {
                $addFields: {
                    myData: {
                        $first: {
                            $filter: {
                                input: "$members",
                                as: "m",
                                cond: { $eq: ["$$m.userId", userId] },
                            },
                        },
                    },
                },
            },

            // Lookup last message
            {
                $lookup: {
                    from: "messages",
                    let: { chatId: "$_id" },
                    pipeline: [
                        { $match: { $expr: { $eq: ["$chat", "$$chatId"] } } },
                        { $sort: { sentAt: -1 } },
                        { $limit: 1 },
                    ],
                    as: "lastMessage",
                },
            },
            {
                $unwind: {
                    path: "$lastMessage",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $lookup: {
                    from: "users",
                    localField: "lastMessage.sender",
                    foreignField: "_id",
                    as: "lastMessage.sender",
                },
            },
            {
                $unwind: {
                    path: "$lastMessage.sender",
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Lookup unread count
            {
                $lookup: {
                    from: "messages",
                    let: { chatId: "$_id", lastSeen: "$myData.lastReadAt" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$chatId", "$$chatId"] },
                                        {
                                            $gt: [
                                                "$sentAt",
                                                {
                                                    $ifNull: [
                                                        "$$lastSeen",
                                                        new Date(0),
                                                    ],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                        { $count: "unreadCount" },
                    ],
                    as: "unread",
                },
            },
            {
                $addFields: {
                    unreadCount: {
                        $ifNull: [
                            { $arrayElemAt: ["$unread.unreadCount", 0] },
                            0,
                        ],
                    },
                },
            },

            {
                $lookup: {
                    from: "users",
                    localField: "members.user",
                    foreignField: "_id",
                    as: "memberUsers",
                },
            },
            {
                $addFields: {
                    members: {
                        $map: {
                            input: "$members",
                            as: "m",
                            in: {
                                role: "$$m.role",
                                joinedAt: "$$m.joinedAt",
                                lastReadAt: "$$m.lastReadAt",
                                user: {
                                    $arrayElemAt: [
                                        {
                                            $filter: {
                                                input: "$memberUsers",
                                                as: "u",
                                                cond: {
                                                    $eq: [
                                                        "$$u._id",
                                                        "$$m.user",
                                                    ],
                                                },
                                            },
                                        },
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                },
            },
            { $project: { memberUsers: 0 } },

            // Sort by updatedAt / lastMessage
            {
                $sort: { "lastMessage.sentAt": -1, updatedAt: -1 },
            },

            // Pagination
            { $skip: skip },
            { $limit: limit },
        ];

        const conversations = await ChatModel.aggregate(pipeline);

        const total = await ChatModel.countDocuments({
            "members.userId": userId,
        });
        const totalPages = Math.ceil(total / limit);

        return sendResponse(res, 200, "Conversations retrieved successfully", {
            data: conversations,
            meta: {
                results: conversations.length,
                limit,
                currentPage: page,
                totalPages,
                totalCount: total,
            },
        });
    }
);

export const getConversation = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const roomId = req.params?.roomId; // assuming you attach user in auth middleware
        if (!roomId) {
            return next(new AppError("Unauthorized", 401));
        }

        // pipeline
        const pipeline: PipelineStage[] = [
            // Only chats where this user is a member
            {
                $match: {
                    _id: Types.ObjectId.createFromHexString(roomId),
                },
            },

            {
                $lookup: {
                    from: "users",
                    localField: "members.user",
                    foreignField: "_id",
                    as: "memberUsers",
                },
            },
            {
                $addFields: {
                    members: {
                        $map: {
                            input: "$members",
                            as: "m",
                            in: {
                                role: "$$m.role",
                                joinedAt: "$$m.joinedAt",
                                lastReadAt: "$$m.lastReadAt",
                                user: {
                                    $arrayElemAt: [
                                        {
                                            $filter: {
                                                input: "$memberUsers",
                                                as: "u",
                                                cond: {
                                                    $eq: [
                                                        "$$u._id",
                                                        "$$m.user",
                                                    ],
                                                },
                                            },
                                        },
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                },
            },
            { $project: { memberUsers: 0 } },
        ];

        const conversation = await ChatModel.aggregate(pipeline);

        return sendResponse(
            res,
            200,
            "Conversations retrieved successfully",
            conversation[0]
        );
    }
);

export const startChatMultipartUpload = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const response = await startMultipartUpload(req.body);
        return sendResponse(res, 200, "", response);
    }
);

// 2️⃣ Get pre-signed URLs for each part
export const chatPartUrls = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const response = await multiPartUrls(req.body);

        return sendResponse(res, 200, "", { urls: response });
    }
);

// 3️⃣ Complete upload
export const chatUploadComplete = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const response = await multipartComplete(req.body);
        return sendResponse(res, 200, "", { fileUrl: response });
    }
);
