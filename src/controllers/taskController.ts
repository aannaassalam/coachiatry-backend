import { NextFunction, Request, Response } from "express";
import Task from "../model/taskModel";
import catchAsync from "../utils/catchAsync";
import APIFeatures from "../utils/apiFeatures";
import TaskModel from "../model/taskModel";
import { sendResponse } from "../utils/response";
import UserModel from "../model/userModel";
import AppError from "../utils/appError";
import { getNextOccurrence } from "../utils/workers/taskWorker";
import StatusModel from "../model/statusModel";
import { taskQueue } from "../utils/queues/taskQueue";
import moment from "moment";

export const createTask = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const body = req.body;
        body.user = req.user?._id;
        body.assignedTo = req.user?._id;
        const doc = await TaskModel.create(body);

        if (doc.remindBefore) {
            const nextDue = moment(doc.dueDate);

            const delay = Math.max(
                0,
                nextDue.diff(moment()) - doc.remindBefore * 60 * 1000
            );

            await taskQueue.add("sendReminder", { taskId: doc._id }, { delay });
        }

        sendResponse(res, 201, `Task created successfully`, doc);
    }
);

export const createTaskByCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const body = { ...req.body, assignedTo: req.body.user };
        const doc = await TaskModel.create(body);

        if (doc.remindBefore) {
            const nextDue = moment(doc.dueDate);

            const delay = Math.max(
                0,
                nextDue.diff(moment()) - doc.remindBefore * 60 * 1000
            );

            await taskQueue.add("sendReminder", { taskId: doc._id }, { delay });
        }

        sendResponse(res, 201, `Task created successfully`, doc);
    }
);

export const assignToCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const user = req.user;
        const { taskId } = req.body;

        const task = await TaskModel.findById(taskId);

        if (task.assignedTo.toString() === user._id.toString()) {
            task.assignedTo = user.assignedCoach;
        } else {
            task.assignedTo = user._id;
        }

        await task.save();
        sendResponse(res, 200, "Task executer changed successfully");
    }
);

export const editTask = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await TaskModel.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        });
        if (!doc) {
            return next(new AppError(`No task found with that ID`, 404));
        }
        doc.save({ validateBeforeSave: false });

        if (doc.remindBefore) {
            const oldJob = await taskQueue.getJob(doc._id);
            if (oldJob) {
                await oldJob.remove();
                console.log(`🗑️ Removed old job for message ${doc._id}`);
            }
            const nextDue = moment(doc.dueDate);

            const delay = Math.max(
                0,
                nextDue.diff(moment()) - doc.remindBefore * 60 * 1000
            );

            await taskQueue.add("sendReminder", { taskId: doc._id }, { delay });
        }

        sendResponse(res, 200, "Task updated successfully", doc);
    }
);

export const deleteTask = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await TaskModel.findByIdAndDelete(req.params.id);

        if (!doc) {
            return next(
                new AppError(
                    `No ${TaskModel.modelName} found with that ID`,
                    404
                )
            );
        }

        const oldJob = await taskQueue.getJob(doc._id);
        if (oldJob) {
            await oldJob.remove();
            console.log(`🗑️ Removed old job for message ${doc._id}`);
        }

        sendResponse(res, 200, "Task deleted successfully", null);
    }
);

export const updateTaskStatus = catchAsync(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const task = await TaskModel.findById(id).populate("status");
    if (!task) throw new AppError("Task not found", 400);

    // Save new status first
    task.status = status;
    await task.save();

    // Only if completed & frequency enabled
    if (
        task.frequency !== "none" &&
        String(status.title).toLowerCase() === "completed"
    ) {
        const nextDue = getNextOccurrence(task.dueDate, task.frequency);
        task.dueDate = nextDue;

        // Reset status to TODO for next time
        const todoStatus = await StatusModel.findById(
            "68deacdce9c648f5b606740c"
        );
        if (todoStatus) {
            task.status = todoStatus._id;
        }

        await task.save();

        if (task.remindBefore) {
            const delay = Math.max(
                0,
                nextDue.getTime() - Date.now() - task.remindBefore
            );

            await taskQueue.add("sendReminder", { taskId: id }, { delay });
        }
    }

    res.json(task);
});

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
        const { tasks, userId } = req.body;
        const user = userId ?? req.user?._id;

        const processedTasks = tasks.map((_task) => {
            return {
                ..._task,
                user,
                assignedTo: user,
                status: "68deacdce9c648f5b606740c",
            };
        });

        await TaskModel.insertMany(processedTasks);

        sendResponse(res, 200, "Tasks imported successfully!");
    }
);
