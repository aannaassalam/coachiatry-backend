import { Request, Response } from "express";
import catchAsync from "./catchAsync";
import {
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from "@aws-sdk/client-s3";
import { sendResponse } from "./response";
import { MulterFile } from "multer";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
declare global {
    namespace Express {
        interface Request {
            file?: MulterFile;
        }
    }
}
// aws setup
// AWS setup with proper type casting to ensure non-undefined credentials
const s3 = new S3Client({
    region: process.env.AWS_REGION as string, // Ensuring that the region is of type string
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string, // Casting to string to avoid the undefined error
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string, // Casting to string to avoid the undefined error
    },
});
const publicBucketName = process.env.AWS_BUCKET_NAME; // Specify your bucket name

const generateUniqueId = (): string => {
    const characters =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const timestamp = Date.now().toString();
    const randomCharsLength = 10;
    const halfLength = Math.floor((randomCharsLength - timestamp.length) / 2);

    const randomChars1 = Array.from(
        { length: halfLength },
        () => characters[Math.floor(Math.random() * characters.length)]
    ).join("");
    const randomChars2 = Array.from(
        { length: randomCharsLength - halfLength - timestamp.length },
        () => characters[Math.floor(Math.random() * characters.length)]
    ).join("");

    return randomChars1 + timestamp + randomChars2;
};

export const uploadDocumentToPublicAWS = catchAsync(
    async (req: Request, res: Response) => {
        try {
            // Ensure file is available

            if (!req.file) {
                return res
                    .status(400)
                    .json({ success: false, error: "No file uploaded" });
            }

            // Extract file from request body
            const file = req.file;
            //change file name to a unique name using uuid
            const fileName = `${generateUniqueId()}-${file.originalname}`;
            // Upload file to S3 bucket
            const params = {
                Bucket: publicBucketName, // Replace with your bucket name
                Key: fileName,
                Body: file.buffer,
                // ACL: 'public-read'
            };

            const command = new PutObjectCommand(params);

            await s3.send(command);
            // get public url for the uploaded file
            const url = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;
            sendResponse(res, 200, "Document uploaded successfully", { url });
        } catch (error) {
            console.error("Error uploading document:", error);
            res.status(500).json({
                success: false,
                error: "Failed to upload document",
            });
        }
    }
);

export const uploadAnyDocument = async (
    fileBuffer: Uint8Array<ArrayBufferLike>,
    fileName: string
) => {
    // Upload file to S3 bucket
    const params = {
        Bucket: publicBucketName, // Replace with your bucket name
        Key: `documents/${fileName}`,
        Body: fileBuffer,
    };

    const command = new PutObjectCommand(params);

    await s3.send(command);
    // get public url for the uploaded file
    const url = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/documents/${encodeURIComponent(fileName)}`;
    return url;
};

export async function deleteS3File(url: string) {
    try {
        const key = url.replace(
            `https://${publicBucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/`,
            ""
        );

        const command = new DeleteObjectCommand({
            Bucket: publicBucketName,
            Key: key,
        });

        await s3.send(command);
        console.log(`🗑️ Deleted: s3://${publicBucketName}/${key}`);
        return true;
    } catch (error) {
        console.error("❌ Failed to delete file from S3:", error);
        return false;
    }
}

export const startMultipartUpload = async ({
    fileName,
    fileType,
    path,
}: {
    fileName: string;
    fileType: string;
    path: string;
}) => {
    const command = new CreateMultipartUploadCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `${path}/${fileName}`,
        ContentType: fileType,
        ACL: "public-read",
    });

    const { UploadId, Key } = await s3.send(command);
    return { uploadId: UploadId, key: Key };
};

// 2️⃣ Get pre-signed URLs for each part
export const multiPartUrls = async ({
    uploadId,
    key,
    parts,
}: {
    uploadId: string;
    key: string;
    parts: any[];
}) => {
    const urls = await Promise.all(
        parts.map(async (partNumber) => {
            const command = new UploadPartCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
            });
            const signedUrl = await getSignedUrl(s3, command, {
                expiresIn: 600,
            }); // 10 mins
            return { partNumber, signedUrl };
        })
    );

    return urls;
};

// 3️⃣ Complete upload
export const multipartComplete = async ({
    uploadId,
    key,
    parts,
}: {
    uploadId: string;
    key: string;
    parts: any[];
}) => {
    const command = new CompleteMultipartUploadCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
    });

    await s3.send(command);
    const fileURL = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    return fileURL;
};
