import mongoose from "mongoose";

import { ITranscription } from "../constants/interfaces/ITranscription";
import TranscriptionModel from "../model/transcriptionModel";
import TranscriptSegmentModel from "../model/transcriptSegmentModel";

const LEGACY_CURSOR_PREFIX = "legacy:";

function mapSegment(r: any): SegmentView {
    return {
        _id: r._id ? String(r._id) : undefined,
        seq: r.seq,
        name: r.name,
        profile: r.profile ?? "",
        text: r.text,
        timestamp: r.timestamp,
    };
}

// The canonical "segment" shape the rest of the app (and the extension)
// expects — identical whether it came from the new per-segment collection or
// a legacy embedded array, so callers never branch on storage location.
export interface SegmentView {
    _id?: string;
    seq?: string;
    name: string;
    profile: string;
    text: string;
    timestamp: Date | string;
}

interface LoadOptions {
    // Return only segments inserted AFTER this segment _id (exclusive),
    // ordered ascending. Used by the extension's live view to fetch deltas
    // instead of the whole transcript every poll.
    after?: string;
    // Cap the number of segments returned (most recent-by-insertion respected
    // via ascending _id). Omit for "all".
    limit?: number;
}

interface LoadResult {
    segments: SegmentView[];
    // The _id of the last segment returned — the cursor a client passes back
    // as `after` next time. null when there's nothing (or only legacy data).
    cursor: string | null;
    // Whether more segments exist beyond this page. Always false for the
    // legacy embedded-array fallback (it's returned whole in one page).
    hasMore: boolean;
}

// Dual-read: prefer the new TranscriptSegment collection; fall back to the
// document's legacy embedded `transcriptions` array for any transcript that
// predates the migration (segmentCount 0 and nothing in the new collection).
//
// `doc` only needs `_id`, and — for the legacy fallback — `transcriptions`
// and `segmentCount`. Pass a lean doc.
export async function loadTranscriptSegments(
    doc: {
        _id: mongoose.Types.ObjectId | string;
        transcriptions?: ITranscription[];
        segmentCount?: number;
    },
    opts: LoadOptions = {}
): Promise<LoadResult> {
    const filter: Record<string, unknown> = { transcription: doc._id };
    if (opts.after && mongoose.isValidObjectId(opts.after)) {
        filter._id = { $gt: new mongoose.Types.ObjectId(opts.after) };
    }

    const limit = opts.limit && opts.limit > 0 ? opts.limit : 0;

    let query = TranscriptSegmentModel.find(filter)
        .sort({ _id: 1 })
        .select("seq name profile text timestamp");
    // Over-fetch one row so we can report hasMore without a second count.
    if (limit) query = query.limit(limit + 1);

    const rows = await query.lean();

    // Legacy fallback: only when this is a true initial read (no cursor) and
    // the doc has never written to the new collection. Returned whole — these
    // docs are 16 MB-bounded and the migration converts them to the new model.
    const usingLegacy =
        rows.length === 0 &&
        !opts.after &&
        (!doc.segmentCount || doc.segmentCount === 0);

    if (usingLegacy) {
        const legacy = (doc.transcriptions ?? []) as SegmentView[];
        return { segments: legacy, cursor: null, hasMore: false };
    }

    const hasMore = limit > 0 && rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const segments: SegmentView[] = page.map((r: any) => ({
        _id: String(r._id),
        seq: r.seq,
        name: r.name,
        profile: r.profile ?? "",
        text: r.text,
        timestamp: r.timestamp,
    }));

    const cursor = page.length
        ? String(page[page.length - 1]._id)
        : (opts.after ?? null);

    return { segments, cursor, hasMore };
}

// Paginated, id-only segment loader for the detail (infinite-scroll) view.
// Unlike loadTranscriptSegments(doc), this NEVER loads the whole embedded
// array into memory:
//   • new per-segment model → cursor = segment _id (ascending).
//   • legacy embedded array → cursor = "legacy:<offset>", and only a WINDOW of
//     the array is pulled via a $slice projection, so a long un-migrated
//     transcript still loads (and scrolls) a page at a time.
// Caller passes the transcription id + its segmentCount (so we can tell which
// model is in play without re-reading the doc).
export async function loadSegmentsPage(
    transcriptionId: mongoose.Types.ObjectId | string,
    opts: { after?: string; limit?: number; segmentCount?: number } = {}
): Promise<LoadResult> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 0;
    const isLegacyCursor =
        typeof opts.after === "string" &&
        opts.after.startsWith(LEGACY_CURSOR_PREFIX);

    // ── New per-segment model ───────────────────────────────────────────────
    if (!isLegacyCursor) {
        const filter: Record<string, unknown> = {
            transcription: transcriptionId,
        };
        if (opts.after && mongoose.isValidObjectId(opts.after)) {
            filter._id = { $gt: new mongoose.Types.ObjectId(opts.after) };
        }

        let query = TranscriptSegmentModel.find(filter)
            .sort({ _id: 1 })
            .select("seq name profile text timestamp");
        if (limit) query = query.limit(limit + 1);
        const rows = await query.lean();

        // The new model is in play if it returned rows, the doc reports a
        // segmentCount, or we were already paging it (a non-legacy cursor).
        const newModelInUse =
            rows.length > 0 ||
            (opts.segmentCount ?? 0) > 0 ||
            !!opts.after;

        if (newModelInUse) {
            const hasMore = limit > 0 && rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            const cursor = page.length
                ? String(page[page.length - 1]._id)
                : (opts.after ?? null);
            return { segments: page.map(mapSegment), cursor, hasMore };
        }
        // Otherwise fall through to the legacy array.
    }

    // ── Legacy embedded array, windowed via $slice ──────────────────────────
    const offset = isLegacyCursor
        ? parseInt(opts.after!.slice(LEGACY_CURSOR_PREFIX.length), 10) || 0
        : 0;

    const projected = await TranscriptionModel.findById(transcriptionId, {
        transcriptions: limit ? { $slice: [offset, limit + 1] } : 1,
    }).lean();

    const arr = (projected?.transcriptions ?? []) as any[];
    const hasMore = limit > 0 && arr.length > limit;
    const page = hasMore ? arr.slice(0, limit) : arr;
    const cursor = hasMore ? `${LEGACY_CURSOR_PREFIX}${offset + limit}` : null;

    return { segments: page.map(mapSegment), cursor, hasMore };
}

// Total number of stored utterances for a transcript, dual-read aware. Used
// where an exact count matters and segmentCount might be stale/legacy.
export async function countTranscriptSegments(doc: {
    _id: mongoose.Types.ObjectId | string;
    transcriptions?: ITranscription[];
    segmentCount?: number;
}): Promise<number> {
    if (doc.segmentCount && doc.segmentCount > 0) return doc.segmentCount;
    const fromCollection = await TranscriptSegmentModel.countDocuments({
        transcription: doc._id,
    });
    if (fromCollection > 0) return fromCollection;
    return doc.transcriptions?.length ?? 0;
}
