import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import compression from "compression";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss";

import cors from "cors";

import { RedisStore } from "rate-limit-redis";

import AppError from "./utils/appError";
import globalErrorHandler from "./controllers/errorController/errorController";
import v1Routes from "./routes/v1";
import { getCacheClient } from "./utils/redis";

const ORIGIN_URL = process.env.ORIGIN;

const app = express();

// 1) GLOBAL Middleware
// Set security HTTP headers
app.use(helmet());

// Gzip/deflate responses. List endpoints (e.g. tasks) return large JSON
// payloads; compression shrinks them ~5-10x on the wire at negligible CPU cost.
app.use(compression());

// Development Logging
console.log(process.env.NODE_ENV);
if (process.env.NODE_ENV === "development") {
    app.use(morgan("dev"));
}

// app.use(cors({ origin: ORIGIN_URL }))
app.use(cors({ origin: "*" }));

app.set("trust proxy", true);

// Limit requests from same API.
//
// Deliberately generous, and NOT the 100-per-hour this block used to hold while
// commented out — a normal session on a chat/AI product blows through that in
// minutes, so enabling it as written would have locked real users out. This is a
// flood/abuse ceiling, not a usage quota. Tune with RATE_LIMIT_MAX.
//
// Redis-backed so the budget is shared across instances; the default in-memory
// store gives each instance its own, so N instances silently mean N× the limit.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    message: "Too many requests from this IP, please try again later!",
    standardHeaders: true,
    legacyHeaders: false,
    store: new RedisStore({
        prefix: "rl:",
        sendCommand: (...args: string[]) =>
            getCacheClient().call(...(args as [string, ...string[]])) as any,
    }),
    validate: {
        // `trust proxy` is true below, which this check rightly flags: a client
        // can spoof X-Forwarded-For and present as a fresh IP. Silenced rather
        // than fixed here because narrowing trust proxy would also change
        // req.protocol/req.ip for the OAuth callback URL — worth doing, but as
        // its own change. Until then this limiter stops accidental hammering,
        // not a determined attacker.
        trustProxy: false,
    },
});

// The limiter must never be able to take the API down. express-rate-limit
// surfaces store failures via next(err), which would 500 every request the
// moment Redis blipped — turning optional infrastructure into a hard dependency.
// A real 429 is written to the response directly and does not pass through here,
// so swallowing errors drops the limit without dropping the request.
app.use("/api", (req, res, next) => {
    limiter(req, res, (err?: unknown) => {
        if (err) {
            console.warn(
                "[rate-limit] store unavailable, allowing request:",
                (err as Error).message
            );
        }
        next();
    });
});

// Body parser, reading data from body into req.body
app.use(express.json({ limit: "100mb" }));

app.use(express.urlencoded({ extended: true, limit: "100mb" }));

// Data sanitization against NOSQL query injection
app.use(mongoSanitize());

// Data sanitization against XSS
app.use(sanitizeXSS);

// Serving static files
app.use(express.static(`${__dirname}/public`));

// Test middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    (req as any).requestTime = new Date().toISOString();
    next();
});

// 3) Routes
app.use("/api/v1", v1Routes);

app.all("*", (req: Request, res: Response, next: NextFunction) => {
    next(new AppError(`Can't find ${req.originalUrl} on the Server!`, 404));
});

app.use(globalErrorHandler);
// Middleware to sanitize XSS
function sanitizeXSS(req: Request, res: Response, next: NextFunction) {
    for (const key in req.body) {
        if (typeof req.body[key] === "string") {
            req.body[key] = xss(req.body[key]);
        }
    }
    next();
}

export default app;
