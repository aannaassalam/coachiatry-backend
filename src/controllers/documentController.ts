import { NextFunction, Request, Response } from "express";
import DocumentModel from "../model/documentModel";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import APIFeatures from "../utils/apiFeatures";

export const getAllDocuments = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        let filter = {};
        const { tab = "all" } = req.query;
        const userId = req.user._id;

        if (tab === "all") {
            filter = {
                $or: [{ user: userId }, { sharedWith: userId }],
            };
        }
        if (tab === "my-docs") {
            filter = {
                user: userId,
            };
        }
        if (tab === "shared") {
            filter = { sharedWith: userId };
        }

        const features = new APIFeatures(
            DocumentModel.find(filter),
            req.query as any
        )
            .sort()
            .limitFields()
            .paginate()
            .search()
            .populate();
        await features.calculateTotalCount();
        const doc = await features.query;

        const totalPages = Math.ceil(features.totalCount / features.limit);
        const currentPage = parseInt(req.query.page as string, 10) || 1;

        const responseData = {
            data: doc,
            meta: {
                results: doc.length,
                limit: features.limit,
                currentPage,
                totalPages,
                totalCount: features.totalCount,
            },
        };

        sendResponse(
            res,
            200,
            "Documents retrieved successfully",
            responseData
        );
    }
);

export const getAllDocumentsByCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        let filter = {};
        const { tab = "all" } = req.query;
        const userId = req.query.userId;

        if (tab === "all") {
            filter = {
                $or: [{ user: userId }, { sharedWith: userId }],
            };
        }
        if (tab === "my-docs") {
            filter = {
                user: userId,
            };
        }
        if (tab === "shared") {
            filter = { sharedWith: userId };
        }

        const features = new APIFeatures(
            DocumentModel.find(filter),
            req.query as any
        )
            .sort()
            .limitFields()
            .paginate()
            .search()
            .populate();
        await features.calculateTotalCount();
        const doc = await features.query;

        const totalPages = Math.ceil(features.totalCount / features.limit);
        const currentPage = parseInt(req.query.page as string, 10) || 1;

        const responseData = {
            data: doc,
            meta: {
                results: doc.length,
                limit: features.limit,
                currentPage,
                totalPages,
                totalCount: features.totalCount,
            },
        };

        sendResponse(
            res,
            200,
            "Documents retrieved successfully",
            responseData
        );
    }
);

export const accessSharedDocument = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { shareId } = req.params;
        const userId = req.user._id; // user must be logged in

        const document = await DocumentModel.findOne({
            shareId,
            user: { $ne: userId },
        });
        if (!document) throw new AppError("Invalid share link", 404);

        // Add this user to sharedWith if not already added
        if (!document.sharedWith.includes(userId)) {
            document.sharedWith.push(userId);
            await document.save();
        }

        sendResponse(res, 200, "Access Granted", document);
    }
);
