import { Server } from "socket.io";
import type { Server as HTTPServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import registerSocketHandlers from "../sockets";
import { authenticateChatSocket } from "../sockets/chat.socket";
import meetSocket, {
    authenticateMeetSocket,
} from "../sockets/meet.socket";
import { getCacheClient } from "../utils/redis";
import { startPresenceHeartbeat } from "../utils/presence";

let io: Server | null;
let adapterClients: { pub: ReturnType<typeof getCacheClient>; sub: ReturnType<typeof getCacheClient> } | null = null;

function initSocket(server: HTTPServer) {
    io = new Server(server, {
        cors: { origin: "*" }, // configure properly in prod
    });

    attachRedisAdapter(io);
    startPresenceHeartbeat();

    // Chat (default namespace) now requires the same JWT as the REST API.
    // Client must connect with `auth: { token }`.
    io.use(authenticateChatSocket);

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

/**
 * Without this, every broadcast is confined to the instance that made it: a
 * message sent through instance A never reaches a recipient connected to B.
 * It also silently breaks the BullMQ workers, which emit scheduled messages
 * from whichever instance happened to pick up the job.
 *
 * The adapter needs its OWN connections and cannot borrow the shared cache
 * client — once a connection enters subscriber mode it can no longer run
 * ordinary commands. duplicate() gives fresh sockets with the same config.
 */
function attachRedisAdapter(server: Server) {
    try {
        const pub = getCacheClient().duplicate();
        const sub = pub.duplicate();

        // Without listeners these emit unhandled 'error' events on every
        // reconnect. Broadcasts still deliver locally when Redis is down, so a
        // blip degrades to single-instance behavior instead of dropping events.
        pub.on("error", (err) =>
            console.error("[socket] adapter pub error:", err.message)
        );
        sub.on("error", (err) =>
            console.error("[socket] adapter sub error:", err.message)
        );

        server.adapter(createAdapter(pub, sub));
        adapterClients = { pub, sub };
        console.log("✅ Socket.IO Redis adapter attached");
    } catch (err) {
        // Never let this take the socket server down — a single instance with a
        // local adapter still serves everyone connected to it.
        console.error(
            "⚠ Socket.IO Redis adapter failed to attach; falling back to in-memory (single-instance broadcasts only):",
            (err as Error).message
        );
    }
}

function getIO() {
    // if (!io) throw new Error("Socket.io not initialized");
    return io;
}

async function closeAdapterClients() {
    if (!adapterClients) return;
    const { pub, sub } = adapterClients;
    adapterClients = null;
    await Promise.allSettled([pub.quit(), sub.quit()]);
}

export default { initSocket, getIO, closeAdapterClients };
