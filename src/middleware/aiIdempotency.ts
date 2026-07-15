import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";

import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { cacheDel, cacheKeys } from "../utils/cache";
import { getCacheClient } from "../utils/redis";

// Collapses concurrent duplicate AI requests from the same user.
//
// The AI routes had no protection at all, so a double-clicked "Create Tasks"
// fired two full chains — each doing a workspace read plus two Gemini calls —
// billing twice for one intent. Worse, the two responses raced: whichever
// finished last overwrote the other in the UI, so the user could see a different
// set of suggestions than the one they were shown first.
//
// The lock is released when the response finishes rather than left to expire, so
// only genuinely in-flight duplicates are rejected. A user who retries after the
// first request completes is not blocked. The TTL is only a safety net for a
// process that dies mid-request.
const LOCK_TTL_SEC = 120;

export const preventConcurrentDuplicateAI = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?._id?.toString();
        if (!userId) return next();

        const fingerprint = crypto
            .createHash("sha256")
            .update(JSON.stringify(req.body ?? {}))
            .digest("hex");
        const key = cacheKeys.aiLock(userId, fingerprint);

        let acquired: boolean;
        try {
            acquired =
                (await getCacheClient().set(
                    key,
                    "1",
                    "EX",
                    LOCK_TTL_SEC,
                    "NX"
                )) === "OK";
        } catch {
            // Redis unavailable — fail open. Losing de-duplication costs money;
            // refusing the request costs the user their feature.
            return next();
        }

        if (!acquired) {
            return next(
                new AppError(
                    "An identical request is already being processed. Please wait for it to finish.",
                    StatusCodes.CONFLICT
                )
            );
        }

        // Release on both paths: `finish` for a completed response, `close` for
        // a client that hung up mid-flight. Without `close`, an abandoned
        // request would hold the lock for the full TTL.
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            void cacheDel(key);
        };
        res.on("finish", release);
        res.on("close", release);

        next();
    }
);
