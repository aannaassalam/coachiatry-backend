import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import MessageModel from "../model/messageModel";
import ChatModel from "../model/chatModel";
import UserModel from "../model/userModel";
import admin from "../utils/firebaseAdmin";
import { canAccessChat, isChatMember } from "../utils/authorize";
import { sendMessageNotification } from "../utils/messagingNotifications";

// Track which users are online (for status checks like "is friend online?")
const onlineUsers = new Map<string, Set<string>>();
const socketToUser = new Map<string, string>();

// Debounce the "mark undelivered messages delivered" sweep per user. Mobile
// sockets reconnect frequently (network flapping), and each user_online would
// otherwise run a full scan/updateMany across all the user's chats. The entry
// is cleared when the user goes fully offline, so a genuine return from offline
// sweeps immediately.
const lastDeliveredSweep = new Map<string, number>();
const DELIVERED_SWEEP_DEBOUNCE_MS = 30_000;

/**
 * Namespace auth middleware for chat sockets. Mirrors the /meet namespace.
 * Every chat connection MUST present the same JWT used by the REST API
 * (sent as `auth: { token }` from the client). The verified user id becomes
 * `socket.data.userId` and is the ONLY trusted identity — handlers must never
 * trust a `userId` taken from an event payload. Without this, any client could
 * `join_room` on an arbitrary chat id and eavesdrop on private conversations.
 */
export const authenticateChatSocket = async (
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
        const user = await UserModel.findById(decoded.id).select("_id role");
        if (!user) return next(new Error("User no longer exists"));

        socket.data.userId = user._id.toString();
        socket.data.role = (user as { role?: string }).role;
        next();
    } catch (err) {
        next(new Error("Authentication failed"));
    }
};

// Emit a presence change only to users who share at least one chat with this
// user (via their `user:<id>` rooms), instead of io.emit to the whole platform.
// The global broadcast leaked every user's online/offline to everyone and
// fanned out O(all connected clients) on every connect/disconnect.
async function broadcastPresence(
    io: Server,
    userId: string,
    status: "online" | "offline",
) {
    try {
        const chats = await ChatModel.find({
            "members.user":
                mongoose.Types.ObjectId.createFromHexString(userId),
        }).select("members.user");

        const recipientIds = new Set<string>();
        for (const c of chats) {
            for (const m of c.members as any[]) {
                recipientIds.add(m.user.toString());
            }
        }
        recipientIds.delete(userId);

        for (const rid of recipientIds) {
            io.to(`user:${rid}`).emit("user_status_update", { userId, status });
        }
    } catch (err) {
        console.error("broadcastPresence error:", err);
    }
}

