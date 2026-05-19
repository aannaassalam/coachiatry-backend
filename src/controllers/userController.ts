import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextFunction, Request, Response } from "express";
import UserModel from "../model/userModel";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import AppError from "../utils/appError";
import ChatModel from "../model/chatModel";
import mongoose from "mongoose";
import crypto from "crypto";
import { sendEmail } from "../utils/email_sms";
import { WELCOME_EMAIL_HTML_WITH_PASSWORD } from "../constants/constants";
import { createDirectChatIfNotExists } from "./chatController";

// Initialize S3 client
const s3 = new S3Client({
    region: process.env.AWS_REGION as string, // Ensuring that the region is of type string
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, // Casting to string to avoid the undefined error
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string, // Casting to string to avoid the undefined error
    },
});
const publicBucketName = process.env.AWS_BUCKET_NAME || "";

// Controller to update user profile picture
export const updateProfilePicture = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        // Multer should be configured with .single("profilePicture")
        // So the uploaded file will be available as req.file

        if (!req.file) {
            return res
                .status(400)
                .json({ success: false, error: "No file uploaded" });
        }

        const file = req.file;
        // Use the fieldname to ensure correct file handling
        // If you want to restrict only "profilePicture" uploads:
        if (file.fieldname !== "profilePicture") {
            return res
                .status(400)
                .json({ success: false, error: "Invalid file field" });
        }

        // Extract file extension
        const ext = file.originalname.split(".").pop();
        const fileName = ext ? `${req.user?._id}.${ext}` : `${req.user?._id}`;

        const params = {
            Bucket: publicBucketName,
            Key: `profile/${fileName}`,
            Body: file.buffer,
        };

        const command = new PutObjectCommand(params);
        await s3.send(command);

        const url = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;

        // Update user's profile picture URL in your database here
        await UserModel.findByIdAndUpdate(req.user?._id, {
            photo: url,
        });

        return sendResponse(res, 200, "Profile Picture updated Successfully");
    },
);

export const getAllUsers = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const users = await UserModel.find({
            verified: true,
            active: true,
        }).select(
            "-password -otp -otpExpires -passwordResetToken -passwordResetExpires -__v -fcmToken",
        );

        sendResponse(res, 200, "All users fetched", users);
    },
);

export const getUsersById = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { ids } = req.query;

        const users = await UserModel.find(
            {
                _id: {
                    $in: ids,
                },
                active: true,
                verified: true,
            },
            "_id fullName email photo",
        );

        sendResponse(res, 200, "User fetched by id", users);
    },
);

export const getUserById = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { userId } = req.params;

        const users = await UserModel.findById(
            userId,
            "_id fullName email photo createdAt role assignedCoach",
        ).populate("assignedCoach");

        sendResponse(res, 200, "User fetched by id", users);
    },
);

export const suggestUsers = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const currentUser = req.user;
        const { search = "", type = "group" } = req.query;

        const allowedUsers: string[] = [
            ...currentUser.sharedViewers.map(String),
            ...(currentUser.assignedCoach ?? []).map(String),
        ];

        if (type === "group") {
            const users = await UserModel.find({
                _id: { $in: allowedUsers, $ne: currentUser?._id },
                active: true,
                verified: true,
                email: { $regex: search, $options: "i" },
            })
                .select(["fullName", "photo", "email", "role"])
                .limit(5);

            sendResponse(res, 200, "Suggestions fetched", users);
        } else {
            const users = await UserModel.find({
                _id: { $ne: currentUser?._id, $nin: allowedUsers },
                active: true,
                verified: true,
                email: { $regex: search, $options: "i" },
            })
                .select(["fullName", "photo", "email", "role"])
                .limit(5);

            sendResponse(res, 200, "Suggestions fetched", users);
        }
    },
);

export const addWatchersByLink = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { shareId } = req.params;
        const currentUserId = req.user._id; // must be authenticated

        const sharer = await UserModel.findOne({
            shareId,
            active: true,
            verified: true,
            _id: {
                $ne: currentUserId,
            },
        });
        if (!sharer) throw new AppError("Invalid or inactive share link", 400);

        // If viewer doesn’t exist in sharedViewers, add them
        if (!sharer.sharedViewers.includes(currentUserId)) {
            sharer.sharedViewers.push(currentUserId);
            await sharer.save();
        }

        await createDirectChatIfNotExists(
            sharer._id,
            currentUserId,
            sharer._id,
        );

        delete sharer._id;
        delete sharer.id;
        delete sharer.password;

        sendResponse(res, 200, "Access Granted", sharer);
    },
);

