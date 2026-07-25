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
// Field-limited populate used ONLY for the opt-in slim payload (?slim=true).
// Two reasons:
//   1) Payload size — a 10k-task list otherwise drags full user/category/status
//      docs per row (tens of MB). The table only needs these fields.
//   2) Safety — populated users would otherwise rely on the User model's toJSON
//      transform to strip password/otp/tokens, which `.lean()` bypasses. An
//      explicit whitelist never selects those fields in the first place.
const TASK_LIST_POPULATE = [
    { path: "user", select: "fullName photo role updatedAt" },
    { path: "assignedTo", select: "fullName photo role updatedAt" },
    { path: "category", select: "title color" },
    { path: "status", select: "title color priority" },
];

// Shared list pipeline. The default branch reproduces the original endpoint
// behaviour exactly (full populate from ?populate=, hydrated docs so the User
// toJSON transform still strips secrets, ?limit= honoured) so the OTHER app that
// consumes this API is unaffected. The web app opts into a trimmed + lean
// payload with ?slim=true. Dangling status/category rows are dropped either way.
async function fetchTaskList(
    baseFilter: Record<string, any>,
    req: Request,
): Promise<any[]> {
    const slim = req.query.slim === "true";

    const features = new APIFeatures(TaskModel.find(baseFilter), req.query as any)
        .filter()
        .sort()
        .limitFields()
        .search();

    if (slim) {
        features.query = features.query
            .populate(TASK_LIST_POPULATE as any)
            .lean();
    } else {
        features.populate();
        // Ensure status/category are populated even if ?populate= omitted them
        // (the table/dangling-drop below needs them) — mirrors the old factory.
        features.query = features.query
            .populate("status")
            .populate("category");
    }

    if (req.query.limit) {
        const limit = parseInt(req.query.limit as string, 10);
        if (!isNaN(limit) && limit > 0) {
            features.query = features.query.limit(limit);
        }
    }

    const raw = (await features.query) as any[];
    return raw.filter((t) => t?.status != null && t?.category != null);
}

// GET /api/v1/task/ — the logged-in user's list (tasks they own OR are assigned
// to). Uses fetchTaskList; an explicit ?user= override still works via
// APIFeatures.filter() (mirrors the old factory behaviour).
export const getMyTasks = catchAsync(
    async (req: Request, res: Response, _next: NextFunction) => {
        const filter: Record<string, any> = {
            status: { $ne: null },
            category: { $ne: null },
        };
        if (!req.query.user && req.user) {
            filter.$or = [
                { user: req.user._id },
                { assignedTo: req.user._id },
            ];
        }

        const doc = await fetchTaskList(filter, req);
        sendResponse(res, 200, "Tasks retrieved successfully", doc);
    },
);

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

