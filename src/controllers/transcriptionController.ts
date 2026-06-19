import { NextFunction, Request, Response } from "express";

import TranscriptionModel from "../model/transcriptionModel";
import TranscriptSegmentModel from "../model/transcriptSegmentModel";
import {
    loadSegmentsPage,
    loadTranscriptSegments,
} from "../services/transcriptSegments.service";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";

// Cap on segments returned for a single live-view delta poll. The extension
// commits one segment per finished utterance, so this only ever bites if the
// popup was closed for a long stretch and reopens — it then catches up across
// several polls instead of one giant payload.
const LIVE_PAGE_LIMIT = 500;

// Default / max page size for paginated (infinite-scroll) detail reads, so a
// long past meeting isn't shipped in one giant payload.
const DETAIL_PAGE_LIMIT = 50;
const DETAIL_PAGE_LIMIT_MAX = 200;

function parseLimit(raw: unknown, fallback: number, max: number): number {
    const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

// GET /transcriptions/:id[?after=<segmentId>&limit=<n>]
// Transcript detail, paginated for infinite scroll. Dual-read: segments come
// from the per-segment collection (a page at a time, ascending = chronological)
// falling back to the legacy embedded array (whole) for old docs. The
// `transcriptions` field is reconstructed so existing clients are unaffected;
// `cursor`/`hasMore` drive "load more".
export const getTranscription = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        // Honor ?populate=user,... exactly like factory.getOne so callers
        // (e.g. the coach view, which renders the client's name/photo) keep
        // working. Crucially we project OUT the (potentially huge, for legacy
        // docs) embedded `transcriptions` array — segments are paged in
        // separately below, so the metadata fetch stays cheap regardless of
        // meeting length.
        const populateFields = req.query.populate
            ? (req.query.populate as string).split(",").join(" ")
            : "";
        const doc = await TranscriptionModel.findById(req.params.id)
            .select("-transcriptions")
            .populate(populateFields)
            .lean();
        if (!doc) {
            return next(new AppError("No Transcription found with that ID", 404));
        }

        const after =
            typeof req.query.after === "string" ? req.query.after : undefined;
        const limit = parseLimit(
            req.query.limit,
            DETAIL_PAGE_LIMIT,
            DETAIL_PAGE_LIMIT_MAX
        );

        const { segments, cursor, hasMore } = await loadSegmentsPage(
            doc._id,
            { after, limit, segmentCount: doc.segmentCount }
        );
        sendResponse(res, 200, "Transcription retrieved successfully", {
            ...doc,
            transcriptions: segments,
            cursor,
            hasMore,
        });
    }
);

// GET /transcriptions/by-meeting/:meetingId[?after=<segmentId>]
// Used by the extension's live recording view. Without `after` it returns the
// transcript metadata plus all current segments (initial load). With `after`
// it returns ONLY the segments inserted since that cursor — so a long meeting
// no longer re-ships its entire transcript on every 2s poll. `cursor` in the
// response is the value to pass back as `after` next time.
export const getTranscriptionByMeeting = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
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

        const after =
            typeof req.query.after === "string" ? req.query.after : undefined;

        const { segments, cursor, hasMore } = await loadTranscriptSegments(
            doc,
            { after, limit: LIVE_PAGE_LIMIT }
        );

        sendResponse(res, 200, "Transcription retrieved successfully", {
            ...doc,
            transcriptions: segments,
            // Delta responses omit the (stale) legacy array entirely so the
            // client never re-merges already-seen text.
            cursor,
            hasMore,
            incremental: !!after,
        });
    }
);

// Shared cascade delete: drop the transcript AND its segments so we don't
// leave orphaned rows in the per-segment collection.
export const deleteTranscription = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await TranscriptionModel.findByIdAndDelete(req.params.id);
        if (!doc) {
            return next(new AppError("No Transcription found with that ID", 404));
        }
        await TranscriptSegmentModel.deleteMany({ transcription: doc._id });
        sendResponse(res, 200, "Transcription deleted successfully", null);
    }
);
