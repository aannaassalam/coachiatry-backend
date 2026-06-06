import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import MessageModel from "../model/messageModel";
import ChatModel from "../model/chatModel";
import admin from "../utils/firebaseAdmin";
import { sendMessageNotification } from "../utils/messagingNotifications";

// Track which users are online (for status checks like "is friend online?")
const onlineUsers = new Map<string, Set<string>>();
const socketToUser = new Map<string, string>();

export default (io: Server, socket: Socket) => {
    console.log("Chat socket ready for:", socket.id);

    socket.on("user_online", async ({ userId }) => {
        // Clean up any previous mapping for this socket (e.g. re-emitted user_online)
        const prevUserId = socketToUser.get(socket.id);
        if (prevUserId && prevUserId !== userId) {
            onlineUsers.get(prevUserId)?.delete(socket.id);
            if (!onlineUsers.get(prevUserId)?.size) {
                onlineUsers.delete(prevUserId);
            }
            socket.leave(`user:${prevUserId}`);
        }

        if (!onlineUsers.has(userId)) {
            onlineUsers.set(userId, new Set());
        }
        onlineUsers.get(userId)!.add(socket.id);
        socketToUser.set(socket.id, userId);
        socket.data.userId = userId;

        // Join a user-specific room so all devices for this user receive events
        socket.join(`user:${userId}`);

        // Verify the socket actually joined the room
        const roomMembers = await io.in(`user:${userId}`).fetchSockets();
        console.log(
            `🟢 User online: ${userId}, socket: ${socket.id}, rooms: [${[...socket.rooms]}], user room size: ${roomMembers.length}`,
        );

        const userObjectId =
            mongoose.Types.ObjectId.createFromHexString(userId);

        const chats = await ChatModel.find({
            "members.user": userObjectId,
        }).select("_id");
        const chatIds = chats.map((c) => c._id);

        if (chatIds.length > 0) {
            // Step 2: Update messages from other users in those chats
            const result = await MessageModel.updateMany(
                {
                    chat: { $in: chatIds },
                    sender: { $ne: userId },
                    status: "sent",
                },
                { $set: { status: "delivered" } },
            );

            console.log("✅ Delivered update count:", result.modifiedCount);
        }

        io.emit("user_status_update", { userId, status: "online" });
    });

    // Join room
    socket.on("join_room", ({ chatId, userId, friendId, isGroup }) => {
        socket.join(chatId);
        socket.data.userId = userId;
        socket.data.activeChatId = chatId;

        // Tell the current user if their friend is online
        if (!isGroup) {
            const isFriendOnline = onlineUsers.has(friendId);
            socket.emit("user_status_update", {
                userId: friendId,
                status: isFriendOnline ? "online" : "offline",
            });
        }
    });

    // Leave room
    socket.on("leave_room", ({ chatId, userId }) => {
        socket.leave(chatId);
        socket.data.activeChatId = null;
        socket.to(chatId).emit("user_left", { userId });
    });

    // Send message
    socket.on("send_message", async (data, callback) => {
        try {
            // Validate required fields
            if (!data.chat || !data.sender) {
                if (typeof callback === "function") {
                    callback({
                        success: false,
                        error: "Missing required fields: chat, sender",
                    });
                }
                return;
            }

            // Verify sender is a member of the chat
            const chat = await ChatModel.findById(data.chat);
            if (!chat) {
                console.error(
                    `❌ send_message: chat not found for id=${data.chat}`,
                );
                if (typeof callback === "function") {
                    callback({ success: false, error: "Chat not found" });
                }
                return;
            }

            const senderId = data.sender.toString();
            const chatMembers = chat.members.map((m) => m.user.toString());

            if (!chatMembers.includes(senderId)) {
                console.error(
                    `❌ send_message: user ${senderId} is not a member of chat ${data.chat}`,
                );
                if (typeof callback === "function") {
                    callback({
                        success: false,
                        error: "You are not a member of this chat",
                    });
                }
                return;
            }

            const message = await MessageModel.create({
                chat: data.chat,
                sender: data.sender,
                type: data.type || "text",
                content: data.content,
                files: data.files,
                replyTo: data.replyTo,
                sentAt: new Date(),
                status: "sent",
            });

            const populatedMessage = await message.populate([
                {
                    path: "replyTo",
                    populate: {
                        path: "sender",
                    },
                },
                {
                    path: "sender",
                },
            ]);

            const otherMembers = chatMembers.filter(
                (id) => id !== senderId,
            );

            const recipientOnline = otherMembers.some((memberId) =>
                onlineUsers.has(memberId),
            );

            console.log(
                `📨 send_message: chat=${data.chat}, sender=${senderId}, recipientOnline=${recipientOnline}`,
            );

            // Update status to "delivered" if any recipient is online
            if (recipientOnline) {
                await MessageModel.updateOne(
                    { _id: message._id },
                    { $set: { status: "delivered" } },
                );
                populatedMessage.status = "delivered";
            }

            const chatIdStr = data.chat.toString();

            // Update lastMessage on the chat document
            await ChatModel.updateOne(
                { _id: data.chat },
                {
                    $set: {
                        lastMessage: {
                            message: message._id,
                            sender: message.sender,
                            content: message.content,
                            type: message.type,
                            status: populatedMessage.status,
                            sentAt: message.createdAt,
                        },
                    },
                },
            );

            // Emit new_message to everyone in the chat room
            io.to(chatIdStr).emit("new_message", {
                ...populatedMessage.toJSON(),
                tempId: data.tempId,
            });

            const conversationPayload = {
                chatId: chatIdStr,
                lastMessage: populatedMessage.toJSON(),
                updatedAt: new Date().toISOString(),
            };

            // Notify all members about conversation update
            for (const memberId of chatMembers) {
                if (memberId === senderId) {
                    // For the sender: notify their OTHER devices (not the one that sent)
                    socket
                        .to(`user:${memberId}`)
                        .emit("conversation_updated", conversationPayload);
                } else {
                    // For other members: notify all their devices
                    io.to(`user:${memberId}`).emit(
                        "conversation_updated",
                        conversationPayload,
                    );
                }
            }

            // Send push notification (fire-and-forget, but never let a
            // rejection become an unhandled promise rejection).
            sendMessageNotification({
                chatId: chatIdStr,
                senderId,
                message: populatedMessage,
            }).catch((err) =>
                console.error("[push] notification failed:", err),
            );

            // Acknowledge success to the sender
            if (typeof callback === "function") {
                callback({
                    success: true,
                    messageId: message._id,
                    status: populatedMessage.status,
                });
            }
        } catch (error) {
            console.error("❌ send_message error:", error);
            if (typeof callback === "function") {
                callback({
                    success: false,
                    error: "Failed to send message",
                });
            }
        }
    });

    socket.on("mark_seen", async ({ chatId, userId }) => {
        try {
            const chat = await ChatModel.findById(chatId);
            if (!chat) return;

            const userObjectId = new mongoose.Types.ObjectId(userId);

            // ✅ 1. Update lastReadAt for that user
            await ChatModel.updateOne(
                { _id: chatId, "members.user": userObjectId },
                { $set: { "members.$.lastReadAt": new Date() } },
            );

            // ✅ 2. Find messages that are newer than user's previous lastReadAt
            const member = chat.members.find(
                (m) => m.user.toString() === userId,
            );
            const previousLastReadAt = member?.lastReadAt || new Date(0);

            const unseenMessages = await MessageModel.find({
                chat: chatId,
                sender: { $ne: userId },
                createdAt: { $gt: previousLastReadAt },
                status: { $in: ["sent", "delivered"] },
            }).select("_id");

            if (unseenMessages.length > 0) {
                // ✅ 3. Mark those messages as seen (globally)
                await MessageModel.updateMany(
                    { _id: { $in: unseenMessages.map((m) => m._id) } },
                    { $set: { status: "seen" } },
                );

                // ✅ 4. Emit updates to chat room
                io.to(chatId).emit("message_seen_update_bulk", {
                    chatId,
                    userId,
                    messageIds: unseenMessages.map((m) => m._id),
                });
            }
        } catch (error) {
            console.error("❌ mark_seen error:", error);
        }
    });

    // add reaction
    socket.on("add_reaction", async ({ messageId, userId, emoji }) => {
        try {
            const message = await MessageModel.findById(messageId);

            if (!message) return;

            // check if user already reacted with same emoji
            const existing = message.reactions.find(
                (r) => r.user.toString() === userId && r.emoji === emoji,
            );

            if (existing) {
                // toggle off → remove
                message.reactions = message.reactions.filter(
                    (r) => !(r.user.toString() === userId && r.emoji === emoji),
                );
            } else {
                // replace old emoji if user reacted with different one
                message.reactions = message.reactions.filter(
                    (r) => r.user.toString() !== userId,
                );

                // push new reaction
                message.reactions.push({
                    user: userId,
                    emoji,
                    reactedAt: new Date(),
                });
            }

            await message.save();

            // broadcast updated message
            io.to(message.chat.toString()).emit("reaction_updated", {
                messageId: message._id,
                reactions: message.reactions,
            });
        } catch (err) {
            console.error("Error in add_reaction", err);
        }
    });

    // remove reaction (explicit)
    socket.on("remove_reaction", async ({ messageId, userId }) => {
        try {
            const message = await MessageModel.findByIdAndUpdate(
                messageId,
                {
                    $pull: { reactions: { user: userId } },
                },
                { new: true },
            );

            if (!message) return;

            io.to(message.chat.toString()).emit("reaction_updated", {
                messageId: message._id,
                reactions: message.reactions,
            });
        } catch (err) {
            console.error("Error in remove_reaction", err);
        }
    });

    // Typing indicators — include chatId so frontend can filter by active chat
    socket.on("typing", ({ chatId, userId }) => {
        socket.to(chatId).emit("user_typing", { chatId, userId });
    });

    socket.on("stop_typing", ({ chatId, userId }) => {
        socket.to(chatId).emit("user_stop_typing", { chatId, userId });
    });

    // Disconnect
    socket.on("disconnect", () => {
        const userId = socketToUser.get(socket.id);
        if (!userId) return;

        socketToUser.delete(socket.id);
        onlineUsers.get(userId)?.delete(socket.id);

        console.log(
            `🔌 Socket disconnected: ${socket.id}, user: ${userId}, remaining: ${onlineUsers.get(userId)?.size ?? 0}`,
        );

        if (!onlineUsers.get(userId)?.size) {
            onlineUsers.delete(userId);
            console.log("🔴 User offline:", userId);
            io.emit("user_status_update", { userId, status: "offline" });
        }
        // Note: Socket.IO automatically removes the socket from all rooms on disconnect
    });
};