// Staff roles can assign tasks to ANY staff member system-wide; a regular
// "user"/patient is still limited to their owner-hierarchy.
const STAFF_ROLES = ["admin", "manager", "coach"];

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

        // Actor check: requester must be the owner, someone in the owner's
        // management hierarchy, or a current assignee (matches authorizeTaskAccess
        // and the frontend's canEdit).
        const requesterId = requester._id.toString();
        const requesterIsAssignee = task.assignedTo.some(
            (id) => id.toString() === requesterId,
        );
        const canAssign =
            requesterId === ownerId ||
            treeIds.includes(requesterId) ||
            requesterIsAssignee;
        if (!canAssign) {
            return next(
                new AppError("You are not allowed to assign this task", 403),
            );
        }

        // Candidate check (permissive-only widening):
        //   - removing a current assignee is always allowed;
        //   - STAFF requesters may assign any staff member (or the owner);
        //   - a regular user is still limited to the owner's hierarchy.
        const coachIdStr = coachId.toString();
        const isCurrentlyAssigned = task.assignedTo.some(
            (id) => id.toString() === coachIdStr,
        );
        let candidateAllowed: boolean;
        if (isCurrentlyAssigned) {
            candidateAllowed = true;
        } else if (STAFF_ROLES.includes(requester.role)) {
            const candidate = await UserModel.findById(coachId).select(
                "role active",
            );
            candidateAllowed =
                !!candidate &&
                candidate.active !== false &&
                (STAFF_ROLES.includes(candidate.role) ||
                    coachIdStr === ownerId);
        } else {
            candidateAllowed = [ownerId, ...treeIds].includes(coachIdStr);
        }
        if (!candidateAllowed) {
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
const ASSIGNEE_SELECT = "fullName photo role email updatedAt";

export const getTaskAssignees = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const task = await TaskModel.findById(req.params.id);
        if (!task) {
            return next(new AppError("Task not found", 404));
        }

        const ownerId = task.user.toString();
        const requesterId = req.user._id.toString();

        // LEGACY path (the other app sends no ?page): unchanged response — the
        // full owner + flattened-hierarchy list, shape { canAssign, assignees }.
        if (req.query.page === undefined) {
            const owner = await UserModel.findById(task.user)
                .select(ASSIGNEE_SELECT)
                .lean();
            const hierarchy = await getFlattenedHierarchy(task.user);
            const assignees = [...(owner ? [owner] : []), ...hierarchy];
            const canAssign =
                assignees.some((u: any) => String(u._id) === requesterId) ||
                requesterId === ownerId;
            return sendResponse(res, 200, "Assignees fetched", {
                canAssign,
                assignees,
            });
        }

        // PAGINATED path (web). Candidate set depends on the REQUESTER's role:
        // staff see all staff system-wide; a regular user keeps the owner's
        // hierarchy. Already-assigned users are excluded (the client pins them
        // on top from the task itself).
        const search = (req.query.search || "").toString().trim();
        const page = Math.max(
            parseInt((req.query.page || "1").toString(), 10) || 1,
            1,
        );
        const limit = 15;
        const skip = (page - 1) * limit;

        const treeIds = (await getManagementTreeIds(task.user)).map(String);
        const isAssignee = task.assignedTo.some(
            (id) => id.toString() === requesterId,
        );
        const canAssign =
            requesterId === ownerId ||
            treeIds.includes(requesterId) ||
            isAssignee;

        const assignedIds = task.assignedTo.map((id) => id.toString());

        let assignees: any[] = [];
        let totalCount = 0;

        if (STAFF_ROLES.includes(req.user.role)) {
            const searchFilter =
                search.length > 0
                    ? {
                          $or: [
                              { fullName: { $regex: search, $options: "i" } },
                              { email: { $regex: search, $options: "i" } },
                          ],
                      }
                    : {};
            const [result] = await UserModel.aggregate([
                {
                    $match: {
                        role: { $in: STAFF_ROLES },
                        active: true,
                        verified: true,
                        _id: { $nin: task.assignedTo },
                        ...searchFilter,
                    },
                },
                {
                    $facet: {
                        data: [
                            { $sort: { fullName: 1 } },
                            { $skip: skip },
                            { $limit: limit },
                            {
                                $project: {
                                    fullName: 1,
                                    photo: 1,
                                    role: 1,
                                    email: 1,
                                    updatedAt: 1,
                                },
                            },
                        ],
                        meta: [{ $count: "total" }],
                    },
                },
            ]);
            assignees = result?.data || [];
            totalCount = result?.meta?.[0]?.total || 0;
        } else {
            const owner = await UserModel.findById(task.user)
                .select(ASSIGNEE_SELECT)
                .lean();
            const hierarchy = await getFlattenedHierarchy(task.user);
            let candidates = [...(owner ? [owner] : []), ...hierarchy].filter(
                (u: any) => !assignedIds.includes(String(u._id)),
            );
            if (search) {
                const s = search.toLowerCase();
                candidates = candidates.filter(
                    (u: any) =>
                        (u.fullName || "").toLowerCase().includes(s) ||
                        (u.email || "").toLowerCase().includes(s),
                );
            }
            totalCount = candidates.length;
            assignees = candidates.slice(skip, skip + limit);
        }

        const totalPages = Math.max(1, Math.ceil(totalCount / limit));
        sendResponse(res, 200, "Assignees fetched", {
            canAssign,
            assignees,
            meta: { totalCount, currentPage: page, limit, totalPages },
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
        if (!sharer) {
            return next(new AppError("Invalid share link", 404));
        }

        const isAuthorized = sharer.sharedViewers.includes(currentUserId);
        if (!isAuthorized) {
            throw new AppError("Access revoked or not granted", 403);
        }

        const filter = {
            user: sharer._id,
            status: { $ne: null },
            category: { $ne: null },
        };

        // Was an inline copy of fetchTaskList's non-slim branch, which meant the
        // shared list never got `assignedTo` populated and the web app couldn't
        // show who a task is assigned to. Going through fetchTaskList picks up
        // the ?slim=true path (TASK_LIST_POPULATE — assignedTo included, with
        // only fullName/photo/role/updatedAt selected) while leaving the
        // hydrated, ?populate=-driven response untouched for other consumers.
        const doc = await fetchTaskList(filter, req);

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

        const doc = await fetchTaskList(filter, req);
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
