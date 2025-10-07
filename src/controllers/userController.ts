import { NextFunction, Request, Response } from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import catchAsync from "../utils/catchAsync";
import UserModel from "../model/userModel";
import { sendResponse } from "../utils/response";

// Initialize S3 client
const s3 = new S3Client({
    region: process.env.AWS_REGION as string, // Ensuring that the region is of type string
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, // Casting to string to avoid the undefined error
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string, // Casting to string to avoid the undefined error
    },
});
const publicBucketName = process.env.AWS_BUCKET_NAME || "";

// Helper to generate unique IDs
function generateUniqueId() {
    return uuidv4();
}

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
