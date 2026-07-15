import ChatModel from "../model/chatModel";

/**
 * Record a real (non-scheduled) message as a chat's latest activity.
 *
 * THE ONLY supported way to maintain `lastMessageAt` / `lastMessage`. Four code
 * paths create messages — the socket's send_message, the BullMQ message worker
 * (both the repeat and one-shot branches), and the task-reminder worker — and
 * before this helper existed only the first of them updated the chat document.
 * That left the denormalized fields silently wrong for every scheduled message
 * and every task reminder, which is why the conversation list re-derived them
 * with a per-chat $lookup instead of trusting them.
 *
 * `lastMessageAt` is now the conversation list's indexed sort key, so a writer
 * that skips this call doesn't just stale a preview — it puts the chat in the
 * wrong place in the list.
 *
 * Not for scheduled templates: a message with `scheduledAt` set has not been
 * sent yet, and the list filters those out. Call this when it actually goes out.
 */
// content/type/status are `unknown` rather than `string` because the message
// interfaces declare them with the `String` wrapper type; they are only ever
// passed straight through to $set here.
export async function touchChatLastMessage(message: {
    _id: unknown;
    chat: unknown;
    sender: unknown;
    content?: unknown;
    type?: unknown;
    status?: unknown;
    createdAt?: Date;
}) {
    const sentAt = message.createdAt ?? new Date();

    try {
        await ChatModel.updateOne(
            {
                _id: message.chat,
                // Only move it forward. Two near-simultaneous sends would
                // otherwise leave whichever wrote last as the preview,
                // regardless of which message is actually newer.
                $or: [
                    { lastMessageAt: { $exists: false } },
                    { lastMessageAt: null },
                    { lastMessageAt: { $lt: sentAt } },
                ],
            },
            {
                $set: {
                    lastMessageAt: sentAt,
                    lastMessage: {
                        message: message._id,
                        sender: message.sender,
                        content: message.content,
                        type: message.type,
                        status: message.status,
                        sentAt,
                    },
                },
            }
        );
    } catch (err) {
        // A failed preview update must never fail the send itself — the message
        // is already persisted by the time we get here. Worst case the chat
        // sorts stale until its next message.
        console.error(
            `[chatActivity] failed to update chat ${String(message.chat)}:`,
            (err as Error).message
        );
    }
}
