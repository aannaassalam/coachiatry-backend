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

// Can `requesterId` read this chat's contents? True if they are a member, OR
// they hold a staff role (coach/manager/admin). Staff are trusted to view a
// client's room they aren't a member of — this matches the app's role-gated
// coach access model (see getClients / the coach REST routes). A regular user
// still can't read a chat they don't belong to.
//
// NOTE: this used to require a management-hierarchy link (isOwnerOrManager over
// the chat members) but that blocked legitimate managers/admins whenever the
// upper `assignedCoach` links (coach → manager → admin) weren't fully populated
// in the data. Re-tighten to a hierarchy check only once that data is
// guaranteed complete.
const STAFF_ROLES = ["admin", "manager", "coach"];
export async function canAccessChat(
    chatId: any,
    requesterId: string,
    role?: string,
): Promise<boolean> {
    if (!chatId) return false;
    if (role && STAFF_ROLES.includes(role)) return true;
    const chat = await ChatModel.findById(chatId).select("members.user");
    if (!chat) return false;
    const rid = requesterId.toString();
    return chat.members.some((m: any) => m.user.toString() === rid);
}

// Route guard for coach/admin/manager "view a client's room" endpoints: allow
// members and authorized supervisors, reject everyone else.
export const authorizeChatAccess = (paramName = "roomId") =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const ok = await canAccessChat(
            req.params[paramName],
            req.user._id.toString(),
            req.user.role,
        );
        if (!ok) {
            return next(
                new AppError("You are not allowed to access this chat", 403),
            );
        }
        next();
    });

// Route guard for coach endpoints keyed on a target userId (e.g. list a
// client's conversations / scheduled messages): allow staff roles (matching the
// app's role-gated coach model) or the target user / their manager. See the
// note on canAccessChat about why a strict hierarchy-only check was relaxed.
export const authorizeManagedUser = (paramName = "userId") =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const isStaff = !!req.user.role && STAFF_ROLES.includes(req.user.role);
        if (
            isStaff ||
            (await isOwnerOrManager(
                req.params[paramName],
                req.user._id.toString(),
            ))
        ) {
            return next();
        }
        return next(
            new AppError("You are not allowed to access this user's data", 403),
        );
    });