export const addWatchersById = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { userIds } = req.body;
        const currentUser = req.user?._id;

        await UserModel.findByIdAndUpdate(currentUser, {
            $addToSet: { sharedViewers: { $each: userIds } },
        });

        await Promise.all(
            userIds.map((id: string) =>
                createDirectChatIfNotExists(
                    currentUser,
                    new mongoose.Types.ObjectId(id),
                    currentUser,
                ),
            ),
        );

        sendResponse(res, 200, "Watchers added successfully!");
    },
);

export const revokeViewerAccess = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const sharer = await UserModel.findById(req.user._id);
        if (!sharer) throw new AppError("User not found", 404);

        sharer.sharedViewers = sharer.sharedViewers.filter(
            (v) => v.toString() !== req.params.viewerId,
        );

        await sharer.save();

        await ChatModel.findOneAndDelete({
            type: "direct",
            createdBy: sharer._id,
            "members.user": req.params.viewerId,
        });

        sendResponse(res, 200, "Access revoked successfully");
    },
);

export const getAllWatching = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;

        const users = await UserModel.find({
            sharedViewers: userId,
            active: true,
        }).select(["shareId", "fullName", "photo"]);

        sendResponse(res, 200, "Watching fetched", users);
    },
);

export const getUsers = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const requesterId = req.user?._id;
        const role = req.user.role;

        const search = (req.query.search || "").toString().trim();
        const page = Math.max(parseInt(req.query.page.toString() || "1"), 1);
        const limit = 10;
        const skip = (page - 1) * limit;

        const searchFilter =
            search.length > 0
                ? {
                      $or: [
                          { fullName: { $regex: search, $options: "i" } },
                          { email: { $regex: search, $options: "i" } },
                      ],
                  }
                : {};

        const pipeline: any[] = [];

        /**
         * ✅ Admin: fetch everyone (flat)
         */
        if (role === "admin") {
            pipeline.push({
                $match: {
                    verified: true,
                    active: true,
                },
            });
            // no restriction
        } else if (role === "manager") {
            /**
             * ✅ Manager: fetch
             * - coaches where assignedCoach contains managerId
             * - users where assignedCoach contains any coachId under this manager
             */
            pipeline.push(
                {
                    $match: {
                        _id: requesterId, // ✅ anchor on manager only
                        active: true,
                    },
                },
                {
                    $graphLookup: {
                        from: "users",
                        startWith: "$_id",
                        connectFromField: "_id",
                        connectToField: "assignedCoach",
                        as: "downline",
                        maxDepth: 2,
                        depthField: "depth",
                        restrictSearchWithMatch: {
                            verified: true,
                            active: true,
                            role: { $in: ["coach", "user"] }, // only want these in downline
                        },
                    },
                },
                {
                    $project: {
                        downline: 1,
                    },
                },
                {
                    $unwind: "$downline",
                },
                {
                    $replaceRoot: {
                        newRoot: "$downline",
                    },
                },
            );
        } else if (role === "coach") {
            /**
             * ✅ Coach: fetch users assigned to this coach
             */
            pipeline.push({
                $match: {
                    role: "user",
                    assignedCoach: requesterId,
                    active: true,
                },
            });
        } else {
            /**
             * ✅ User: return self only (or empty - your call)
             */
            pipeline.push({
                $match: { _id: requesterId, active: true },
            });
        }

        // ✅ Apply search after role filtering
        if (Object.keys(searchFilter).length) {
            pipeline.push({ $match: searchFilter });
        }

        pipeline.push({
            $lookup: {
                from: "users",
                localField: "assignedCoach",
                foreignField: "_id",
                as: "assignedCoach",
                pipeline: [
                    {
                        $project: {
                            password: 0,
                            otp: 0,
                            otpExpires: 0,
                            passwordResetToken: 0,
                            passwordResetExpires: 0,
                            fcmToken: 0,
                            __v: 0,
                        },
                    },
                ],
            },
        });

        // ✅ Remove sensitive fields
        pipeline.push({
            $project: {
                password: 0,
                otp: 0,
                otpExpires: 0,
                passwordResetToken: 0,
                passwordResetExpires: 0,
                __v: 0,
            },
        });

        // ✅ Pagination + total count (same call)
        pipeline.push(
            {
                $facet: {
                    data: [
                        { $sort: { createdAt: -1 } },
                        { $skip: skip },
                        { $limit: limit },
                    ],
                    meta: [{ $count: "total" }],
                },
            },
            {
                $addFields: {
                    meta: {
                        $let: {
                            vars: {
                                total: {
                                    $ifNull: [
                                        { $arrayElemAt: ["$meta.total", 0] },
                                        0,
                                    ],
                                },
                            },
                            in: {
                                totalCount: "$$total",
                                currentPage: page,
                                limit,
                                totalPages: {
                                    $ceil: { $divide: ["$$total", limit] },
                                },
                            },
                        },
                    },
                },
            },
        );

        const result = await UserModel.aggregate(pipeline);

        sendResponse(res, 200, "Users fetched", {
            data: result?.[0]?.data || [],
            meta: result?.[0]?.meta || { total: 0, page, limit, totalPages: 0 },
        });
    },
);

