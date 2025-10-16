import { NextFunction, Request, Response } from "express";
import Task from "../model/taskModel";
import catchAsync from "../utils/catchAsync";
import APIFeatures from "../utils/apiFeatures";
import TaskModel from "../model/taskModel";
import { sendResponse } from "../utils/response";
import UserModel from "../model/userModel";
import AppError from "../utils/appError";

export const updateTaskStatus = catchAsync(
    async (req: Request, res: Response) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            const task = await Task.findByIdAndUpdate(id, { status });

            if (!task) {
                return res.status(404).json({ message: "Task not found" });
            }

            res.json(task);
        } catch (error) {
            res.status(500).json({
                message: "Error updating task status",
                error,
            });
        }
    }
);

export const updateSubtaskStatus = catchAsync(
    async (req: Request, res: Response) => {
        try {
            const { task_id, subtask_id } = req.params;

            // Find the task and subtask first to get current completed value
            const task = await Task.findOne(
                { _id: task_id, "subtasks._id": subtask_id },
                { "subtasks.$": 1 }
            );

            if (!task || !task.subtasks || task.subtasks.length === 0) {
                return res
                    .status(404)
                    .json({ message: "Task or subtask not found" });
            }

            const currentCompleted = task.subtasks[0].completed;
            const newCompleted = !currentCompleted;

            const updatedTask = await Task.findOneAndUpdate(
                { _id: task_id, "subtasks._id": subtask_id },
                { $set: { "subtasks.$.completed": newCompleted } },
                { new: true }
            );

            res.json(updatedTask);
        } catch (error) {
            res.status(500).json({
                message: "Error updating subtask status",
                error,
            });
        }
    }
);

export const accessSharedTasks = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { shareId } = req.params;
        const currentUserId = req.user._id;

        const sharer = await UserModel.findOne({ shareId });

        const isAuthorized = sharer.sharedViewers.includes(currentUserId);
        if (!isAuthorized) {
            throw new AppError("Access revoked or not granted", 403);
        }

        let filter = { user: sharer._id };

        const features = new APIFeatures(
            TaskModel.find(filter),
            req.query as any
        )
            .filter()
            .sort()
            .limitFields()
            .search()
            .populate();
        const doc = await features.query;

        sendResponse(res, 200, "Tasks retrieved successfully", doc);
    }
);

export const importBulkTasks = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { tasks } = req.body;
        const user = req.user?._id;

        const processedTasks = tasks.map((_task) => {
            return {
                ..._task,
                user,
                status: "68deacdce9c648f5b606740c",
            };
        });

        await TaskModel.insertMany(processedTasks);

        sendResponse(res, 200, "Tasks imported successfully!");
    }
);
