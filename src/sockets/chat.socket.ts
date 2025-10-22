import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import MessageModel from "../model/messageModel";
import ChatModel from "../model/chatModel";

const onlineUsers = new Map<string, string>();

export default (io: Server, socket: Socket) => {
    console.log("Chat socket ready for:", socket.id);

    socket.on("user_online", async ({ userId }) => {
        onlineUsers.set(userId, socket.id);
        socket.data.userId = userId;
        console.log("🟢 User online:", userId);

        const userObjectId =
            mongoose.Types.ObjectId.createFromHexString(userId);

        const chats = await ChatModel.find({
            members: userObjectId,
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
                { $set: { status: "delivered" } }
            );

            console.log("✅ Delivered update count:", result.modifiedCount);
        }

        io.emit("user_status_update", { userId, status: "online" });
    });

    // Join room
    socket.on("join_room", ({ chatId, userId, friendId, isGroup }) => {
        socket.join(chatId);
        socket.data.userId = userId;
        // console.log(`👥 ${userId} joined ${chatId}`);

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
        socket.to(chatId).emit("user_left", { userId });
    });

    // Send message
    socket.on("send_message", async (data) => {
        const message = await MessageModel.create({
            ...data,
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

        const roomSockets = await io.in(data.chat).fetchSockets();
        const recipientOnline = roomSockets.some(
            (s) => s.data?.userId && s.data.userId !== data.sender
        );

        if (recipientOnline) {
            populatedMessage.status = "delivered";
            await populatedMessage.save();
        }

        io.to(data.chat).emit("new_message", {
            ...populatedMessage.toJSON(),
            tempId: data.tempId,
        });

        const chat = await ChatModel.findById(data.chat);

        // if (chat?.type === "direct") {
        //     const recipientSocket = Array.from(
        //         io.sockets.sockets.values()
        //     ).find(
        //         (s) =>
        //             s.data?.userId ===
        //             chat.members
        //                 .find((m) => m.user.toString() !== data.sender)
        //                 ?.user.toString()
        //     );

        //     if (recipientSocket) {
        //         populatedMessage.status = "delivered";
        //         await populatedMessage.save();
        //         recipientSocket.emit("new_message", populatedMessage);
        //     }
        // } else {
        //     // group chat
        //     for (const member of chat.members) {
        //         if (member.user.toString() !== data.sender.toString()) {
        //             const receiverSocket = Array.from(
        //                 io.sockets.sockets.values()
        //             ).find((s) => s.data?.userId === member.user.toString());
        //             if (receiverSocket) {
        //                 receiverSocket.emit("new_message", populatedMessage);
        //             }
        //         }
        //     }
        // }

        const chatMembers = chat.members.map((m) => m.user.toString());

        for (const memberId of chatMembers) {
            // Don't notify the sender — they already know
            if (memberId === data.sender.toString()) continue;

            const socketId = onlineUsers.get(memberId);
            console.log(socketId, memberId);
            if (socketId) {
                io.to(socketId).emit("conversation_updated", {
                    chatId: chat._id,
                    lastMessage: populatedMessage,
                    updatedAt: new Date().toISOString(),
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
                { $set: { "members.$.lastReadAt": new Date() } }
            );

            // ✅ 2. Find messages that are newer than user’s previous lastReadAt
            const member = chat.members.find(
                (m) => m.user.toString() === userId
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
                // Note: this is simplistic — ideally you track seen per user in Message if you want group seen-by-lists
                await MessageModel.updateMany(
                    { _id: { $in: unseenMessages.map((m) => m._id) } },
                    { $set: { status: "seen" } }
                );

                // ✅ 4. Emit updates to chat room and to others’ sockets
                io.to(chatId).emit("message_seen_update_bulk", {
                    chatId,
                    userId,
                    messageIds: unseenMessages.map((m) => m._id),
                });
            }

            // ✅ 5. Optional: emit a conversation_updated so that other users’ chat lists can reflect “seen” state
            // const onlineUsersMap = onlineUsers; // from your existing global map
            // for (const member of chat.members) {
            //     const socketId = onlineUsersMap.get(member.user.toString());
            //     if (socketId && member.user.toString() !== userId) {
            //         io.to(socketId).emit("conversation_updated", {
            //             chatId: chat._id,
            //             lastSeenBy: userId,
            //             updatedAt: new Date().toISOString(),
            //         });
            //     }
            // }
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
                (r) => r.user.toString() === userId && r.emoji === emoji
            );

            if (existing) {
                // toggle off → remove
                message.reactions = message.reactions.filter(
                    (r) => !(r.user.toString() === userId && r.emoji === emoji)
                );
            } else {
                // replace old emoji if user reacted with different one
                message.reactions = message.reactions.filter(
                    (r) => r.user.toString() !== userId
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
                { new: true }
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

    // Typing indicators
    socket.on("typing", ({ chatId, userId }) => {
        socket.to(chatId).emit("user_typing", { userId });
    });

    socket.on("stop_typing", ({ chatId, userId }) => {
        socket.to(chatId).emit("user_stop_typing", { userId });
    });

    // Disconnect
    socket.on("disconnect", () => {
        const userId = socket.data.userId;
        if (!userId) return;
        onlineUsers.delete(userId);
        console.log("🔴 User offline:", userId);
        io.emit("user_status_update", { userId, status: "offline" });
    });
};
