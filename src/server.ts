import "dotenv/config";
import express, { Request, Response } from "express";

import http from "http";
import app from "./app";
import connectDb from "./config/db.config";
import socket from "./config/socket.config";

import "./utils/workers/messageWorker";
import "./utils/workers/taskWorker";
import { closeRedis, verifyRedisConnection } from "./utils/redis";
import {
    clearLocalPresence,
    stopPresenceHeartbeat,
} from "./utils/presence";
import { registerReferenceInvalidation } from "./utils/referenceData";

// Must run before any category/status write, so the cache can't outlive an edit.
registerReferenceInvalidation();

const PORT = process.env.PORT || 3001;

// Process-level safety net. A single rejected promise deep inside a socket
// handler or background worker used to be able to take the whole server down
// (Node terminates on unhandled rejections), which killed every other user's
// live meeting along with it. Log loudly and keep serving — a bad caption
// write must not become a fleet-wide outage. (Per-request errors are still
// caught and handled locally; this only catches what escaped.)
process.on("unhandledRejection", (reason) => {
    console.error("[server] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[server] Uncaught exception:", err);
});

// function errorHandler(
//    err: any,
//    _req: Request,
//    res: Response,
//    _next: NextFunction
// ) {
//    console.error(err)

//    res.status(500).json({
//       response: RESPONSES.ERROR,
//       message: err.message || 'Internal Server Error',
//    })
// }

async function bootstrap() {
    const dbConnection = await connectDb();

    app.use(
        express.json({
            limit: "100mb",
        })
    );

    verifyRedisConnection().then((success) => {
        if (!success) {
            console.warn(
                "⚠ Redis is not reachable. App will continue without caching or sessions."
            );
        }
    });

    // app.use(errorHandler)

    app.get("/health", (_req: Request, res: Response) =>
        res.status(200).json({ status: "ok" })
    );

    const server = http.createServer(app);

    socket.initSocket(server);

    server.listen(PORT, () => {
        console.log(`Listening on PORT ${PORT}`);
    });

    server.on("error", (err) => {
        console.log(`Error: ${err}`);
    });

    const gracefulShutdown = async () => {
        console.log("Received shutdown signal. Shutting down Gracefully.");

        // Presence first, and before Redis closes: drop this instance's sockets
        // from the shared sets so its users aren't shown online until their
        // entries age out.
        stopPresenceHeartbeat();
        await clearLocalPresence();

        const io = socket.getIO();
        if (io) {
            io.close(() => console.log("Socket server closed."));
        }
        await socket.closeAdapterClients();

        await dbConnection.disconnect();
        await closeRedis();
        server.close(() => {
            console.log("HTTP server closed.");
            process.exit(1);
        });
    };

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
}

bootstrap();
