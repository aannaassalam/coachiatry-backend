import { NextFunction, Request, Response } from "express";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import { sendResponse } from "../utils/response";
import CategoryModel from "../model/categoryModel";
import TaskModel from "../model/taskModel";

export const deleteCategory = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { replacementCategoryId } = req.body;

        const category = await CategoryModel.findById(id);
        if (!category) {
            return next(new AppError("Category not found", 404));
        }

        const taskCount = await TaskModel.countDocuments({ category: id });

        if (taskCount > 0) {
            if (!replacementCategoryId) {
                return res.status(200).json({
                    status: "requires_replacement",
                    taskCount,
                    message: `${taskCount} task(s) use this category. Provide a replacement category.`,
                });
            }

            const replacement = await CategoryModel.findById(replacementCategoryId);
            if (!replacement) {
                return next(new AppError("Replacement category not found", 404));
            }

            await TaskModel.updateMany(
                { category: id },
                { category: replacementCategoryId },
            );
        }

        await CategoryModel.findByIdAndDelete(id);
        sendResponse(res, 200, "Category deleted successfully", null);
    },
);
