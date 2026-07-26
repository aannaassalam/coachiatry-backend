import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextFunction, Request, Response } from "express";
import mongoose, { PipelineStage, Types } from "mongoose";
import ChatModel from "../model/chatModel";
import GroupInviteModel from "../model/groupInviteModel";
import MessageModel from "../model/messageModel";
import UserModel from "../model/userModel";
import AppError from "../utils/appError";
import {
    multipartComplete,
    multiPartUrls,
    startMultipartUpload,
} from "../utils/aws";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import { sendEmail } from "../utils/email_sms";
import { GROUP_INVITE_HTML } from "../constants/constants";

const s3 = new S3Client({
    region: process.env.AWS_REGION as string, // Ensuring that the region is of type string
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, // Casting to string to avoid the undefined error
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string, // Casting to string to avoid the undefined error
    },
});
const publicBucketName = process.env.AWS_BUCKET_NAME || "";


export async function createDirectChatIfNotExists(
    userA: mongoose.Types.ObjectId,
    userB: mongoose.Types.ObjectId,
    createdBy: mongoose.Types.ObjectId,
) {
    const existing = await ChatModel.findOne({
        type: "direct",
        "members.user": { $all: [userA, userB] },
        $expr: { $eq: [{ $size: "$members" }, 2] },
    });

    if (existing) return existing;

    return ChatModel.create({
        type: "direct",
        createdBy,
        members: [
            { user: userA, role: "member" },
            { user: userB, role: "member" },
        ],
        isDeletable: true,
    });
}

// Archiving is per-member (see chatModel), so "is this chat archived?" is a
// question about *this* viewer's entry in members[]. Chats saved before the
// flag existed have no `archived` key at all, hence `$ne: true` rather than
// `false` for the default list.
const archivedMatch = (
    userOid: Types.ObjectId,
    archived: boolean,
): PipelineStage.FacetPipelineStage => ({
    $match: {
        members: {
            $elemMatch: {
                user: userOid,
                archived: archived ? true : { $ne: true },
            },
        },
    },
});