const allowedCreateMap = {
    admin: ["admin", "manager", "coach", "user"],
    manager: ["coach", "user"],
    coach: ["user"],
    user: [],
};

type Role = "admin" | "manager" | "coach" | "user";

const normalizeIds = (ids: string[]) =>
    ids.map((id) => mongoose.Types.ObjectId.createFromHexString(id));

export const createUserByHierarchy = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const requesterId = req.user?._id;
        const requesterRole = req.user?.role;

        const {
            name: fullName,
            email,
            role,
            assignedCoach,
        } = req.body as {
            name: string;
            email: string;
            role: "admin" | "manager" | "coach" | "user";
            assignedCoach?: string[];
        };

        // ✅ Required fields
        if (!fullName || !email || !role) {
            throw new AppError("fullName, email and role are required", 400);
        }

        // ✅ Permission check
        const canCreate = allowedCreateMap[requesterRole]?.includes(role);
        if (!canCreate) {
            throw new AppError(
                `You are not allowed to create role: ${role}`,
                403,
            );
        }

        // ✅ Prevent duplicate email
        const existing = await UserModel.findOne({
            email: email.toLowerCase(),
            active: true,
        });
        if (existing) {
            throw new AppError("Email already exists", 409);
        }

        let finalAssignedCoach: mongoose.Types.ObjectId[] = [];

        /**
         * ✅ AUTO + REQUIRED ASSIGNMENT RULES
         */

        // ✅ MANAGER -> COACH (auto assign to that manager)
        if (requesterRole === "manager" && role === "coach") {
            finalAssignedCoach = [requesterId];
        }

        // ✅ COACH -> USER (auto assign to that coach)
        else if (requesterRole === "coach" && role === "user") {
            finalAssignedCoach = [requesterId];
        }

        // ✅ MANAGER -> USER (must provide coachId(s))
        else if (requesterRole === "manager" && role === "user") {
            if (!assignedCoach?.length) {
                throw new AppError(
                    "assignedCoach (coachId) is required when manager creates a user",
                    400,
                );
            }

            finalAssignedCoach = normalizeIds(assignedCoach);
        }

        // ✅ ADMIN -> COACH (MUST provide managerId) ✅ OPTION 2 ENFORCED
        else if (requesterRole === "admin" && role === "coach") {
            if (!assignedCoach?.length) {
                throw new AppError(
                    "assignedCoach (managerId) is required when admin creates a coach",
                    400,
                );
            }

            finalAssignedCoach = normalizeIds(assignedCoach);
        }

        // ✅ ADMIN -> USER (must provide coachId(s))
        else if (requesterRole === "admin" && role === "user") {
            if (!assignedCoach?.length) {
                throw new AppError(
                    "assignedCoach (coachId) is required when admin creates a user",
                    400,
                );
            }

            finalAssignedCoach = normalizeIds(assignedCoach);
        }

        // ✅ ADMIN -> MANAGER (optional: can be assigned to admin(s), but not required)
        else if (requesterRole === "admin" && role === "manager") {
            if (assignedCoach?.length) {
                finalAssignedCoach = normalizeIds(assignedCoach);
                console.log(finalAssignedCoach);
            }
        }

        // ✅ ADMIN -> ADMIN (no assignment)
        else if (requesterRole === "admin" && role === "admin") {
            finalAssignedCoach = [];
        }

        // ✅ MANAGER -> MANAGER (optional)
        else if (requesterRole === "manager" && role === "manager") {
            if (assignedCoach?.length) {
                finalAssignedCoach = normalizeIds(assignedCoach);
            }
        }

        /**
         * ✅ STRICT VALIDATION: assignedTo must match correct parent role
         */

        // ROLE user => assignedCoach must contain ONLY coaches
        if (role === "user") {
            const count = await UserModel.countDocuments({
                _id: { $in: finalAssignedCoach },
                role: "coach",
                active: true,
            });

            if (count !== finalAssignedCoach.length) {
                throw new AppError(
                    "assignedTo must contain valid coach id(s) only",
                    400,
                );
            }
        }

        // ROLE coach => assignedCoach must contain ONLY managers
        if (role === "coach") {
            const count = await UserModel.countDocuments({
                _id: { $in: finalAssignedCoach },
                role: "manager",
                active: true,
            });

            if (count !== finalAssignedCoach.length) {
                throw new AppError(
                    "assignedTo must contain valid manager id(s) only",
                    400,
                );
            }
        }

        // ROLE manager => if provided, assignedCoach must contain ONLY admins
        if (role === "manager" && finalAssignedCoach.length) {
            const count = await UserModel.countDocuments({
                _id: { $in: finalAssignedCoach },
                role: "admin",
                active: true,
            });

            if (count !== finalAssignedCoach.length) {
                throw new AppError(
                    "assignedTo must contain valid admin id(s) only",
                    400,
                );
            }
        }

        function generateHumanPassword() {
            const words1 = [
                "Blue",
                "Red",
                "Green",
                "Silver",
                "Golden",
                "Black",
                "White",
            ];
            const words2 = [
                "Tiger",
                "Falcon",
                "Panther",
                "Lion",
                "Wolf",
                "Eagle",
                "Shark",
            ];
            const symbols = ["@", "#", "!", "$", "%", "&"];

            const w1 = words1[crypto.randomInt(0, words1.length)];
            const w2 = words2[crypto.randomInt(0, words2.length)];
            const sym = symbols[crypto.randomInt(0, symbols.length)];
            const num = crypto.randomInt(1000, 9999); // 4 digits

            return `${w1}${w2}${sym}${num}`;
        }

        const password = generateHumanPassword();

        try {
            await sendEmail({
                email,
                subject: "Welcome to Coachiatry",
                html: WELCOME_EMAIL_HTML_WITH_PASSWORD(fullName, password),
            });
        } catch (err) {
            console.warn("Failed to send welcome email:", err);
        }

        // ✅ Create user
        const created = await UserModel.create({
            fullName,
            email: email.toLowerCase(),
            role,
            assignedCoach: finalAssignedCoach, // mapping assignedTo -> assignedCoach
            verified: true,
            active: true,
            password,
        });

        if (finalAssignedCoach.length) {
            await Promise.all(
                finalAssignedCoach.map((coachId) =>
                    createDirectChatIfNotExists(
                        created._id,
                        coachId,
                        requesterId,
                    ),
                ),
            );
        }

        if (role === "admin") {
            // New admin → create direct chats with all existing users
            const allUsers = await UserModel.find({
                active: true,
                _id: { $ne: created._id },
            }).select("_id");
            await Promise.all(
                allUsers.map((user) =>
                    createDirectChatIfNotExists(
                        created._id,
                        user._id,
                        requesterId,
                    ),
                ),
            );
        } else {
            // Non-admin → create direct chats with all admins
            const admins = await UserModel.find({
                role: "admin",
                active: true,
            }).select("_id");
            await Promise.all(
                admins.map((admin) =>
                    createDirectChatIfNotExists(
                        created._id,
                        admin._id,
                        requesterId,
                    ),
                ),
            );
        }

        sendResponse(res, 201, "User created successfully", created);
    },
);

