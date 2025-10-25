import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextFunction, Request, Response } from "express";
import UserModel from "../model/userModel";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import AppError from "../utils/appError";
import ChatModel from "../model/chatModel";

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
    }
);

export const getUsersById = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { ids } = req.query;

        const users = await UserModel.find(
            {
                _id: {
                    $in: ids,
                },
            },
            "_id fullName email photo"
        );

        sendResponse(res, 200, "User fetched by id", users);
    }
);

export const getUserById = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { userId } = req.params;

        const users = await UserModel.findById(
            userId,
            "_id fullName email photo createdAt"
        );

        sendResponse(res, 200, "User fetched by id", users);
    }
);

export const suggestUsers = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const currentUserId = req.user?._id;
        const { search = "" } = req.query;

        const users = await UserModel.find({
            _id: { $ne: currentUserId },
            email: { $regex: search, $options: "i" },
        })
            .select(["fullName", "photo", "email"])
            .limit(5);

        sendResponse(res, 200, "Suggestions fetched", users);
    }
);

export const addWatchersByLink = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { shareId } = req.params;
        const currentUserId = req.user._id; // must be authenticated

        const sharer = await UserModel.findOne({
            shareId,
            _id: {
                $ne: currentUserId,
            },
        });
        if (!sharer) throw new AppError("Invalid or inactive share link", 400);

        // If viewer doesn’t exist in sharedViewers, add them
        if (!sharer.sharedViewers.includes(currentUserId)) {
            sharer.sharedViewers.push(currentUserId);
            await sharer.save();

            await ChatModel.create({
                members: [
                    { user: sharer._id, role: "member" },
                    { user: currentUserId, role: "member" },
                ],
                type: "direct",
                createdBy: sharer._id,
            });
        }

        delete sharer._id;
        delete sharer.id;
        delete sharer.password;

        sendResponse(res, 200, "Access Granted", sharer);
    }
);

export const addWatchersById = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { userIds } = req.body;
        const currentUser = req.user?._id;

        await UserModel.findByIdAndUpdate(currentUser, {
            $addToSet: { sharedViewers: { $each: userIds } },
        });

        await ChatModel.insertMany(
            userIds.map((id: string) => ({
                members: [
                    { user: currentUser, role: "member" },
                    { user: id, role: "member" },
                ],
                type: "direct",
                createdBy: currentUser,
            }))
        );

        sendResponse(res, 200, "Watchers added successfully!");
    }
);

export const revokeViewerAccess = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const sharer = await UserModel.findById(req.user._id);
        if (!sharer) throw new AppError("User not found", 404);

        sharer.sharedViewers = sharer.sharedViewers.filter(
            (v) => v.toString() !== req.params.viewerId
        );

        await sharer.save();

        await ChatModel.findOneAndDelete({
            type: "direct",
            createdBy: sharer._id,
            "members.user": req.params.viewerId,
        });

        sendResponse(res, 200, "Access revoked successfully");
    }
);

export const getAllWatching = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;

        const users = await UserModel.find({ sharedViewers: userId }).select([
            "shareId",
            "fullName",
            "photo",
        ]);

        sendResponse(res, 200, "Watching fetched", users);
    }
);
