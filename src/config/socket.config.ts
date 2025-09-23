import { Server } from "socket.io";
import type { Server as HTTPServer } from "http";
import registerSocketHandlers from "../sockets";

let io: Server | null;

function initSocket(server: HTTPServer) {
    io = new Server(server, {
        cors: { origin: "*" }, // configure properly in prod
    });
    console.log("loaded new");

    io.on("connection", (socket) => {
        console.log("🔥 New client connected:", socket.id);

        // Load all socket modules
        registerSocketHandlers(io, socket);

        socket.on("disconnect", () => {
            console.log("❌ Client disconnected:", socket.id);
        });
    });
}

function getIO() {
    // if (!io) throw new Error("Socket.io not initialized");
    return io;
}

export default { initSocket, getIO };
