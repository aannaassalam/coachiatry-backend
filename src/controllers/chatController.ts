import { NextFunction, Request, Response } from "express";
import ChatModel from "../model/chatModel";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import mongoose, { PipelineStage, Types } from "mongoose";
import {
    multipartComplete,
    multiPartUrls,
    startMultipartUpload,
} from "../utils/aws";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({
    region: process.env.AWS_REGION as string, // Ensuring that the region is of type string
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, // Casting to string to avoid the undefined error
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string, // Casting to string to avoid the undefined error
    },
});
const publicBucketName = process.env.AWS_BUCKET_NAME || "";

export const getAllConversations = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        if (!userId) return next(new AppError("Unauthorized", 401));

        const page = parseInt((req.query.page as string) || "1", 10);
        const limit = parseInt((req.query.limit as string) || "20", 10);
        const skip = (page - 1) * limit;

        const pipeline: PipelineStage[] = [
            // 1️⃣ Only chats where this user is a member
            { $match: { "members.user": userId } },

            // 2️⃣ Extract the current user's membership info
            {
                $addFields: {
                    myData: {
                        $first: {
                            $filter: {
                                input: "$members",
                                as: "m",
                                cond: { $eq: ["$$m.user", userId] },
                            },
                        },
                    },
                },
            },

            // 3️⃣ Lookup last message
            {
                $lookup: {
                    from: "messages",
                    let: { chatId: "$_id" },
                    pipeline: [
                        { $match: { $expr: { $eq: ["$chat", "$$chatId"] } } },
                        { $sort: { createdAt: -1 } },
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

            // 4️⃣ Populate sender info
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

            // 5️⃣ Compute unread count
            {
                $lookup: {
                    from: "messages",
                    let: { chatId: "$_id", lastSeen: "$myData.lastReadAt" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $and: [
                                        { $eq: ["$chat", "$$chatId"] },
                                        { $ne: ["$sender", userId] },
                                        {
                                            $gt: [
                                                "$createdAt",
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

            // 6️⃣ Populate members with user data
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
            { $project: { memberUsers: 0, unread: 0, myData: 0 } },

            // 7️⃣ Sort chats by recent activity
            // {
            //     $addFields: {
            //         sortTimestamp: {
            //             $ifNull: ["$lastMessage.createdAt", "$updatedAt"],
            //         },
            //     },
            // },
            { $sort: { "lastMessage.createdAt": -1 } },

            // 8️⃣ Pagination
            { $skip: skip },
            { $limit: limit },
        ];

        const conversations = await ChatModel.aggregate(pipeline);

        // ✅ Count total
        const total = await ChatModel.countDocuments({
            "members.user": userId,
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
        const { fileName, fileType, chatId } = req.body;

        if (!fileName || !fileType) {
            return next(
                new AppError("Missing fileName, fileType or path", 400)
            );
        }

        const ext = fileName.split(".").pop();

        const response = await startMultipartUpload({
            fileName: `${fileName.replaceAll(`.${ext}`, "")}-${Date.now()}.${ext}`,
            fileType,
            path: `chat/${chatId}`, // sanitize
        });

        return sendResponse(res, 200, "Multipart upload started", {
            uploadId: response.uploadId,
            key: response.key,
        });
    }
);

// 2️⃣ Get pre-signed URLs for parts
export const chatPartUrls = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { uploadId, key, parts } = req.body;

        if (!uploadId || !key || !Array.isArray(parts) || parts.length === 0) {
            return next(new AppError("Missing uploadId, key, or parts[]", 400));
        }

        const urls = await multiPartUrls({ uploadId, key, parts });
        return sendResponse(res, 200, "Presigned part URLs generated", {
            urls,
        });
    }
);

// 3️⃣ Complete upload
export const chatUploadComplete = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { uploadId, key, parts } = req.body;

        if (!uploadId || !key || !Array.isArray(parts) || parts.length === 0) {
            return next(new AppError("Missing uploadId, key, or parts[]", 400));
        }

        const fileUrl = await multipartComplete({ uploadId, key, parts });
        return sendResponse(res, 200, "Upload complete", { fileUrl });
    }
);

export const createGroup = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const groupPhoto = req.file;
        const { name, members } = req.body;

        const group = await ChatModel.create({
            name,
            members: [
                { user: userId, role: "owner" },
                ...members.map((_mem: string) => ({
                    user: _mem,
                    role: "member",
                })),
            ],
            type: "group",
            createdBy: userId,
        });

        const ext = groupPhoto.originalname.split(".").pop();
        const fileName = ext ? `${req.user?._id}.${ext}` : `${req.user?._id}`;

        const params = {
            Bucket: publicBucketName,
            Key: `profile/${fileName}`,
            Body: groupPhoto.buffer,
        };

        const command = new PutObjectCommand(params);
        await s3.send(command);

        const url = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;

        group.groupPhoto = url;
        await group.save();

        sendResponse(res, 200, "Group created successfully", group);
    }
);

export const editGroup = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const groupPhoto = req.file;
        const { name, members, chatId } = req.body;

        const currentGroup = await ChatModel.findById(chatId);
        if (!currentGroup) {
            throw new AppError("Group not found", 404);
        }

        const isOwner =
            currentGroup.members.find(
                (_mem) => _mem.user.toString() === userId.toString()
            ).role === "owner";
        if (!isOwner) {
            throw new AppError(
                "Edit can only be made by owner of the group",
                403
            );
        }

        const existingMembers = currentGroup.members.map((_mem) =>
            _mem.user.toString()
        );
        const toAdd = members.filter(
            (_mem: string) => !existingMembers.includes(_mem)
        );
        const toRemove = existingMembers.filter(
            (_mem: string) =>
                _mem !== userId.toString() && !members.includes(_mem)
        );

        const updatedMembers = [
            // preserve existing members (owner + those not removed)
            ...currentGroup.members.filter(
                (m) =>
                    m.user.toString() === userId.toString() ||
                    !toRemove.includes(m.user.toString())
            ),

            // add new ones with default role & joinedAt
            ...toAdd.map((id: string) => ({
                user: id,
                role: "member",
                joinedAt: new Date(),
                lastReadAt: new Date(),
            })),
        ];

        const group = await ChatModel.findByIdAndUpdate(chatId, {
            name,
            members: updatedMembers,
        });

        if (groupPhoto) {
            const ext = groupPhoto.originalname.split(".").pop();
            const fileName = ext
                ? `${req.user?._id}.${ext}`
                : `${req.user?._id}`;

            const params = {
                Bucket: publicBucketName,
                Key: `profile/${fileName}`,
                Body: groupPhoto.buffer,
            };

            const command = new PutObjectCommand(params);
            await s3.send(command);

            const url = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;

            group.groupPhoto = url;
            await group.save();
        }

        sendResponse(res, 200, "Group edited successfully", group);
    }
);
