import { NextFunction, Request, Response } from "express";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import { sendResponse } from "../utils/response";
import StatusModel from "../model/statusModel";
import TaskModel from "../model/taskModel";

export const deleteStatus = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { replacementStatusId } = req.body;

        const status = await StatusModel.findById(id);
        if (!status) {
            return next(new AppError("Status not found", 404));
        }

        const taskCount = await TaskModel.countDocuments({ status: id });

        if (taskCount > 0) {
            if (!replacementStatusId) {
                return res.status(200).json({
                    status: "requires_replacement",
                    taskCount,
                    message: `${taskCount} task(s) use this status. Provide a replacement status.`,
                });
            }

            const replacement = await StatusModel.findById(replacementStatusId);
            if (!replacement) {
                return next(new AppError("Replacement status not found", 404));
            }

            await TaskModel.updateMany(
                { status: id },
                { status: replacementStatusId },
            );
        }

        await StatusModel.findByIdAndDelete(id);
        sendResponse(res, 200, "Status deleted successfully", null);
    },
);
