import { Request, Response, NextFunction } from "express";
import catchAsync from "../utils/catchAsync";
import UserModel from "../model/userModel";
import { sendResponse } from "../utils/response";

export const getClients = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const currentUserId = req.user._id;
        const clients = await UserModel.find({
            assignedCoach: currentUserId,
        });
        sendResponse(res, 200, "Clients fetched successfully", clients);
    }
);
