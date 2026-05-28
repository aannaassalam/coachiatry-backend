import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface ISubtask {
    title: string;
    completed: boolean;
}

export interface ITaskDocument extends Document {
    title: string;
    description: string;
    subtasks?: ISubtask[];
    user: ObjectId;
    category?: ObjectId;
    priority: "low" | "medium" | "high";
    dueDate: Date;
    status: ObjectId;
    taskDuration?: number;
    frequency?: "none" | "daily" | "weekly" | "monthly" | "yearly";
    remindBefore?: number;
    assignedTo: ObjectId[];
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}
