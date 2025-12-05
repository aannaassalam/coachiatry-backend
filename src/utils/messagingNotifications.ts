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
    // 1. Get group
    const chat = await ChatModel.findById(chatId);
    if (!chat) return;

    // 2. Get members except sender
    const recipients = chat.members.filter(
        (id) => id.toString() !== senderId.toString()
    );

    if (recipients.length === 0) return;

    // 3. Fetch their FCM tokens
    const users = await UserModel.find(
        { _id: { $in: recipients.map((r) => r.user) } },
        "fcmTokens fullName photo"
    );
    const senderUser = await UserModel.findById(senderId, "fullName photo");

    const details = {
        name: senderUser?.fullName,
        photo: senderUser?.photo,
    };
    if (chat.type === "group") {
        details.name = chat.name as string;
        details.photo = chat.groupPhoto as string;
    }

    let deviceTokens = users.flatMap((u) => u.fcmTokens || []).filter(Boolean);

    if (deviceTokens.length === 0) return;

    const filesLength = message.files.length;

    // 4. Prepare notification
    const payload = {
        data: {
            type: "chat",
            chatId: chatId.toString(),
            senderId: senderId.toString(),
            senderImage: details.photo || "",
            senderName: details.name,
            body:
                message.type === "text"
                    ? message.content
                    : message.type === "image"
                      ? `📷 ${filesLength} Photo${filesLength > 0 ? "s" : ""}`
                      : message.type === "video"
                        ? `📹 ${filesLength} Video${filesLength > 0 ? "s" : ""}`
                        : message.type === "file"
                          ? `📁 ${filesLength} File${filesLength > 0 ? "s" : ""}`
                          : "New Message",
        },
    };

    // 5. Send multicast
    const response = await admin.messaging().sendEachForMulticast({
        tokens: deviceTokens,
        ...payload,
    });

    // 6. Clean up invalid tokens
    const failedTokens = [];

    response.responses.forEach((resp, idx) => {
        if (!resp.success) {
            failedTokens.push(deviceTokens[idx]);
        }
    });

    if (failedTokens.length > 0) {
        await UserModel.updateMany(
            { fcmTokens: { $in: failedTokens } },
            { $pull: { fcmTokens: { $in: failedTokens } } }
        );
    }
};
