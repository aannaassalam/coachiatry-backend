import { Server } from "socket.io";
import type { Server as HTTPServer } from "http";
import registerSocketHandlers from "../sockets";
import meetSocket, {
    authenticateMeetSocket,
} from "../sockets/meet.socket";

let io: Server | null;

function initSocket(server: HTTPServer) {
    io = new Server(server, {
        cors: { origin: "*" }, // configure properly in prod
    });

    io.on("connection", (socket) => {
        console.log("🔥 New client connected:", socket.id);

        // Load all socket modules
        registerSocketHandlers(io, socket);

        socket.on("disconnect", () => {
            console.log("❌ Client disconnected:", socket.id);
        });
    });

    // Extension's Google Meet pipeline runs on its own namespace with
    // mandatory JWT auth, so it doesn't interfere with chat sockets.
    const meetNs = io.of("/meet");
    meetNs.use(authenticateMeetSocket);
    meetNs.on("connection", (socket) => {
        const userId = socket.data.userId;
        console.log(`🎙  Meet client connected: ${socket.id} user=${userId}`);
        meetSocket(meetNs, socket as any);
        socket.on("disconnect", () => {
            console.log(`🎙  Meet client disconnected: ${socket.id}`);
        });
    });
}

function getIO() {
    // if (!io) throw new Error("Socket.io not initialized");
    return io;
}

export default { initSocket, getIO };
