import { NextFunction, Request, Response } from "express";
import catchAsync from "../utils/catchAsync";
import DocumentModel from "../model/documentModel";
import { sendResponse } from "../utils/response";
import { generateMarkdownPDF } from "../utils";
import AppError from "../utils/appError";
import { deleteS3File } from "../utils/aws";

export const addDocument = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const body = req.body;
        body.user = req.user._id;
        const doc = await DocumentModel.create(body);

        const url = await generateMarkdownPDF(
            doc.content,
            doc.title,
            "Technology"
        );

        doc.documentUrl = url;
        await doc.save({ validateBeforeSave: true });

        sendResponse(res, 201, "Document created successfully", doc);
    }
);

export const updateDocument = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await DocumentModel.findByIdAndUpdate(
            req.params.id,
            req.body,
            {
                new: true,
                runValidators: true,
            }
        );
        if (!doc) {
            return next(
                new AppError(
                    `No ${DocumentModel.modelName} found with that ID`,
                    404
                )
            );
        }

        if (doc.documentUrl) {
            await deleteS3File(doc.documentUrl);
        }

        const url = await generateMarkdownPDF(
            doc.content,
            doc.title,
            "Technology"
        );

        doc.documentUrl = url;
        await doc.save({ validateBeforeSave: false });

        sendResponse(res, 201, "Document updated successfully", doc);
    }
);
