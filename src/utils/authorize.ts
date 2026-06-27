import { NextFunction, Request, Response } from "express";
import catchAsync from "./catchAsync";
import AppError from "./appError";
import TaskModel from "../model/taskModel";
import ChatModel from "../model/chatModel";
import DocumentModel from "../model/documentModel";
import TranscriptionModel from "../model/transcriptionModel";
import { getManagementTreeIds } from "./hierarchy";

// Is the requester the owner of `ownerId`, or somewhere in that owner's
// management hierarchy (their coach -> manager -> admin chain)?
async function isOwnerOrManager(ownerId: any, requesterId: string) {
    if (ownerId.toString() === requesterId) return true;
    const tree = (await getManagementTreeIds(ownerId)).map(String);
    return tree.includes(requesterId);
}

// Tasks: the owner, an assignee, or anyone in the owner's hierarchy may
// read/edit/delete. Mirrors the assignee-permission model.
export const authorizeTaskAccess = (paramName = "id") =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const task = await TaskModel.findById(req.params[paramName]);
        if (!task) return next(new AppError("Task not found", 404));

        const requesterId = req.user._id.toString();
        const isAssignee = task.assignedTo.some(
            (id) => id.toString() === requesterId,
        );
        if (isAssignee || (await isOwnerOrManager(task.user, requesterId))) {
            return next();
        }
        return next(
            new AppError("You are not allowed to access this task", 403),
        );
    });

// Documents: owner, someone the doc is shared with, or the owner's hierarchy.
export const authorizeDocumentAccess = (paramName = "id") =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await DocumentModel.findById(req.params[paramName]);
        if (!doc) return next(new AppError("Document not found", 404));

        const requesterId = req.user._id.toString();
        const isShared = (doc.sharedWith ?? []).some(
            (id: any) => id.toString() === requesterId,
        );
        if (isShared || (await isOwnerOrManager(doc.user, requesterId))) {
            return next();
        }
        return next(
            new AppError("You are not allowed to access this document", 403),
        );
    });

// Transcriptions: owner or the owner's hierarchy.
export const authorizeTranscriptionAccess = (paramName = "id") =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await TranscriptionModel.findById(req.params[paramName]);
        if (!doc) return next(new AppError("Transcription not found", 404));

        const requesterId = req.user._id.toString();
        if (await isOwnerOrManager(doc.user, requesterId)) {
            return next();
        }
        return next(
            new AppError(
                "You are not allowed to access this transcription",
                403,
            ),
        );
    });

// Membership check used by chat/message controllers.
export async function isChatMember(chatId: any, userId: any): Promise<boolean> {
    if (!chatId) return false;
    const chat = await ChatModel.findOne({
        _id: chatId,
        "members.user": userId,
    }).select("_id");
    return !!chat;
}

// Route guard: the requester must be a member of the chat. (Use only on
// user-facing routes — coach/admin "view a client's room" routes are role-
// gated separately and may legitimately view rooms they aren't a member of.)
export const authorizeChatMembership = (paramName = "roomId") =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        if (!(await isChatMember(req.params[paramName], req.user._id))) {
            return next(
                new AppError("You are not a member of this chat", 403),
            );
        }
        next();
    });
