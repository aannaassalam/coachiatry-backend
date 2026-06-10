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
import {
    getFlattenedHierarchy,
    getManagementTreeIds,
} from "../utils/hierarchy";

export const createTask = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const body = req.body;
        body.user = req.user?._id;
        body.assignedTo = [req.user?._id];
        const doc = await TaskModel.create(body);

        if (doc.remindBefore) {
            const nextDue = moment(doc.dueDate);

            const delay = Math.max(
                0,
                nextDue.diff(moment()) - doc.remindBefore * 60 * 1000,
            );

            await taskQueue.add("sendReminder", { taskId: doc._id }, { delay });
        }

        sendResponse(res, 201, `Task created successfully`, doc);
    },
);

export const createTaskByCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const body = { ...req.body, assignedTo: [req.body.user] };
        const doc = await TaskModel.create(body);

        if (doc.remindBefore) {
            const nextDue = moment(doc.dueDate);

            const delay = Math.max(
                0,
                nextDue.diff(moment()) - doc.remindBefore * 60 * 1000,
            );

            await taskQueue.add("sendReminder", { taskId: doc._id }, { delay });
        }

        sendResponse(res, 201, `Task created successfully`, doc);
    },
);

// Ensure a user has a status column matching the given task status. Statuses
// are per-user, but a task carries a single status id (the owner's). When a
// task is assigned to someone who doesn't have an equivalent column, the task
// is silently hidden on their board, so we clone the status (title + color)
// for them. Public/system statuses are shared by everyone, so they're skipped.
async function ensureStatusForUser(userId: any, statusId: any) {
    const source = await StatusModel.findById(statusId);
    if (!source || source.public) return;

    const exists = await StatusModel.findOne({
        user: userId,
        title: source.title,
        active: true,
    });
    if (exists) return;

    await StatusModel.create({
        user: userId,
        title: source.title,
        color: source.color,
        public: false,
        active: true,
    });
}

export const assignToCoach = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const requester = req.user; // logged-in user (patient OR coach OR admin)
        const { taskId, coachId } = req.body;

        if (!taskId || !coachId) {
            return next(new AppError("taskId and coachId are required", 400));
        }

        const task = await TaskModel.findById(taskId);
        if (!task) {
            return next(new AppError("Task not found", 404));
        }

        // The assignee list is anchored on the task OWNER's management
        // hierarchy (their coach -> manager -> admin chain). Anyone in that
        // hierarchy — plus the owner themself — may change the assignee, and
        // the coach being toggled must also belong to that same set.
        const ownerId = task.user.toString();
        const treeIds = (await getManagementTreeIds(task.user)).map(String);

        // Actor check: requester must be the owner or one of the owner's
        // managers/coaches/admins above them.
        const requesterId = requester._id.toString();
        const canAssign =
            requesterId === ownerId || treeIds.includes(requesterId);
        if (!canAssign) {
            return next(
                new AppError("You are not allowed to assign this task", 403),
            );
        }

        // Candidate check: the coach being assigned must be the owner or
        // someone in the owner's management hierarchy.
        const candidateIds = [ownerId, ...treeIds];
        if (!candidateIds.includes(coachId.toString())) {
            return next(
                new AppError("This user cannot be assigned to the task", 403),
            );
        }

        // Toggle: add if not present, remove if already assigned
        const alreadyAssigned = task.assignedTo.some(
            (id) => id.toString() === coachId.toString(),
        );
        if (alreadyAssigned) {
            task.assignedTo = task.assignedTo.filter(
                (id) => id.toString() !== coachId.toString(),
            ) as any;
        } else {
            task.assignedTo.push(coachId);
            // Give the new assignee a matching status column so the task shows
            // up on their board instead of being silently filtered out.
            await ensureStatusForUser(coachId, task.status);
        }

        await task.save();

        sendResponse(res, 200, "Task executor changed successfully", {
            taskId: task._id,
            assignedTo: task.assignedTo,
        });
    },
);

