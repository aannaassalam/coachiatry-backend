import jwt from "jsonwebtoken";
import { Namespace, Socket } from "socket.io";
import UserModel from "../model/userModel";
import TranscriptionModel from "../model/transcriptionModel";

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
            const existing = await TranscriptionModel.findOne({
                user: userId,
                meetingId,
                source: "extension",
            }).select("_id");

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

            const seqStr = seq != null ? String(seq) : "";
            const name = speaker || "Unknown";
            const timestamp = new Date(ts);

            // Upsert-by-seq: while the extension grows the same caption row
            // (one speaker continuing to talk) we keep updating the same
            // segment in place rather than pushing duplicates. If the
            // client didn't supply a seq, fall back to $push for backward
            // compat.
            if (seqStr) {
                const result = await TranscriptionModel.updateOne(
                    { _id: docId, "transcriptions.seq": seqStr },
                    {
                        $set: {
                            "transcriptions.$.name": name,
                            "transcriptions.$.text": text,
                            "transcriptions.$.timestamp": timestamp,
                        },
                    }
                );
                if (result.matchedCount === 0) {
                    await TranscriptionModel.updateOne(
                        { _id: docId },
                        {
                            $push: {
                                transcriptions: {
                                    seq: seqStr,
                                    name,
                                    profile: "",
                                    text,
                                    timestamp,
                                },
                            },
                        }
                    );
                }
            } else {
                await TranscriptionModel.updateOne(
                    { _id: docId },
                    {
                        $push: {
                            transcriptions: {
                                name,
                                profile: "",
                                text,
                                timestamp,
                            },
                        },
                    }
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
            const doc = await TranscriptionModel.findOne(filter).select(
                "_id transcriptions"
            );
            if (!doc) {
                return ack?.({ ok: true });
            }

            if (!doc.transcriptions || doc.transcriptions.length === 0) {
                await TranscriptionModel.deleteOne({ _id: doc._id });
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
