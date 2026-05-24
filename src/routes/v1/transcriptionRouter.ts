import { injectUserId, restrictTo } from "./../../controllers/authController";
import express, { NextFunction, Request, Response } from "express";
import { protect } from "../../controllers/authController";
import TranscriptionModel from "../../model/transcriptionModel";
import { validateUserUpdate } from "../../utils/validator";
import { sendResponse } from "../../utils/response";
import AppError from "../../utils/appError";
import catchAsync from "../../utils/catchAsync";
import * as factory from "./../../controllers/handleFactory";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(
        factory.getAll(TranscriptionModel, {
            currentUserOnly: true,
            // Hide transcripts that never captured anything — covers both
            // legacy empty docs and any extension docs that slipped past
            // the on-meeting-end garbage collector (e.g., browser crash
            // mid-meeting before meeting/end fired).
            additionalFilter: {
                $or: [
                    { source: { $ne: "extension" } },
                    { "transcriptions.0": { $exists: true } },
                ],
            },
        })
    )
    .post(factory.createOne(TranscriptionModel, { userAsDocumentOwner: true }));

router
    .route("/coach")
    .get(
        restrictTo("admin", "manager", "coach"),
        factory.getAll(TranscriptionModel)
    );

router
    .route("/coach/:id")
    .delete(
        restrictTo("admin", "manager", "coach"),
        factory.deleteOne(TranscriptionModel)
    );

// Lookup a user's most-recent extension-captured transcription for a given
// Google Meet code. Used by the extension's live recording view to poll.
// Must be declared BEFORE the /:id route or Express will route "by-meeting"
// as an id.
router.get(
    "/by-meeting/:meetingId",
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await TranscriptionModel.findOne({
            user: req.user._id,
            meetingId: req.params.meetingId,
            source: "extension",
        })
            .sort({ createdAt: -1 })
            .lean();
        if (!doc) {
            return next(
                new AppError(
                    `No transcription found for meeting ${req.params.meetingId}`,
                    404
                )
            );
        }
        sendResponse(res, 200, "Transcription retrieved successfully", doc);
    })
);

router
    .route("/:id")
    .get(factory.getOne(TranscriptionModel))
    .delete(factory.deleteOne(TranscriptionModel));
// .patch(validateUserUpdate, factory.updateOne(TranscriptionModel));

export default router;
