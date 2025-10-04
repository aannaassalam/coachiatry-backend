import { Request, Response } from "express";
import Task from "../model/taskModel";
import catchAsync from "../utils/catchAsync";

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
