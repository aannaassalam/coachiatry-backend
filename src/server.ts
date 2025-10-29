import "dotenv/config";
import express, { Request, Response } from "express";

import http from "http";
import app from "./app";
import connectDb from "./config/db.config";
import socket from "./config/socket.config";

import "./utils/workers/messageWorker";
import "./utils/workers/taskWorker";
import { verifyRedisConnection } from "./utils/redis";

const PORT = process.env.PORT || 3001;

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
        await dbConnection.disconnect();
        const io = socket.getIO();
        if (io) {
            io.close(() => console.log("Socket server closed."));
        }
        server.close(() => {
            console.log("HTTP server closed.");
            process.exit(1);
        });
    };

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
}

bootstrap();
