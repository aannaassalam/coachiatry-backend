import ChatModel from "../model/chatModel";
import UserModel from "../model/userModel";
import admin from "./firebaseAdmin";

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

    const data = {
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

    const response = await admin.messaging().sendEachForMulticast({
        tokens: deviceTokens,
        notification: {
            title: chatName,
            body,
            ...(chatImage ? { imageUrl: chatImage } : {}),
        },
        data,
        android: {
            priority: "high",
        },
        apns: {
            payload: {
                aps: {
                    sound: "default",
                    contentAvailable: true,
                },
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
