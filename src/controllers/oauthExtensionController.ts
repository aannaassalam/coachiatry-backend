import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { StatusCodes } from "http-status-codes";
import jwt from "jsonwebtoken";

import UserModel from "../model/userModel";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { getCacheClient } from "../utils/redis";

// ─────────────────────────────────────────────────────────────────────────────
// Server-mediated Google OAuth for the Chrome extension.
//
// Why server-mediated? It keeps the Google Cloud Console config simple — the
// only redirect URI Google needs to know about is THIS backend's callback,
// not every extension's chromiumapp.org URL. The backend then 302s back to
// the extension's chromiumapp.org redirect URI with the issued JWT.
//
// Flow:
//   1. Extension opens chrome.identity.launchWebAuthFlow against
//      `${API}/api/v1/auth/google/extension-start?return_to=<chromiumapp_url>`
//   2. extensionStart stores `state → return_to` in Redis (5 min TTL) and
//      302s to Google's consent screen with this backend's callback URL.
//   3. Google authenticates the user, redirects to extensionCallback.
//   4. extensionCallback exchanges the code, finds the user (REJECTS new-
//      account creation per the extension-signup-block requirement), signs
//      a JWT, and 302s back to the stored return_to URL with `?token=...`
//      and `?user=<base64 JSON>`.
//   5. launchWebAuthFlow resolves with that final URL; the extension parses
//      out the token and user payload.
//
// Operational requirements:
//   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` env vars must be set.
//   - The OAuth client's Authorized redirect URIs must include this
//     backend's callback URL (computed in getCallbackUrl).
//   - Optional: set `API_PUBLIC_URL` env var to pin the callback's host
//     when running behind a proxy. Falls back to req.protocol/req.host.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_TTL_SECONDS = 300;
// Matches `https://<extension-id>.chromiumapp.org[/anything]` only — guards
// against open-redirect abuse since we 302 back to this URL with a JWT.
const RETURN_TO_PATTERN = /^https:\/\/[a-z0-9-]+\.chromiumapp\.org(\/.*)?$/i;

function getCallbackUrl(req: Request): string {
    const base =
        process.env.API_PUBLIC_URL ??
        `${req.protocol}://${req.get("host")}`;
    return `${base}/api/v1/auth/google/extension-callback`;
}

function signAppToken(userId: string): string {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET!, {
        // Match the "app" platform behavior used by createSendToken in
        // authController — long-lived tokens since extensions can't easily
        // re-prompt for credentials.
        expiresIn: "36500d",
    } as jwt.SignOptions);
}

export const extensionStart = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const returnTo = (req.query.return_to as string) || "";
        if (!RETURN_TO_PATTERN.test(returnTo)) {
            return next(
                new AppError(
                    "Invalid return_to (must be a chromiumapp.org URL)",
                    StatusCodes.BAD_REQUEST
                )
            );
        }

        if (!process.env.GOOGLE_CLIENT_ID) {
            return next(
                new AppError(
                    "GOOGLE_CLIENT_ID is not configured on the backend",
                    StatusCodes.INTERNAL_SERVER_ERROR
                )
            );
        }

        const state = crypto.randomBytes(24).toString("hex");
        // Not wrapped in a fallback on purpose: if this write fails, the
        // callback has no state to validate against, so the flow must fail here
        // rather than send the user to Google for a login we can't complete.
        await getCacheClient().set(
            `oauth_ext:${state}`,
            returnTo,
            "EX",
            STATE_TTL_SECONDS
        );

        const params = new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            redirect_uri: getCallbackUrl(req),
            response_type: "code",
            scope: "openid email profile",
            state,
            access_type: "online",
            prompt: "select_account",
        });

        res.redirect(
            `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
        );
    }
);

export const extensionCallback = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const code = req.query.code as string | undefined;
        const state = req.query.state as string | undefined;
        const errorParam = req.query.error as string | undefined;

        if (errorParam) {
            // User declined consent at Google's prompt, or Google returned
            // an error. We can't redirect back to the extension here because
            // we never validated state — so just show a plain page.
            return res
                .status(400)
                .type("text/plain")
                .send(
                    `Google sign-in failed: ${errorParam}. You can close this tab.`
                );
        }
        if (!code || !state) {
            return next(
                new AppError(
                    "Missing code or state from Google",
                    StatusCodes.BAD_REQUEST
                )
            );
        }

        const redis = getCacheClient();
        const returnTo = await redis.get(`oauth_ext:${state}`);
        // One-time use — delete regardless of validity below.
        if (returnTo) await redis.del(`oauth_ext:${state}`);

        if (!returnTo || !RETURN_TO_PATTERN.test(returnTo)) {
            return next(
                new AppError(
                    "OAuth state expired or was tampered with. Please try again.",
                    StatusCodes.BAD_REQUEST
                )
            );
        }

        const oauth2Client = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            getCallbackUrl(req)
        );
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.id_token) {
            return next(
                new AppError(
                    "Google did not return an ID token",
                    StatusCodes.BAD_REQUEST
                )
            );
        }
        const ticket = await oauth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const email = payload?.email;
        if (!email) {
            return next(
                new AppError(
                    "Google account is missing an email",
                    StatusCodes.BAD_REQUEST
                )
            );
        }

        const user = await UserModel.findOne({ email });
        // Extension may only sign IN existing users. New accounts must be
        // created via the website so onboarding runs in full.
        if (!user) {
            const url = new URL(returnTo);
            url.searchParams.set("error", "no_account");
            url.searchParams.set(
                "message",
                "No Coachiatry account found for this Google email. Please sign up on the website first, then log in here."
            );
            return res.redirect(url.toString());
        }

        const token = signAppToken(user._id.toString());
        const userPayload = Buffer.from(
            JSON.stringify({
                id: user._id.toString(),
                email: user.email,
                name: user.fullName,
                avatarUrl: user.photo,
            })
        ).toString("base64");

        const url = new URL(returnTo);
        url.searchParams.set("token", token);
        url.searchParams.set("user", userPayload);
        res.redirect(url.toString());
    }
);