export const getAllConversations = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        if (!userId) return next(new AppError("Unauthorized", 401));
        const wantArchived = req.query.archived === "true";

        const userOid = Types.ObjectId.createFromHexString(userId.toString());
        const page = parseInt((req.query.page as string) || "1", 10);
        const limit = parseInt((req.query.limit as string) || "20", 10);
        const skip = (page - 1) * limit;
        const rawSearch = (req.query.search as string) || "";
        const search = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // ── Pipeline shape ──────────────────────────────────────────────────
        // The expensive stages here are per-chat: a $lookup for the last
        // message and a correlated $count for unread, each evaluated once per
        // chat document that reaches them. They used to run for EVERY chat the
        // user belongs to, because the sort was on a computed field
        // ($ifNull(lastMessage.createdAt, createdAt)) which no index can serve —
        // so Mongo had to build and sort the whole set before it could take a
        // page of 20. A user in 100 chats paid 200 sub-pipelines to render 20
        // rows, on every app open and after every incoming message.
        //
        // Now `lastMessageAt` is a stored, indexed field, so the sort and the
        // page can be applied FIRST and the per-chat work only runs for the 20
        // rows actually being returned. The output shape is unchanged.
        //
        // Search is the exception: it filters on joined member names, so the
        // join has to happen before the filter, and the page can only be cut
        // afterwards. That path keeps the old ordering (still on the indexed
        // field) and simply costs more — it is a rarer, user-initiated action,
        // not the every-load path.
        const memberLookup: PipelineStage.Lookup = {
            $lookup: {
                from: "users",
                localField: "members.user",
                foreignField: "_id",
                pipeline: [
                    {
                        $project: {
                            password: 0,
                            otp: 0,
                            otpExpires: 0,
                            passwordResetToken: 0,
                            passwordResetExpires: 0,
                        },
                    },
                ],
                as: "memberUsers",
            },
        };

        // Stages that narrow the candidate set. Without a search this is just
        // the indexed match, which the {members.user, lastMessageAt} index then
        // walks in sort order.
        const baseStages: PipelineStage[] = [
            { $match: { "members.user": userOid } },
        ];

        if (search) {
            const searchRegex = new RegExp(search, "i");
            baseStages.push(memberLookup, {
                $match: {
                    $or: [
                        {
                            type: "group",
                            name: { $regex: searchRegex },
                        },
                        {
                            type: "direct",
                            memberUsers: {
                                $elemMatch: {
                                    _id: { $ne: userOid },
                                    fullName: { $regex: searchRegex },
                                },
                            },
                        },
                    ],
                },
            });
        }

        // Cut to the page before any per-chat work happens. The archived split
        // lives inside the facets (not in baseStages) so the archivedCount
        // facet below can still see the whole set in one aggregation.
        const paginateStages: PipelineStage.FacetPipelineStage[] = [
            archivedMatch(userOid, wantArchived),
            { $sort: { lastMessageAt: -1 } },
            { $skip: skip },
            { $limit: limit },
        ];

        // Single aggregation with $facet for data + count
        const result = await ChatModel.aggregate([
            ...baseStages,

            {
                $facet: {
                    data: [
                        ...paginateStages,
                        // Joined here (not in baseStages) so member documents
                        // are only fetched for the page. A 500-member group
                        // otherwise hydrated 500 users per chat, for every chat.
                        ...(search ? [] : [memberLookup]),

                        // Extract current user's membership info
                        {
                            $addFields: {
                                myData: {
                                    $first: {
                                        $filter: {
                                            input: "$members",
                                            as: "m",
                                            cond: {
                                                $eq: ["$$m.user", userOid],
                                            },
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
                                    {
                                        $match: {
                                            $expr: {
                                                $eq: ["$chat", "$$chatId"],
                                            },
                                            scheduledAt: null,
                                        },
                                    },
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

                        // Populate sender info (without sensitive fields)
                        {
                            $lookup: {
                                from: "users",
                                localField: "lastMessage.sender",
                                foreignField: "_id",
                                pipeline: [
                                    {
                                        $project: {
                                            password: 0,
                                            otp: 0,
                                            otpExpires: 0,
                                            passwordResetToken: 0,
                                            passwordResetExpires: 0,
                                        },
                                    },
                                ],
                                as: "lastMessage.sender",
                            },
                        },
                        {
                            $unwind: {
                                path: "$lastMessage.sender",
                                preserveNullAndEmptyArrays: true,
                            },
                        },

                        // Compute unread count
                        {
                            $lookup: {
                                from: "messages",
                                let: {
                                    chatId: "$_id",
                                    lastSeen: "$myData.lastReadAt",
                                },
                                pipeline: [
                                    {
                                        $match: {
                                            $expr: {
                                                $and: [
                                                    {
                                                        $eq: [
                                                            "$chat",
                                                            "$$chatId",
                                                        ],
                                                    },
                                                    {
                                                        $ne: [
                                                            "$sender",
                                                            userOid,
                                                        ],
                                                    },
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
                                        {
                                            $arrayElemAt: [
                                                "$unread.unreadCount",
                                                0,
                                            ],
                                        },
                                        0,
                                    ],
                                },
                            },
                        },

                        // Map members with looked-up user data
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
                                            // Substitute a placeholder when the
                                            // referenced user no longer exists
                                            // so the chat still renders
                                            // ("Deleted user") not crashes.
                                            user: {
                                                $ifNull: [
                                                    {
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
                                                    {
                                                        _id: "$$m.user",
                                                        fullName: "Deleted user",
                                                        photo: null,
                                                        deleted: true,
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                        {
                            $project: {
                                memberUsers: 0,
                                unread: 0,
                                myData: 0,
                            },
                        },

                        // No sort/skip/limit here: the rows arrived already
                        // ordered and paginated by the indexed $sort above. The
                        // computed sortTimestamp this replaces could not use an
                        // index, so Mongo had to materialise and sort every one
                        // of the user's chats before it could take a page.
                    ],

                    totalCount: [
                        archivedMatch(userOid, wantArchived),
                        { $count: "count" },
                    ],
                    // Drives the "Archived (n)" row at the top of the list, so
                    // it costs no extra round trip.
                    archivedCount: [
                        archivedMatch(userOid, true),
                        { $count: "count" },
                    ],
                },
            },
        ]);

        const conversations = result[0]?.data ?? [];
        const total = result[0]?.totalCount[0]?.count ?? 0;
        const totalPages = Math.ceil(total / limit);

        return sendResponse(res, 200, "Conversations retrieved successfully", {
            data: conversations,
            meta: {
                results: conversations.length,
                limit,
                currentPage: page,
                totalPages,
                totalCount: total,
                archivedCount: result[0]?.archivedCount?.[0]?.count ?? 0,
            },
        });
    },
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
                    pipeline: [
                        {
                            $project: {
                                password: 0,
                                otp: 0,
                                otpExpires: 0,
                                passwordResetToken: 0,
                                passwordResetExpires: 0,
                            },
                        },
                    ],
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
                                // Lets the chat header offer Archive vs
                                // Unarchive for the viewer's own membership.
                                archived: { $ifNull: ["$$m.archived", false] },
                                // Substitute a placeholder when the referenced
                                // user no longer exists so the chat still
                                // renders ("Deleted user") instead of crashing.
                                // Also expose an explicit `deleted` flag on every
                                // member — true when the account is missing
                                // (hard-deleted) OR deactivated (active:false) —
                                // so clients don't have to infer it.
                                user: {
                                    $let: {
                                        vars: {
                                            found: {
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
                                        in: {
                                            $cond: [
                                                { $ifNull: ["$$found", false] },
                                                {
                                                    $mergeObjects: [
                                                        "$$found",
                                                        {
                                                            deleted: {
                                                                $eq: [
                                                                    "$$found.active",
                                                                    false,
                                                                ],
                                                            },
                                                        },
                                                    ],
                                                },
                                                {
                                                    _id: "$$m.user",
                                                    fullName: "Deleted user",
                                                    photo: null,
                                                    deleted: true,
                                                },
                                            ],
                                        },
                                    },
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
            conversation[0],
        );
    },
);

export const getAllConversationsByCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.params.userId;
        if (!userId) return next(new AppError("Unauthorized", 401));

        const userOid = Types.ObjectId.createFromHexString(userId);
        const page = parseInt((req.query.page as string) || "1", 10);
        const limit = parseInt((req.query.limit as string) || "20", 10);
        const skip = (page - 1) * limit;
        // Coaches and higher-ups see the same archived/unarchived split the
        // client sees — archiving state belongs to the client's membership.
        const wantArchived = req.query.archived === "true";

        const sensitiveProjection = {
            $project: {
                password: 0,
                otp: 0,
                otpExpires: 0,
                passwordResetToken: 0,
                passwordResetExpires: 0,
            },
        };

        const result = await ChatModel.aggregate([
            { $match: { "members.user": userOid } },

            {
                $facet: {
                    data: [
                        // Same restructure as getAllConversations: sort and cut
                        // the page on the indexed `lastMessageAt` FIRST, so the
                        // per-chat last-message and unread lookups below only run
                        // for the 20 rows being returned rather than for every
                        // chat this user is in.
                        archivedMatch(userOid, wantArchived),
                        { $sort: { lastMessageAt: -1 } },
                        { $skip: skip },
                        { $limit: limit },

                        // Extract current user's membership info
                        {
                            $addFields: {
                                myData: {
                                    $first: {
                                        $filter: {
                                            input: "$members",
                                            as: "m",
                                            cond: {
                                                $eq: ["$$m.user", userOid],
                                            },
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
                                    {
                                        $match: {
                                            $expr: {
                                                $eq: ["$chat", "$$chatId"],
                                            },
                                            scheduledAt: null,
                                        },
                                    },
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

                        // Populate sender info
                        {
                            $lookup: {
                                from: "users",
                                localField: "lastMessage.sender",
                                foreignField: "_id",
                                pipeline: [sensitiveProjection],
                                as: "lastMessage.sender",
                            },
                        },
                        {
                            $unwind: {
                                path: "$lastMessage.sender",
                                preserveNullAndEmptyArrays: true,
                            },
                        },

                        // Compute unread count
                        {
                            $lookup: {
                                from: "messages",
                                let: {
                                    chatId: "$_id",
                                    lastSeen: "$myData.lastReadAt",
                                },
                                pipeline: [
                                    {
                                        $match: {
                                            $expr: {
                                                $and: [
                                                    {
                                                        $eq: [
                                                            "$chat",
                                                            "$$chatId",
                                                        ],
                                                    },
                                                    {
                                                        $ne: [
                                                            "$sender",
                                                            userOid,
                                                        ],
                                                    },
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
                                        {
                                            $arrayElemAt: [
                                                "$unread.unreadCount",
                                                0,
                                            ],
                                        },
                                        0,
                                    ],
                                },
                            },
                        },

                        // Populate members
                        {
                            $lookup: {
                                from: "users",
                                localField: "members.user",
                                foreignField: "_id",
                                pipeline: [sensitiveProjection],
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
                                            // Substitute a placeholder when the
                                            // referenced user no longer exists
                                            // so the chat still renders
                                            // ("Deleted user") not crashes.
                                            user: {
                                                $ifNull: [
                                                    {
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
                                                    {
                                                        _id: "$$m.user",
                                                        fullName: "Deleted user",
                                                        photo: null,
                                                        deleted: true,
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                        {
                            $project: {
                                memberUsers: 0,
                                unread: 0,
                                myData: 0,
                            },
                        },

                        // Already ordered and paginated above by the index.
                    ],

                    totalCount: [
                        archivedMatch(userOid, wantArchived),
                        { $count: "count" },
                    ],
                    archivedCount: [
                        archivedMatch(userOid, true),
                        { $count: "count" },
                    ],
                },
            },
        ]);

        const conversations = result[0]?.data ?? [];
        const total = result[0]?.totalCount[0]?.count ?? 0;
        const totalPages = Math.ceil(total / limit);

        return sendResponse(res, 200, "Conversations retrieved successfully", {
            data: conversations,
            meta: {
                results: conversations.length,
                limit,
                currentPage: page,
                totalPages,
                totalCount: total,
                archivedCount: result[0]?.archivedCount?.[0]?.count ?? 0,
            },
        });
    },
);

export const startChatMultipartUpload = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { fileName, fileType, chatId } = req.body;

        if (!fileName || !fileType) {
            return next(
                new AppError("Missing fileName, fileType or path", 400),
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
    },
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
    },
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
    },
);

export const createGroup = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const groupPhoto = req.file;
        const { name } = req.body;
        // members may be absent when the group is created purely from email
        // invites (no directly-addable users selected).
        const members: string[] = Array.isArray(req.body.members)
            ? req.body.members
            : req.body.members
              ? [req.body.members]
              : [];

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

        sendResponse(res, 200, "Group created successfully", group);
    },
);

export const editGroup = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const groupPhoto = req.file;
        const { name, chatId } = req.body;
        // members may be absent when an edit only adds email invites.
        const members: string[] = Array.isArray(req.body.members)
            ? req.body.members
            : req.body.members
              ? [req.body.members]
              : [];

        const currentGroup = await ChatModel.findById(chatId);
        if (!currentGroup) {
            throw new AppError("Group not found", 404);
        }

        const isOwner =
            currentGroup.members.find(
                (_mem) => _mem.user.toString() === userId.toString(),
            )?.role === "owner";
        if (!isOwner) {
            throw new AppError(
                "Edit can only be made by owner of the group",
                403,
            );
        }

        const existingMembers = currentGroup.members.map((_mem) =>
            _mem.user.toString(),
        );
        const toAdd = members.filter(
            (_mem: string) => !existingMembers.includes(_mem),
        );
        const toRemove = existingMembers.filter(
            (_mem: string) =>
                _mem !== userId.toString() && !members.includes(_mem),
        );

        const updatedMembers = [
            // preserve existing members (owner + those not removed)
            ...currentGroup.members.filter(
                (m) =>
                    m.user.toString() === userId.toString() ||
                    !toRemove.includes(m.user.toString()),
            ),

            // add new ones with default role & joinedAt
            ...toAdd.map((id: string) => ({
                user: id,
                role: "member",
                joinedAt: new Date(),
                lastReadAt: new Date(),
            })),
        ];

        const group = await ChatModel.findByIdAndUpdate(
            chatId,
            {
                name,
                members: updatedMembers,
            },
            { new: true },
        );

        if (!group) {
            throw new AppError("Group not found", 404);
        }

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
    },
);

export const leaveGroup = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const { chatId } = req.params;

        const currentGroup = await ChatModel.findById(chatId);
        if (!currentGroup) {
            throw new AppError("Group not found", 404);
        }
        if (currentGroup.type !== "group") {
            return next(new AppError("You can only leave group chats", 400));
        }

        const leavingMember = currentGroup.members.find(
            (m) => m.user.toString() === userId.toString(),
        );
        if (!leavingMember) {
            return next(
                new AppError("You are not a member of this group", 403),
            );
        }

        const remaining = currentGroup.members.filter(
            (m) => m.user.toString() !== userId.toString(),
        );

        // If the owner leaves, promote the earliest-joined remaining member so
        // the group isn't orphaned without an owner (which would otherwise make
        // edit/invite impossible).
        if (
            leavingMember.role === "owner" &&
            remaining.length > 0 &&
            !remaining.some((m) => m.role === "owner")
        ) {
            const successor = remaining
                .slice()
                .sort(
                    (a, b) =>
                        new Date(a.joinedAt as any).getTime() -
                        new Date(b.joinedAt as any).getTime(),
                )[0];
            successor.role = "owner";
        }

        const group = await ChatModel.findByIdAndUpdate(
            chatId,
            { members: remaining },
            { new: true },
        );

        sendResponse(res, 200, "Group left successfully", group);
    },
);

// Archive / unarchive a conversation for the requester only — writes the flag
// on their own members[] entry, never anyone else's.
export const setChatArchived = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { chatId } = req.params;
        const archived = req.body?.archived !== false;

        const result = await ChatModel.updateOne(
            { _id: chatId, "members.user": req.user._id },
            { $set: { "members.$.archived": archived } },
        );
        if (!result.matchedCount) {
            return next(new AppError("Chat not found", 404));
        }

        sendResponse(
            res,
            200,
            archived ? "Conversation archived" : "Conversation unarchived",
            { chatId, archived },
        );
    },
);

// Delete a single DIRECT conversation (chat doc + all its messages) that the
// caller has with a DELETED user. Guarded so it can only remove conversations
// whose other member is a deactivated/hard-deleted account — active-user
// conversations and group chats can't be deleted through this route.
export const deleteDirectConversation = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user._id;
        const { chatId } = req.params;

        const chat = await ChatModel.findById(chatId);
        if (!chat) return next(new AppError("Chat not found", 404));
        if (chat.type !== "direct") {
            return next(
                new AppError(
                    "Only direct conversations can be deleted this way",
                    400,
                ),
            );
        }

        const isMember = chat.members.some(
            (m: any) => m.user.toString() === userId.toString(),
        );
        if (!isMember) {
            return next(new AppError("You are not a member of this chat", 403));
        }

        const other = chat.members.find(
            (m: any) => m.user.toString() !== userId.toString(),
        );
        if (other) {
            // A missing user doc = hard-deleted (allowed). A present doc must be
            // inactive (soft-deleted) — otherwise this is an active conversation
            // and deletion is refused.
            const otherUser = await UserModel.findById(other.user).select(
                "active",
            );
            if (otherUser && otherUser.active !== false) {
                return next(
                    new AppError(
                        "You can only delete conversations with deleted users",
                        403,
                    ),
                );
            }
        }

        await MessageModel.deleteMany({ chat: chat._id });
        await ChatModel.findByIdAndDelete(chat._id);

        return sendResponse(res, 200, "Conversation deleted", {
            chatId: chat._id,
        });
    },
);

// ----------------------------------------------------------------------------
// GROUP INVITES BY EMAIL
// ----------------------------------------------------------------------------

const isGroupOwner = (group: any, userId: any) =>
    group.members.find(
        (m: any) => m.user.toString() === userId.toString(),
    )?.role === "owner";

// Add a user to a group if they aren't already a member. Returns true if added.
async function addUserToGroup(chatId: any, userId: any): Promise<boolean> {
    const result = await ChatModel.updateOne(
        { _id: chatId, "members.user": { $ne: userId } },
        {
            $push: {
                members: {
                    user: userId,
                    role: "member",
                    joinedAt: new Date(),
                    lastReadAt: new Date(),
                },
            },
        },
    );
    return result.modifiedCount > 0;
}

/**
 * Owner invites one or more emails to a group. For each email:
 *   - if a user with that email exists, we still create an invite token so
 *     they join on next login (they may not have direct access yet);
 *   - if no user exists, the token drives the sign-up → auto-join flow.
 * An email is sent with a tokenised link in both cases.
 */
export const inviteToGroupByEmail = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const { chatId, emails } = req.body;

        if (!chatId) return next(new AppError("chatId is required", 400));
        if (!Array.isArray(emails) || emails.length === 0) {
            return next(new AppError("No emails provided", 400));
        }

        const group = await ChatModel.findById(chatId);
        if (!group || group.type !== "group") {
            return next(new AppError("Group not found", 404));
        }
        if (!isGroupOwner(group, userId)) {
            return next(
                new AppError("Only the group owner can invite people", 403),
            );
        }

        const normalized = [
            ...new Set(
                emails
                    .map((e: string) => String(e).trim().toLowerCase())
                    .filter(Boolean),
            ),
        ];

        const results = await Promise.all(
            normalized.map(async (email) => {
                const existingUser = await UserModel.findById(req.user._id);
                // Don't invite the owner's own email.
                if (email === existingUser?.email?.toLowerCase()) {
                    return { email, skipped: "self" };
                }

                const accountUser = await UserModel.findOne({
                    email,
                    active: true,
                }).select("_id");

                // If they already exist AND are already a member, skip.
                if (
                    accountUser &&
                    group.members.some(
                        (m) => m.user.toString() === accountUser._id.toString(),
                    )
                ) {
                    return { email, skipped: "already_member" };
                }

                // Upsert one invite row per (chat, email).
                const invite = await GroupInviteModel.findOneAndUpdate(
                    { chat: chatId, email },
                    {
                        chat: chatId,
                        email,
                        invitedBy: userId,
                        acceptedBy: null,
                        acceptedAt: null,
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true },
                );

                const isNewUser = !accountUser;
                // New users go to register first (callback brings them back to
                // the invite page after they finish auth); existing users go
                // straight to the invite page, which redirects them to login.
                const invitePath = `/group-invite/${invite.token}`;
                const link = isNewUser
                    ? `${process.env.CLIENT_URL}/auth/register?local_callback=${invitePath}`
                    : `${process.env.CLIENT_URL}${invitePath}`;

                await sendEmail({
                    email,
                    subject: `${req.user.fullName} invited you to "${group.name}"`,
                    html: GROUP_INVITE_HTML(
                        req.user.fullName,
                        (group.name as string) || "a group",
                        link,
                        isNewUser,
                    ),
                }).catch((err) =>
                    console.error(
                        `[group-invite] email to ${email} failed:`,
                        err,
                    ),
                );

                return { email, invited: true, isNewUser };
            }),
        );

        sendResponse(res, 200, "Invitations sent", { results });
    },
);

/**
 * Return a lightweight preview of an invite token so the landing page can show
 * the group name / inviter before the user accepts. Requires auth (the page
 * sends the user through login first via local_callback).
 */
export const getGroupInvite = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { token } = req.params;

        const invite = await GroupInviteModel.findOne({ token })
            .populate("chat", "name groupPhoto type")
            .populate("invitedBy", "fullName photo");

        if (!invite) {
            return next(new AppError("Invite not found or expired", 404));
        }

        sendResponse(res, 200, "Invite fetched", {
            token: invite.token,
            email: invite.email,
            accepted: !!invite.acceptedBy,
            chat: invite.chat,
            invitedBy: invite.invitedBy,
        });
    },
);

/**
 * Authenticated user accepts an invite token. Adds them to the group and marks
 * the invite consumed. Returns the chatId so the client can navigate to it.
 */
export const acceptGroupInvite = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        const { token } = req.params;

        const invite = await GroupInviteModel.findOne({ token });
        if (!invite) {
            return next(new AppError("Invite not found or expired", 404));
        }

        const group = await ChatModel.findById(invite.chat);
        if (!group) {
            return next(new AppError("Group no longer exists", 404));
        }

        await addUserToGroup(invite.chat, userId);

        if (!invite.acceptedBy) {
            invite.acceptedBy = userId;
            invite.acceptedAt = new Date();
            await invite.save();
        }

        sendResponse(res, 200, "Joined group", {
            chatId: invite.chat.toString(),
        });
    },
);

/**
 * Called from the auth flow (after signup/verify or first social login) to
 * auto-join any groups the user's email was invited to. Best-effort: never
 * throws into the auth path.
 */
export async function processPendingGroupInvitesForUser(user: {
    _id: any;
    email: string;
}): Promise<void> {
    try {
        const email = user.email?.toLowerCase();
        if (!email) return;

        const invites = await GroupInviteModel.find({
            email,
            acceptedBy: null,
        });

        await Promise.all(
            invites.map(async (invite) => {
                const added = await addUserToGroup(invite.chat, user._id);
                if (added || !invite.acceptedBy) {
                    invite.acceptedBy = user._id;
                    invite.acceptedAt = new Date();
                    await invite.save();
                }
            }),
        );
    } catch (err) {
        console.error("[group-invite] processPending failed:", err);
    }
}
