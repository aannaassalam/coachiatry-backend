import { Request, Response, NextFunction } from "express";
import catchAsync from "../utils/catchAsync";
import UserModel from "../model/userModel";
import { sendResponse } from "../utils/response";

export const getClients = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const currentUserId = req.user._id;
        const clients = await UserModel.find({
            assignedCoach: currentUserId,
        })
            // A→Z by name, case-insensitive (so "alice" and "Bob" order naturally)
            .collation({ locale: "en", strength: 2 })
            .sort({ fullName: 1 });
        sendResponse(res, 200, "Clients fetched successfully", clients);
    },
);
