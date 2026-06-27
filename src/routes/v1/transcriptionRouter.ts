import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import TranscriptionModel from "../../model/transcriptionModel";
import * as factory from "./../../controllers/handleFactory";
import {
    deleteTranscription,
    getTranscription,
    getTranscriptionByMeeting,
} from "../../controllers/transcriptionController";
import { authorizeTranscriptionAccess } from "../../utils/authorize";

const router = express.Router();
router.use(protect);

// List rows only need metadata + segmentCount for the cards — NEVER the
// (potentially huge) embedded `transcriptions` array. `selectFields` excludes
// it at the DB level and `lean` skips Mongoose hydration, so the list stays
// fast regardless of how long individual meetings are. Detail/by-meeting
// routes still return segments.
const LIST_OPTS = { selectFields: "-transcriptions", lean: true } as const;

router
    .route("/")
    .get(
        factory.getAll(TranscriptionModel, {
            ...LIST_OPTS,
            currentUserOnly: true,
            // Hide transcripts that never captured anything. A transcript is
            // non-empty if it's manual, has segmentCount > 0 (new model), OR
            // still carries a legacy embedded array. The array branch is the
            // safety net for any extension doc whose segmentCount wasn't
            // stamped by the migration — without it those gmeets vanish from
            // the list even though their data is intact.
            additionalFilter: {
                $or: [
                    { source: { $ne: "extension" } },
                    { segmentCount: { $gt: 0 } },
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
        factory.getAll(TranscriptionModel, LIST_OPTS)
    );

router
    .route("/coach/:id")
    .delete(restrictTo("admin", "manager", "coach"), deleteTranscription);

// Lookup a user's most-recent extension-captured transcription for a given
// Google Meet code. Used by the extension's live recording view to poll
// (supports ?after=<segmentId> for incremental delta fetches). Must be
// declared BEFORE the /:id route or Express will route "by-meeting" as an id.
router.get("/by-meeting/:meetingId", getTranscriptionByMeeting);

router
    .route("/:id")
    .get(authorizeTranscriptionAccess("id"), getTranscription)
    .delete(authorizeTranscriptionAccess("id"), deleteTranscription);

export default router;
