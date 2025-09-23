import { Server, Socket } from "socket.io";
import MessageModel from "../model/messageModel";

export default (io: Server, socket: Socket) => {
    console.log("Chat socket ready for:", socket.id);

    // Join room
    socket.on("join_room", ({ chatId, userId }) => {
        console.log("Joined", chatId);
        socket.join(chatId);
        socket.to(chatId).emit("user_joined", { userId });
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
        io.to(data.chat).emit("new_message", {
            ...populatedMessage.toJSON(),
            tempId: data.tempId,
        });
    });

    // Message delivered
    socket.on("message_delivered", async ({ messageId, userId }) => {
        await MessageModel.findByIdAndUpdate({
            status: "delivered",
        });
        io.emit("message_delivered_update", { messageId, userId });
    });

    // Message seen
    socket.on("message_seen", async ({ messageId, userId }) => {
        await MessageModel.findByIdAndUpdate({
            status: "seen",
        });
        io.emit("message_seen_update", { messageId, userId });
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
        console.log("❌ Client disconnected:", socket.id);
    });
};