// GET /api/v1/task/:id/assignees
// Returns the candidate assignee list for a task, anchored on the task
// OWNER's management hierarchy (the owner plus their coach -> manager -> admin
// chain), and whether the current requester is permitted to change it. The
// list is the same regardless of who is viewing, so a coach/admin editing a
// task they were assigned to still sees the original owner's options.
export const getTaskAssignees = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const task = await TaskModel.findById(req.params.id);
        if (!task) {
            return next(new AppError("Task not found", 404));
        }

        const owner = await UserModel.findById(task.user)
            .select("fullName photo role email updatedAt")
            .lean();

        const hierarchy = await getFlattenedHierarchy(task.user);

        // Owner first, then their flattened hierarchy.
        const assignees = [...(owner ? [owner] : []), ...hierarchy];

        const ownerId = task.user.toString();
        const requesterId = req.user._id.toString();
        const canAssign = assignees.some(
            (u: any) => String(u._id) === requesterId,
        );

        sendResponse(res, 200, "Assignees fetched", {
            canAssign: canAssign || requesterId === ownerId,
            assignees,
        });
    },
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

        // Only (re)schedule the reminder when the update actually touched the
        // scheduling inputs. Autosave sends partial diffs, so a title-only edit
        // won't carry dueDate/remindBefore and must not churn the queue.
        const touchedSchedule =
            "dueDate" in req.body || "remindBefore" in req.body;

        if (doc.remindBefore && touchedSchedule) {
            const oldJob = await taskQueue.getJob(doc._id);
            if (oldJob) {
                await oldJob.remove();
                console.log(`🗑️ Removed old job for message ${doc._id}`);
            }
            const nextDue = moment(doc.dueDate);

            const delay = Math.max(
                0,
                nextDue.diff(moment()) - doc.remindBefore * 60 * 1000,
            );

            await taskQueue.add("sendReminder", { taskId: doc._id }, { delay });
        }

        sendResponse(res, 200, "Task updated successfully", doc);
    },
);

export const deleteTask = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await TaskModel.findByIdAndDelete(req.params.id);

        if (!doc) {
            return next(
                new AppError(
                    `No ${TaskModel.modelName} found with that ID`,
                    404,
                ),
            );
        }

        const oldJob = await taskQueue.getJob(doc._id);
        if (oldJob) {
            await oldJob.remove();
            console.log(`🗑️ Removed old job for message ${doc._id}`);
        }

        sendResponse(res, 200, "Task deleted successfully", null);
    },
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
            "68deacdce9c648f5b606740c",
        );
        if (todoStatus) {
            task.status = todoStatus._id;
        }

        await task.save();

        if (task.remindBefore) {
            const delay = Math.max(
                0,
                nextDue.getTime() - Date.now() - task.remindBefore,
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
                { "subtasks.$": 1 },
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
                { new: true },
            );

            res.json(updatedTask);
        } catch (error) {
            res.status(500).json({
                message: "Error updating subtask status",
                error,
            });
        }
    },
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

        const filter = {
            user: sharer._id,
            status: { $ne: null },
            category: { $ne: null },
        };

        const features = new APIFeatures(
            TaskModel.find(filter),
            req.query as any,
        )
            .filter()
            .sort()
            .limitFields()
            .search()
            .populate();
        features.query = features.query.populate("status").populate("category");

        const raw = (await features.query) as any[];
        const doc = raw.filter((t) => t?.status != null && t?.category != null);

        sendResponse(res, 200, "Tasks retrieved successfully", doc);
    },
);

// GET /api/v1/task/coach/:userId
// Coach/manager/admin view of a specific client's tasks: everything the
// client OWNS (`user`) OR is ASSIGNED to (`assignedTo` array contains them).
// Mirrors the personal list's "owned or assigned" scope, but for the viewed
// client instead of the logged-in user. Dangling status/category refs are
// dropped after populate (same as accessSharedTasks).
export const getCoachTasks = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { userId } = req.params;
        if (!userId) {
            return next(new AppError("userId is required", 400));
        }

        const filter = {
            $or: [{ user: userId }, { assignedTo: userId }],
            status: { $ne: null },
            category: { $ne: null },
        };

        const features = new APIFeatures(
            TaskModel.find(filter),
            req.query as any,
        )
            .filter()
            .sort()
            .limitFields()
            .search()
            .populate();
        features.query = features.query.populate("status").populate("category");

        const raw = (await features.query) as any[];
        const doc = raw.filter((t) => t?.status != null && t?.category != null);

        sendResponse(res, 200, "Tasks retrieved successfully", doc);
    },
);