// Register the socket's authenticated owner as online: track it in `onlineUsers`,
// join its `user:<id>` room, sweep undelivered messages, and broadcast presence.
// Idempotent — safe to call more than once for the same socket.
async function markUserOnline(io: Server, socket: Socket) {
    // Identity is the verified socket owner — never trust a client payload.
    const userId: string | undefined = socket.data.userId;
    if (!userId) return;

    // Clean up any previous mapping for this socket (e.g. re-emitted user_online)
    const prevUserId = socketToUser.get(socket.id);
    if (prevUserId && prevUserId !== userId) {
        onlineUsers.get(prevUserId)?.delete(socket.id);
        if (!onlineUsers.get(prevUserId)?.size) {
            onlineUsers.delete(prevUserId);
        }
        socket.leave(`user:${prevUserId}`);
    }

    // Already tracked for this socket → nothing new to do (avoids a redundant
    // delivered-sweep + presence broadcast when both connect and an explicit
    // user_online fire).
    if (onlineUsers.get(userId)?.has(socket.id)) return;

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

    // Mark undelivered messages delivered — but at most once per debounce
    // window per user, so rapid reconnects don't hammer the DB.
    const now = Date.now();
    if (now - (lastDeliveredSweep.get(userId) ?? 0) > DELIVERED_SWEEP_DEBOUNCE_MS) {
        lastDeliveredSweep.set(userId, now);

        const userObjectId =
            mongoose.Types.ObjectId.createFromHexString(userId);

        const chats = await ChatModel.find({
            "members.user": userObjectId,
        }).select("_id");
        const chatIds = chats.map((c) => c._id);

        if (chatIds.length > 0) {
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
    }

    await broadcastPresence(io, userId, "online");
}

export default (io: Server, socket: Socket) => {
    console.log("Chat socket ready for:", socket.id);

    // Mark online as soon as an authenticated socket connects, instead of waiting
    // for the client to emit `user_online`. A client that connects but never
    // emits it (e.g. a mobile build) would otherwise stay invisible — showing as
    // offline to everyone else even while connected.
    void markUserOnline(io, socket);

    // Kept for backward compatibility and explicit reconnect re-emits; idempotent.
    socket.on("user_online", () => {
        void markUserOnline(io, socket);
    });

    // Join room
    socket.on("join_room", async ({ chatId, friendId, isGroup }) => {
        const userId: string | undefined = socket.data.userId;
        if (!userId || !chatId) return;

        // Only members (or authorized supervisors) may join a chat room and
        // receive its realtime events. Prevents joining an arbitrary chat id
        // to eavesdrop on a conversation the user has no access to.
        if (!(await canAccessChat(chatId, userId, socket.data.role))) {
            return;
        }

        socket.join(chatId);
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
    socket.on("leave_room", ({ chatId }) => {
        if (!chatId) return;
        socket.leave(chatId);
        socket.data.activeChatId = null;
        socket.to(chatId).emit("user_left", { userId: socket.data.userId });
    });

    // Send message
    socket.on("send_message", async (data, callback) => {
        try {
            // Sender identity comes from the verified socket, never the payload,
            // so a client can't send messages as another user.
            const senderId: string | undefined = socket.data.userId;

            // Validate required fields
            if (!data.chat || !senderId) {
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
                sender: senderId,
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

            // Update lastMessage on the chat document — but only if this message
            // is newer than the current lastMessage, so two near-simultaneous
            // sends can't leave the older one as the stored preview (last DB
            // write would otherwise win regardless of chronological order).
            await ChatModel.updateOne(
                {
                    _id: data.chat,
                    $or: [
                        { lastMessage: { $exists: false } },
                        { "lastMessage.sentAt": null },
                        { "lastMessage.sentAt": { $lt: message.createdAt } },
                    ],
                },
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

    socket.on("mark_seen", async ({ chatId }) => {
        try {
            // Identity is the verified socket owner, never a client payload —
            // otherwise a client could clear/forge another user's read state.
            const userId: string | undefined = socket.data.userId;
            if (!userId || !chatId) return;

            const chat = await ChatModel.findById(chatId);
            if (!chat) return;

            // Only an actual participant (the message owner/recipient) may
            // change seen status + unread count by reading. A coach / admin /
            // manager viewing a client's chat without being a member must NOT
            // alter read state — their "view" is read-only. Because mark_seen
            // is authoritative here, this guard holds no matter what any client
            // emits.
            const member = chat.members.find(
                (m) => m.user.toString() === userId,
            );
            if (!member) return;

            const userObjectId = new mongoose.Types.ObjectId(userId);

            // ✅ 1. Update lastReadAt for that user
            await ChatModel.updateOne(
                { _id: chatId, "members.user": userObjectId },
                { $set: { "members.$.lastReadAt": new Date() } },
            );

            // ✅ 2. Find messages that are newer than user's previous lastReadAt
            const previousLastReadAt = member.lastReadAt || new Date(0);

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
    socket.on("add_reaction", async ({ messageId, emoji }) => {
        try {
            const userId: string | undefined = socket.data.userId;
            if (!userId) return;

            const message = await MessageModel.findById(messageId);

            if (!message) return;

            // Only actual chat members may react (not read-only supervisors).
            if (!(await isChatMember(message.chat, userId))) return;

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

                // push new reaction (mongoose casts the string id on save)
                message.reactions.push({
                    user: userId as any,
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
    socket.on("remove_reaction", async ({ messageId }) => {
        try {
            const userId: string | undefined = socket.data.userId;
            if (!userId) return;

            // Self-scoped: only pulls the caller's own reaction.
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

    // Typing indicators — include chatId so frontend can filter by active chat.
    // Use the verified identity, and only forward for a room this socket has
    // actually joined (join_room is access-guarded), so typing can't be spoofed
    // into a chat the user isn't in.
    socket.on("typing", ({ chatId }) => {
        const userId: string | undefined = socket.data.userId;
        if (!userId || !chatId || !socket.rooms.has(chatId)) return;
        socket.to(chatId).emit("user_typing", { chatId, userId });
    });

    socket.on("stop_typing", ({ chatId }) => {
        const userId: string | undefined = socket.data.userId;
        if (!userId || !chatId || !socket.rooms.has(chatId)) return;
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
            // Fully offline → drop the debounce entry so a genuine return from
            // offline runs the delivered sweep immediately (rather than waiting
            // out the window).
            lastDeliveredSweep.delete(userId);
            console.log("🔴 User offline:", userId);
            void broadcastPresence(io, userId, "offline");
        }
        // Note: Socket.IO automatically removes the socket from all rooms on disconnect
    });
};
