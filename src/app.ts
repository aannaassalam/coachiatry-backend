import express, { Request, Response, NextFunction } from "express";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import compression from "compression";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss";

import cors from "cors";

import AppError from "./utils/appError";
import globalErrorHandler from "./controllers/errorController/errorController";
import v1Routes from "./routes/v1";

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

// Limit requests from same API
// const limiter = rateLimit({
//   max: 100,
//   windowMs: 60 * 60 * 1000,
//   message: "Too many requests from this IP, please try again later!",
// });

// app.use("/api", limiter);

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
