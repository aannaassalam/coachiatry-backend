import { NextFunction, Request, Response } from "express";

import StatusModel from "../model/statusModel";
import TranscriptionModel from "../model/transcriptionModel";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { transcriptionAIController } from "./LLMController";
import { importBulkTasks } from "./taskController";

// Meeting-scoped wrappers used by the Chrome extension. Both endpoints take
// the Meet code (e.g. "abc-defg-hij") as a path param and delegate to the
// existing real controllers — keeping the extension client thin and using
// the same AI + import pipeline as the rest of the app.

// POST /api/v1/meetings/:meetingId/tasks/generate
// Looks up the user's active extension transcription for the meeting and
// forwards to transcriptionAIController with action="generate_tasks". The
// `active: true` requirement enforces "current meeting only" — past
// meetings cannot generate new tasks.
export const generateTasks = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { meetingId } = req.params;
        if (!meetingId) {
            return next(new AppError("meetingId is required", 400));
        }

        const transcription = await TranscriptionModel.findOne({
            user: req.user._id,
            meetingId,
            source: "extension",
            active: true,
        })
            .select("_id")
            .lean();

        if (!transcription) {
            return next(
                new AppError(
                    "Task generation is only available for the meeting you're currently in.",
                    404
                )
            );
        }

        req.body = {
            ...req.body,
            transcriptionId: String(transcription._id),
            action: "generate_tasks",
        };
        return transcriptionAIController(req, res, next);
    }
);

// POST /api/v1/meetings/:meetingId/tasks/import
// Always lands AI-imported tasks in the user's "Todo" column.
//
// Resolution order for the Todo status:
//   1. User-owned status whose title matches "Todo" / "To Do" / "To-Do".
//   2. Public status whose title matches the same patterns.
//   3. Anywhere-in-title "todo" fuzzy match (handles emoji prefixes,
//      "Todo (default)", etc.).
//   4. Create a fresh "Todo" status owned by the user if none exists.
//
// Whatever we resolve gets written to req.body.statusId, AND each task
// in req.body.tasks has its `status` field stamped to that id — so even
// if a task somehow arrived pre-populated with a different status, the
// meeting flow overrides it.
export const importTasks = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id;
        if (!userId) {
            return importBulkTasks(req, res, next);
        }

        const existing = await StatusModel.findOne({
            title: { $in: ["To Do", "Todo"] },
            active: true,
            public: true,
        })
            .select("_id")
            .lean();

        const todoId = existing
            ? String(existing._id)
            : String(
                  (
                      await StatusModel.create({
                          title: "Todo",
                          user: userId,
                          active: true,
                          public: true,
                          color: { bg: "#f3f4f6", text: "#374151" },
                      })
                  )._id
              );

        // Stamp every task and set the default for importBulkTasks so the
        // override is hard to bypass even if an inbound task pre-sets a
        // `status` field.
        const tasks = Array.isArray(req.body.tasks) ? req.body.tasks : [];
        req.body = {
            ...req.body,
            statusId: todoId,
            tasks: tasks.map((t: any) => ({ ...t, status: todoId })),
        };

        return importBulkTasks(req, res, next);
    }
);