export const updateUserByHierarchy = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const requesterId = req.user._id;
        const requesterRole: Role = req.user.role;

        const targetUserId = mongoose.Types.ObjectId.createFromHexString(
            req.params.id,
        );

        const { fullName, email, role, assignedCoach } = req.body as {
            fullName?: string;
            email?: string;
            role?: Role;
            assignedCoach?: string[];
        };

        // ✅ Load target user (we need role + assignedCoach for validation)
        const targetUser =
            await UserModel.findById(targetUserId).select("+password");
        if (!targetUser) {
            throw new AppError("User not found", 404);
        }

        /**
         * ✅ Permission checks (WHO can edit WHO)
         */

        // Admin can edit anyone ✅
        if (requesterRole === "admin") {
            // allowed
        }

        // Manager rules
        else if (requesterRole === "manager") {
            // Manager can edit:
            // 1) coach where coach.assignedCoach includes managerId
            // 2) user assigned to coach under manager

            // If target is coach: must be under this manager
            if (targetUser.role === "coach") {
                const isUnderManager =
                    Array.isArray(targetUser.assignedCoach) &&
                    targetUser.assignedCoach.some(
                        (id) => id.toString() === requesterId.toString(),
                    );

                if (!isUnderManager) {
                    throw new AppError(
                        "You can only edit coaches under you",
                        403,
                    );
                }
            }

            // If target is user: must be under one of manager coaches
            else if (targetUser.role === "user") {
                const managerCoachIds = await UserModel.find({
                    role: "coach",
                    assignedCoach: requesterId,
                    active: true,
                }).select("_id");

                const coachIdList = managerCoachIds.map((c) =>
                    c._id.toString(),
                );

                const isUnderManager =
                    Array.isArray(targetUser.assignedCoach) &&
                    targetUser.assignedCoach.some((cid) =>
                        coachIdList.includes(cid.toString()),
                    );

                if (!isUnderManager) {
                    throw new AppError(
                        "You can only edit users under your coaches",
                        403,
                    );
                }
            } else {
                throw new AppError(
                    "Managers can only edit coaches and users under them",
                    403,
                );
            }
        }

        // Coach rules
        else if (requesterRole === "coach") {
            if (targetUser.role !== "user") {
                throw new AppError("Coach can only edit users/patients", 403);
            }

            const isMine =
                Array.isArray(targetUser.assignedCoach) &&
                targetUser.assignedCoach.some(
                    (id) => id.toString() === requesterId.toString(),
                );

            if (!isMine) {
                throw new AppError(
                    "You can only edit your assigned users",
                    403,
                );
            }
        }

        // Normal user
        else {
            // either block all edits OR allow self-edit only
            const isSelf = targetUser._id.toString() === requesterId.toString();
            if (!isSelf) {
                throw new AppError(
                    "You are not allowed to edit this user",
                    403,
                );
            }
        }

        /**
         * ✅ Role change rules
         */
        const previousRole = targetUser.role;
        if (role && role !== targetUser.role) {
            if (requesterRole !== "admin") {
                throw new AppError("Only admin can change user roles", 403);
            }
            targetUser.role = role;
        }

        /**
         * ✅ Update fields (safe)
         */
        if (fullName) targetUser.fullName = fullName;
        if (email) targetUser.email = email.toLowerCase();

        /**
         * ✅ Assignment update logic (assignedTo => assignedCoach)
         */
        if (assignedCoach) {
            const newAssigned: mongoose.Types.ObjectId[] =
                normalizeIds(assignedCoach);

            // ✅ If manager is editing a coach: enforce self assignment only (cannot move coach to another manager)
            if (requesterRole === "manager" && targetUser.role === "coach") {
                targetUser.assignedCoach = [requesterId];
            }

            // ✅ If coach is editing a user: enforce self assignment only
            else if (requesterRole === "coach" && targetUser.role === "user") {
                targetUser.assignedCoach = [requesterId];
            }

            // ✅ Admin rules
            else if (requesterRole === "admin") {
                // user must be assigned to coach
                if (targetUser.role === "user") {
                    const coachCount = await UserModel.countDocuments({
                        _id: { $in: newAssigned },
                        role: "coach",
                        active: true,
                    });

                    if (coachCount !== newAssigned.length) {
                        throw new AppError(
                            "assignedTo must contain valid coach id(s) only",
                            400,
                        );
                    }

                    targetUser.assignedCoach = newAssigned;
                }

                // coach must be assigned to manager (mandatory)
                else if (targetUser.role === "coach") {
                    if (!newAssigned.length) {
                        throw new AppError(
                            "Coach must be assigned to a manager",
                            400,
                        );
                    }

                    const managerCount = await UserModel.countDocuments({
                        _id: { $in: newAssigned },
                        role: "manager",
                        active: true,
                    });

                    if (managerCount !== newAssigned.length) {
                        throw new AppError(
                            "assignedTo must contain valid manager id(s) only",
                            400,
                        );
                    }

                    targetUser.assignedCoach = newAssigned;
                }

                // manager can be assigned to admin (optional)
                else if (targetUser.role === "manager") {
                    if (!newAssigned.length) {
                        targetUser.assignedCoach = [];
                    } else {
                        const adminCount = await UserModel.countDocuments({
                            _id: { $in: newAssigned },
                            role: "admin",
                            active: true,
                        });

                        if (adminCount !== newAssigned.length) {
                            throw new AppError(
                                "assignedTo must contain valid admin id(s) only",
                                400,
                            );
                        }

                        targetUser.assignedCoach = newAssigned;
                    }
                }
            }

            // ✅ Manager editing a user: can only assign to his own coaches
            else if (
                requesterRole === "manager" &&
                targetUser.role === "user"
            ) {
                const allowedCoachIds = await UserModel.find({
                    role: "coach",
                    assignedCoach: requesterId,
                    active: true,
                }).select("_id");

                const allowedSet = new Set(
                    allowedCoachIds.map((c) => c._id.toString()),
                );

                const allAreAllowed = newAssigned.every((id) =>
                    allowedSet.has(id.toString()),
                );

                if (!allAreAllowed) {
                    throw new AppError(
                        "You can only assign users to coaches under you",
                        403,
                    );
                }

                targetUser.assignedCoach = newAssigned;
            }
        }

        // ✅ Save
        await targetUser.save();

        // ✅ Return updated user
        const updated = await UserModel.findById(targetUser._id).select(
            "-password -otp -otpExpires -passwordResetToken -passwordResetExpires -__v",
        );

        if (targetUser.assignedCoach.length) {
            await Promise.all(
                targetUser.assignedCoach.map((coachId) =>
                    createDirectChatIfNotExists(
                        targetUser._id,
                        coachId,
                        requesterId,
                    ),
                ),
            );
        }

        // On role change, ensure admin chatrooms exist
        if (role && role !== previousRole) {
            if (role === "admin") {
                // Became admin → create chats with all users (including other admins)
                const allUsers = await UserModel.find({
                    active: true,
                    _id: { $ne: targetUser._id },
                }).select("_id");
                await Promise.all(
                    allUsers.map((user) =>
                        createDirectChatIfNotExists(
                            targetUser._id,
                            user._id,
                            requesterId,
                        ),
                    ),
                );
            } else {
                // Role changed to non-admin → ensure chats with all admins
                const admins = await UserModel.find({
                    role: "admin",
                    active: true,
                }).select("_id");
                await Promise.all(
                    admins.map((admin) =>
                        createDirectChatIfNotExists(
                            targetUser._id,
                            admin._id,
                            requesterId,
                        ),
                    ),
                );
            }
        }

        sendResponse(res, 200, "User updated successfully", updated);
    },
);