export const importBulkTasks = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const user = req.user?._id;
        if (!user) {
            return next(new AppError("Authenticated user required", 401));
        }

        const rawTasks = Array.isArray(req.body.tasks) ? req.body.tasks : [];
        if (rawTasks.length === 0) {
            return next(new AppError("Provide a non-empty `tasks` array", 400));
        }

        // Strip identifiers, force ownership to the JWT user, require a
        // title. Conversion of AI-only field shapes (category {id,title},
        // subtasks {done}, recurrence) is only applied WHEN that shape is
        // detected — model-shape inputs from other callers pass through
        // untouched so we don't regress existing flows.
        const VALID_FREQUENCY = new Set([
            "none",
            "daily",
            "weekly",
            "monthly",
            "yearly",
        ]);

        const sanitized = rawTasks
            .map((t: any) => {
                const {
                    _id,
                    id,
                    tempId,
                    user: _u,
                    assignedTo: _a,
                    recurrence,
                    ...rest
                } = t || {};

                const out: any = {
                    ...rest,
                    user,
                    assignedTo: [user],
                };

                // category — only transform when given the AI shape
                // ({ id, title }). String ObjectIds / null / undefined
                // are passed through unchanged.
                if (
                    rest.category &&
                    typeof rest.category === "object" &&
                    !Array.isArray(rest.category)
                ) {
                    out.category =
                        typeof rest.category.id === "string"
                            ? rest.category.id
                            : null;
                }

                // subtasks — only transform when the AI shape is detected
                // (any item has `done` or `description`). Model-shape
                // [{ title, completed }] passes through untouched.
                if (Array.isArray(rest.subtasks)) {
                    const isAiShape = rest.subtasks.some(
                        (s: any) =>
                            s &&
                            typeof s === "object" &&
                            ("done" in s || "description" in s),
                    );
                    if (isAiShape) {
                        out.subtasks = rest.subtasks
                            .filter(
                                (s: any) =>
                                    s &&
                                    typeof s.title === "string" &&
                                    s.title.trim(),
                            )
                            .map((s: any) => ({
                                title: s.title,
                                completed: Boolean(s.done ?? s.completed),
                            }));
                    }
                    // else: pass through whatever the caller sent
                }

                // recurrence → frequency — only when caller didn't send
                // frequency directly. Keeps existing callers (which already
                // send `frequency`) untouched.
                if (
                    typeof recurrence === "string" &&
                    rest.frequency === undefined
                ) {
                    out.frequency = VALID_FREQUENCY.has(recurrence)
                        ? recurrence
                        : "none";
                }

                return out;
            })
            .filter((t: any) => typeof t.title === "string" && t.title.trim());

        if (sanitized.length === 0) {
            return next(
                new AppError(
                    "No valid tasks to import (each task needs a `title`)",
                    400,
                ),
            );
        }

        // Resolve a default status dynamically instead of hardcoding an
        // ObjectId. Prefer a status whose title matches common backlog
        // names, otherwise fall back to the oldest available status the
        // user can see (their own or public).
        const explicitStatusId = req.body.statusId
            ? String(req.body.statusId)
            : null;
        let defaultStatusId: string | null = explicitStatusId;
        if (!defaultStatusId) {
            const todoMatch = await StatusModel.findOne({
                $or: [{ user }, { public: true, user: null }],
                active: true,
                title: { $in: ["To Do", "Todo"] },
            })
                .select("_id")
                .lean();
            if (todoMatch) {
                defaultStatusId = String(todoMatch._id);
            } else {
                const oldest = await StatusModel.findOne({
                    $or: [{ user }, { public: true, user: null }],
                    active: true,
                })
                    .sort({ createdAt: 1 })
                    .select("_id")
                    .lean();
                defaultStatusId = oldest ? String(oldest._id) : null;
            }
        }
        if (!defaultStatusId) {
            return next(
                new AppError(
                    "No status column available — create one before importing tasks",
                    400,
                ),
            );
        }

        const processedTasks = sanitized.map((t: any) => ({
            ...t,
            status: t.status ?? defaultStatusId,
        }));

        const created = await TaskModel.insertMany(processedTasks);

        sendResponse(res, 200, "Tasks imported successfully!", {
            imported: created.length,
        });
    },
);
