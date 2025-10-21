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

        const userObjectId = new mongoose.Types.ObjectId(userId);

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
    socket.on("join_room", ({ chatId, userId, friendId }) => {
        socket.join(chatId);
        socket.data.userId = userId;
        // console.log(`👥 ${userId} joined ${chatId}`);

        // Tell the current user if their friend is online
        const isFriendOnline = onlineUsers.has(friendId);
        socket.emit("user_status_update", {
            userId: friendId,
            status: isFriendOnline ? "online" : "offline",
        });
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

        const chat = await ChatModel.findById(data.chat).select("members");
        if (chat) {
            chat.members.forEach((memberId) => {
                if (memberId.user.toString() !== data.sender.toString()) {
                    const receiverSocket = Array.from(
                        io.sockets.sockets.values()
                    ).find((s) => s.data?.userId === memberId.user.toString());
                    if (receiverSocket) {
                        console.log("socket found", receiverSocket.id);
                        receiverSocket.emit("new_message", populatedMessage);
                    }
                }
            });
        }
    });

    socket.on("mark_seen", async ({ chatId, userId }) => {
        const updated = await MessageModel.updateMany(
            {
                chat: chatId,
                sender: { $ne: userId },
                status: { $in: ["sent", "delivered"] },
            },
            { $set: { status: "seen" } }
        );

        if (updated.modifiedCount > 0) {
            io.to(chatId).emit("message_seen_update_bulk", { chatId, userId });
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
