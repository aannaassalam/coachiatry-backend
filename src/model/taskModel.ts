import { ITaskDocument } from "./../constants/interfaces/ITaskDocument";
import mongoose, { Schema } from "mongoose";

const taskSchema = new Schema<ITaskDocument>(
    {
        title: {
            type: String,
            required: [true, "Please enter task title!"],
        },
        description: {
            type: String,
            default: "",
        },
        user: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        subtasks: [
            {
                title: { type: String, default: null },
                completed: { type: Boolean, default: false },
            },
        ],
        category: {
            type: mongoose.Types.ObjectId,
            ref: "Category",
            default: null,
        },
        priority: {
            type: String,
            enum: ["low", "medium", "high"],
            default: "low",
        },
        dueDate: {
            type: Date,
            default: null,
        },
        status: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "Status",
        },
        taskDuration: {
            type: Number,
            default: null,
        },
        frequency: {
            type: String,
            enum: ["none", "daily", "weekly", "monthly", "yearly"],
            default: "none",
        },
        assignedTo: [
            {
                type: mongoose.Types.ObjectId,
                ref: "User",
            },
        ],
        remindBefore: {
            type: Number,
            default: null,
        },
        active: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    },
);

taskSchema.index({ title: 1 });
taskSchema.index({ user: 1, createdAt: -1 });
taskSchema.index({ assignedTo: 1 });
taskSchema.index({ status: 1 });

const TaskModel = mongoose.model<ITaskDocument>("Task", taskSchema);
export default TaskModel;