export const deleteUserSoft = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const requesterRole = req.user.role;
        const requesterId = req.user._id;
        const targetId = mongoose.Types.ObjectId.createFromHexString(
            req.params.id,
        );

        // ❌ prevent self delete if you want
        if (requesterId.toString() === targetId.toString()) {
            throw new AppError("You cannot deactivate your own account", 400);
        }

        // Build role-based filter
        let matchFilter: any = {
            _id: targetId,
            active: true, // only deactivate active accounts
        };

        /**
         * ✅ ADMIN: can deactivate anyone
         */
        if (requesterRole === "admin") {
            // no extra restrictions
        } else if (requesterRole === "manager") {
            /**
             * ✅ MANAGER:
             * - can deactivate coach under him (coach.assignedCoach includes managerId)
             * - can deactivate user under his coaches (user.assignedCoach includes coachId under him)
             */
            matchFilter = {
                ...matchFilter,
                $or: [
                    // deactivate coach under me
                    {
                        role: "coach",
                        assignedCoach: requesterId,
                    },
                    // deactivate users under my coaches:
                    // user.assignedCoach includes any coach whose assignedCoach includes managerId
                    {
                        role: "user",
                        assignedCoach: {
                            $in: await UserModel.find({
                                role: "coach",
                                assignedCoach: requesterId,
                                active: true,
                            }).distinct("_id"),
                        },
                    },
                ],
            };
        } else if (requesterRole === "coach") {
            /**
             * ✅ COACH: can deactivate only their users
             */
            matchFilter = {
                ...matchFilter,
                role: "user",
                assignedCoach: requesterId,
            };
        } else {
            /**
             * ❌ USER: cannot deactivate anyone
             */
            throw new AppError("You are not allowed to deactivate users", 403);
        }

        // ✅ Soft delete (set active:false)
        const updated = await UserModel.findOneAndUpdate(
            matchFilter,
            { $set: { active: false } },
            { new: true },
        ).select(
            "-password -otp -otpExpires -passwordResetToken -passwordResetExpires -__v",
        );

        if (!updated) {
            throw new AppError(
                "Not allowed or user not found/already inactive",
                403,
            );
        }

        sendResponse(res, 200, "User removed successfully", updated);
    },
);
