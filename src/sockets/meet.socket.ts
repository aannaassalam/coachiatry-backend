import jwt from "jsonwebtoken";
import { Namespace, Socket } from "socket.io";
import UserModel from "../model/userModel";
import TranscriptionModel from "../model/transcriptionModel";
import TranscriptSegmentModel from "../model/transcriptSegmentModel";
import { countTranscriptSegments } from "../services/transcriptSegments.service";

type AuthedSocket = Socket & {
    data: {
        userId: string;
        transcriptionIdByMeeting?: Record<string, string>;
    };
};

export const authenticateMeetSocket = async (
    socket: Socket,
    next: (err?: Error) => void
) => {
    try {
        const token = (socket.handshake.auth as { token?: string } | undefined)
            ?.token;
        if (!token) return next(new Error("Missing auth token"));

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
            id: string;
        };
        const user = await UserModel.findById(decoded.id).select("_id");
        if (!user) return next(new Error("User no longer exists"));

        socket.data.userId = user._id.toString();
        socket.data.transcriptionIdByMeeting = {};
        next();
    } catch (err) {
        next(new Error("Authentication failed"));
    }
};

export default (_nsp: Namespace, socket: AuthedSocket) => {
    socket.on("meeting/start", async (payload, ack) => {
        try {
            const { meetingId, startedAt, url } = payload as {
                meetingId: string;
                startedAt: number;
                url: string;
            };
            if (!meetingId)
                return ack?.({ ok: false, error: "meetingId required" });

            const userId = socket.data.userId;
            // Re-recording the same meeting: reuse the existing transcription
            // and flip it back to active. A prior meeting/end sets active:false,
            // so without this a resumed session stays inactive and task
            // generation ("current meeting only") would 404.
            const existing = await TranscriptionModel.findOneAndUpdate(
                {
                    user: userId,
                    meetingId,
                    source: "extension",
                },
                { active: true },
                { new: true }
            ).select("_id");

            if (existing) {
                socket.data.transcriptionIdByMeeting![meetingId] =
                    existing._id.toString();
                return ack?.({
                    ok: true,
                    transcriptionId: existing._id.toString(),
                });
            }

            const doc = await TranscriptionModel.create({
                title: `Google Meet ${meetingId}`,
                user: userId,
                meetingId,
                startedAt: new Date(startedAt),
                transcriptions: [],
                active: true,
                source: "extension",
                // Preserve the original meet URL inside the title metadata
                // for now; if we want a dedicated field, add it to the model.
            });

            socket.data.transcriptionIdByMeeting![meetingId] =
                doc._id.toString();

            ack?.({ ok: true, transcriptionId: doc._id.toString(), url });
        } catch (err) {
            console.error("[meet] meeting/start error:", err);
            ack?.({ ok: false, error: "Failed to start meeting" });
        }
    });

    socket.on("caption", async (payload, ack) => {
        try {
            const { meetingId, seq, speaker, text, ts } = payload as {
                meetingId: string;
                seq: string | number;
                speaker: string | null;
                text: string;
                ts: number;
                final: boolean;
            };
            if (!meetingId || !text) return;

            const userId = socket.data.userId;
            let docId =
                socket.data.transcriptionIdByMeeting?.[meetingId] ?? null;

            // Fallback lookup in case meeting/start was missed on this socket.
            if (!docId) {
                const doc = await TranscriptionModel.findOne({
                    user: userId,
                    meetingId,
                    source: "extension",
                }).select("_id");
                if (!doc) {
                    ack?.({ ok: false, error: "No active transcription" });
                    return;
                }
                docId = doc._id.toString();
                socket.data.transcriptionIdByMeeting![meetingId] = docId;
            }

            // A seq is required to dedupe a retransmit of the same utterance.
            // The aggregator always supplies one; synthesize a stable fallback
            // for any legacy client that doesn't so two distinct utterances
            // can't collide on the same key.
            const seqStr =
                seq != null && String(seq) !== ""
                    ? String(seq)
                    : `auto-${ts}-${Math.random().toString(36).slice(2, 8)}`;
            const name = speaker || "Unknown";
            const timestamp = new Date(ts);

            // ONE indexed upsert against the per-segment collection. Keyed on
            // the unique {transcription, seq} index, so a retransmit updates
            // the existing segment in place and a first transmit inserts a new
            // one — O(log n), no array scan, no 16 MB document ceiling. We bump
            // the parent's segmentCount only when a NEW segment is inserted.
            const result = await TranscriptSegmentModel.updateOne(
                { transcription: docId, seq: seqStr },
                {
                    // transcription + seq come from the filter equality on
                    // insert, so they only need to live here implicitly.
                    $set: { name, text, timestamp },
                    $setOnInsert: { user: userId, profile: "" },
                },
                { upsert: true }
            );

            if (result.upsertedCount && result.upsertedCount > 0) {
                await TranscriptionModel.updateOne(
                    { _id: docId },
                    { $inc: { segmentCount: 1 } }
                );
            }

            ack?.({ ok: true });
        } catch (err) {
            console.error("[meet] caption error:", err);
            ack?.({ ok: false, error: "Failed to store caption" });
        }
    });

    socket.on("meeting/end", async (payload, ack) => {
        try {
            const { meetingId, endedAt } = payload as {
                meetingId: string;
                endedAt: number;
            };
            if (!meetingId)
                return ack?.({ ok: false, error: "meetingId required" });

            const userId = socket.data.userId;
            const filter = {
                user: userId,
                meetingId,
                source: "extension" as const,
            };

            // Garbage-collect transcripts that never captured anything —
            // user joined the meet but never clicked record, or recorded
            // briefly but no one spoke. Either way there's nothing to keep
            // around to clutter the list.
            const doc = await TranscriptionModel.findOne(filter)
                .select("_id transcriptions segmentCount")
                .lean();
            if (!doc) {
                return ack?.({ ok: true });
            }

            // Dual-read aware emptiness check — no longer loads a (potentially
            // huge) embedded array just to test length.
            const total = await countTranscriptSegments(doc);
            if (total === 0) {
                await Promise.all([
                    TranscriptionModel.deleteOne({ _id: doc._id }),
                    TranscriptSegmentModel.deleteMany({
                        transcription: doc._id,
                    }),
                ]);
                console.log(
                    `[meet] deleted empty transcription for meeting ${meetingId}`
                );
            } else {
                await TranscriptionModel.updateOne(
                    { _id: doc._id },
                    {
                        $set: {
                            endedAt: new Date(endedAt),
                            active: false,
                        },
                    }
                );
            }

            delete socket.data.transcriptionIdByMeeting?.[meetingId];
            ack?.({ ok: true });
        } catch (err) {
            console.error("[meet] meeting/end error:", err);
            ack?.({ ok: false, error: "Failed to end meeting" });
        }
    });
};
