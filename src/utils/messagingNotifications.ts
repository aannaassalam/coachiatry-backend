import ChatModel from "../model/chatModel";
import UserModel from "../model/userModel";
import admin from "./firebaseAdmin";

const CHAT_CHANNEL_ID = "chat-messages";

/**
 * Send a chat-message push notification to every recipient of a chat except
 * the sender.
 *
 * Payload shape is deliberately data-rich:
 *   - `notification.title` / `body` are kept so the OS can render a fallback
 *     when the app hasn't customised the notification yet (cold start before
 *     the JS runtime is up; iOS NSE missing).
 *   - The full `data` block is what the client uses to compose its enriched
 *     MESSAGING-style notification (Android) or to populate the NSE-served
 *     communication notification (iOS).
 *
 * Per-recipient values (e.g. unread count) would require splitting the
 * multicast into per-token sends — this version intentionally keeps it as a
 * single multicast and lets the client maintain its own counter.
 */
export const sendMessageNotification = async ({
    chatId,
    senderId,
    message,
}: {
    chatId: string;
    senderId: string;
    message: any;
}) => {
    const chat = await ChatModel.findById(chatId);
    if (!chat) return;

    const recipients = chat.members.filter(
        (m) => m.user.toString() !== senderId.toString()
    );
    if (recipients.length === 0) return;

    const users = await UserModel.find(
        { _id: { $in: recipients.map((r) => r.user) } },
        "fcmTokens fullName photo"
    );
    const senderUser = await UserModel.findById(senderId, "fullName photo");

    const deviceTokens = users
        .flatMap((u) => u.fcmTokens || [])
        .filter(Boolean);
    if (deviceTokens.length === 0) return;

    const isGroup = chat.type === "group";
    const senderName = senderUser?.fullName || "Someone";
    const senderImage = senderUser?.photo || "";
    const chatName = isGroup
        ? (chat.name as string) || "Group chat"
        : senderName;
    const chatImage = isGroup
        ? (chat.groupPhoto as string) || ""
        : senderImage;

    const filesLength = message.files?.length ?? 0;
    const plural = filesLength > 1 ? "s" : "";

    const body =
        message.type === "text"
            ? message.content || ""
            : message.type === "image"
              ? `📷 ${filesLength} Photo${plural}`
              : message.type === "video"
                ? `📹 ${filesLength} Video${plural}`
                : message.type === "file"
                  ? `📁 ${filesLength} File${plural}`
                  : "New Message";

    const sentAt =
        message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : typeof message.createdAt === "string"
              ? message.createdAt
              : new Date().toISOString();

    // FCM requires `data` values to be strings.
    const data: Record<string, string> = {
        type: "chat",
        chatId: chatId.toString(),
        senderId: senderId.toString(),
        senderName,
        senderImage,
        chatName,
        chatImage,
        isGroup: isGroup ? "true" : "false",
        messageId: message._id ? String(message._id) : "",
        messageType: String(message.type || "text"),
        sentAt,
        body,
    };

    // Platform split:
    //   - Android: pure data message (no `notification` block, no
    //     `android.notification`). Skips OS auto-rendering — the client's
    //     setBackgroundMessageHandler composes the Notifee notification.
    //     This is the only way to avoid the FCM + Notifee duplicate banners.
    //   - iOS: APNS alert + mutableContent so the system renders the
    //     notification and the NSE attaches the avatar. No duplicate because
    //     iOS doesn't render notifee output while the APNS alert is showing.
    const response = await admin.messaging().sendEachForMulticast({
        tokens: deviceTokens,
        data,
        android: {
            priority: "high",
            collapseKey: `chat-${chatId.toString()}`,
        },
        apns: {
            headers: {
                "apns-priority": "10",
                "apns-push-type": "alert",
            },
            payload: {
                aps: {
                    alert: {
                        title: chatName,
                        body: isGroup ? `${senderName}: ${body}` : body,
                    },
                    sound: "default",
                    threadId: chatId.toString(),
                    mutableContent: true,
                    category: "chat-message",
                },
            },
        },
        // Web: pure data message. The service worker's onBackgroundMessage
        // composes the notification, matching the Android approach and
        // keeping the same `data` payload across all three platforms.
        webpush: {
            headers: {
                Urgency: "high",
                TTL: "86400",
            },
        },
    });

    const failedTokens: string[] = [];
    response.responses.forEach((resp, idx) => {
        if (!resp.success) failedTokens.push(deviceTokens[idx]);
    });
    if (failedTokens.length > 0) {
        await UserModel.updateMany(
            { fcmTokens: { $in: failedTokens } },
            { $pull: { fcmTokens: { $in: failedTokens } } }
        );
    }
};
