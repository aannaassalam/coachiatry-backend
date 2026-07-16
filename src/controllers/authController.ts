import crypto from "crypto";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { StatusCodes, getReasonPhrase } from "http-status-codes";
import UserModel from "../model/userModel";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import { sendResponse } from "../utils/response";
import { cached, cacheKeys } from "../utils/cache";
import { sendEmail, azureSendMail } from "../utils/email_sms";
import { OAuth2Client } from "google-auth-library";
import appleSignin, { AppleIdTokenType } from "apple-signin-auth";
import { exchangeAppleAuthCode } from "../utils/appleAuth";
import {
    OTP_EMAIL_HTML,
    PASSWORD_HTML,
    RESET_LINK_HTML,
    WELCOME_EMAIL_HTML,
} from "../constants/constants";
import ChatModel from "../model/chatModel";
import {
    createDirectChatIfNotExists,
    processPendingGroupInvitesForUser,
} from "./chatController";
import moment from "moment";
// import sendEmail from '../utils/email_sms'; // Uncomment and implement as needed

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const signToken = (id: string, isApp?: boolean) => {
    return jwt.sign({ id }, process.env.JWT_SECRET!, {
        expiresIn: !isApp ? process.env.JWT_EXPIRES_IN : "36500d",
    } as jwt.SignOptions);
};

const createSendToken = (
    user: any,
    statusCode: number,
    res: Response,
    message: string,
    platform?: string,
) => {
    const token = signToken(user._id, platform === "app");
    // const cookieOptions: any = {
    //     expires: new Date(
    //         Date.now() +
    //             (Number(process.env.JWT_COOKIE_EXPIRES_IN) || 7) *
    //                 24 *
    //                 60 *
    //                 60 *
    //                 1000
    //     ),
    //     httpOnly: true,
    // };
    // if (process.env.NODE_ENV === "production") cookieOptions.secure = true;
    // res.cookie("jwt", token, cookieOptions);
    user.password = undefined;
    sendResponse(res, statusCode, message, { token, user });
};

export const signup = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const {
            fullName,
            email,
            phone,
            photo,
            password = null,
            role = "user",
            provider,
        } = req.body;

        // Role ranking for hierarchy

        let finalPassword = password;

        // If password is not provided, generate and email it
        if (!finalPassword && !provider) {
            finalPassword = crypto
                .randomBytes(8)
                .toString("base64")
                .replace(/[^a-zA-Z0-9]/g, "")
                .slice(0, 10);
            try {
                await sendEmail({
                    email,
                    subject: "Your System Generated Password",
                    html: PASSWORD_HTML(fullName, finalPassword),
                });
            } catch (err) {
                return next(
                    new AppError(
                        "Failed to send generated password email",
                        StatusCodes.INTERNAL_SERVER_ERROR,
                    ),
                );
            }
        }

        const otp = crypto.randomInt(100000, 1000000).toString();
        const existingUser = await UserModel.findOne({ email });

        if (existingUser) {
            if (existingUser.verified) {
                return next(
                    new AppError("Email already in use", StatusCodes.CONFLICT),
                );
            }

            existingUser.otp = otp;
            existingUser.otpExpires = new Date(
                moment().add(5, "minutes").toString(),
            );
            await existingUser.save({ validateBeforeSave: false });

            try {
                await sendEmail({
                    email,
                    subject: "You OTP to Coachiatry",
                    html: OTP_EMAIL_HTML(fullName, otp),
                });
            } catch (err) {
                console.warn("Failed to send welcome email:", err);
            }

            sendResponse(res, StatusCodes.OK, "OTP sent successfully");
        }

        const newUser = await UserModel.create({
            fullName,
            email,
            password: finalPassword,
            photo,
            phone,
            role,
            otp,
            otpExpires: moment().add(5, "minutes").toString(),
            verified: false,
        });

        await ChatModel.create({
            createdBy: newUser._id,
            type: "group",
            name: "Coachiatry",
            groupPhoto:
                "https://coachiatry.s3.us-east-1.amazonaws.com/Logo+Mark+(1).png",
            members: [{ user: newUser._id, role: "member" }],
            isDeletable: false,
        });

        // Create direct chats with all staff (admins, managers, coaches)
        const staff = await UserModel.find({
            role: { $in: ["admin", "manager", "coach"] },
            active: true,
        }).select("_id");
        await Promise.all(
            staff.map((member) =>
                createDirectChatIfNotExists(
                    newUser._id,
                    member._id,
                    newUser._id,
                ),
            ),
        );

        // Send welcome email
        try {
            await sendEmail({
                email,
                subject: "You OTP to Coachiatry",
                html: OTP_EMAIL_HTML(fullName, otp),
            });
        } catch (err) {
            console.warn("Failed to send welcome email:", err);
        }

        sendResponse(res, StatusCodes.OK, "OTP sent successfully");
    },
);

export const login = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { email, password, platform } = req.body;
        if (!email || !password) {
            return next(
                new AppError(
                    "Please provide email and password!",
                    StatusCodes.BAD_REQUEST,
                ),
            );
        }
        const user = await UserModel.findOne({
            email,
            verified: true,
            active: true,
        })
            .populate("sharedViewers assignedCoach")
            .select("+password");
        // user.updatedAt = new Date(); // Update the last updated time
        // await user.save({ validateBeforeSave: false });
        if (!user || !(await user.correctPassword(password, user.password))) {
            return next(
                new AppError(
                    "Incorrect email or password",
                    StatusCodes.UNAUTHORIZED,
                ),
            );
        }
        if (!user.password)
            return next(
                new AppError(
                    "Please login using Google or Apple",
                    StatusCodes.BAD_REQUEST,
                ),
            );

        // Auto-join any groups this email was invited to (safety net alongside
        // the /group-invite landing page).
        await processPendingGroupInvitesForUser({
            _id: user._id,
            email: user.email,
        });

        createSendToken(
            user,
            StatusCodes.OK,
            res,
            "Logged in Successfully!",
            platform,
        );
    },
);

// Provision the default chat surfaces every brand-new user expects: the
// built-in "Coachiatry" group and a direct chat with each active staff member.
// Shared by the Google and Apple social-login account-creation paths.
const bootstrapNewUserChats = async (user: any) => {
    await ChatModel.create({
        createdBy: user._id,
        type: "group",
        name: "Coachiatry",
        groupPhoto:
            "https://coachiatry.s3.us-east-1.amazonaws.com/Logo+Mark+(1).png",
        members: [{ user: user._id, role: "member" }],
        isDeletable: false,
    });

    // Create direct chats with all staff (admins, managers, coaches)
    const staff = await UserModel.find({
        role: { $in: ["admin", "manager", "coach"] },
        active: true,
    }).select("_id");
    await Promise.all(
        staff.map((member) =>
            createDirectChatIfNotExists(user._id, member._id, user._id),
        ),
    );
};

export const googleAuth = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { id_token, platform, source } = req.body;

        if (!id_token) {
            return next(new AppError("Missing Google ID token", 400));
        }

        // Verify Google token
        const ticket = await client.verifyIdToken({
            idToken: id_token,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const email = payload?.email;
        const fullName = payload?.name;
        const photo = payload?.picture;

        if (!email) {
            return next(new AppError("Invalid Google token", 400));
        }

        // Only ACTIVE accounts sign in. A soft-deleted account is treated as
        // gone — we create a fresh account rather than reviving it. The email
        // partial-unique index only covers verified+active rows, so the new
        // active account can coexist with the old soft-deleted one.
        let user = await UserModel.findOne({ email, active: true });
        if (!user) {
            // The extension may only sign IN existing (active) users. New
            // accounts must be created via the website so onboarding runs.
            if (source === "extension") {
                return next(
                    new AppError(
                        "No account found. Please sign up on the Coachiatry website first, then log in here.",
                        StatusCodes.NOT_FOUND
                    )
                );
            }
            user = await UserModel.create({
                email,
                fullName,
                photo,
                provider: "google",
                verified: true,
            });

            await bootstrapNewUserChats(user);
        }

        // Auto-join any groups this email was invited to (covers a brand-new
        // Google user whose email had a pending invite).
        await processPendingGroupInvitesForUser({
            _id: user._id,
            email: user.email,
        });

        delete user.password;

        // Create your own app JWT (7 days)
        createSendToken(
            user,
            StatusCodes.OK,
            res,
            "Logged in Successfully!",
            platform,
        );
    },
);

// Native "Sign in with Apple" (iOS). The app performs the Apple authorization
// with AuthenticationServices and forwards the resulting `identity_token` (a
// signed JWT) plus, ONLY on the very first authorization, the user's name —
// Apple never resends the name and never puts it in the token, so the client
// must capture it once and pass it as `full_name`.
export const appleAuth = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { identity_token, authorization_code, full_name, platform } =
            req.body;

        if (!identity_token) {
            return next(new AppError("Missing Apple identity token", 400));
        }
        if (!process.env.APPLE_CLIENT_ID) {
            return next(
                new AppError(
                    "Sign in with Apple is not configured on the server",
                    StatusCodes.INTERNAL_SERVER_ERROR,
                ),
            );
        }

        // Verify the token against Apple's public keys (JWKS). This checks the
        // signature, the issuer (https://appleid.apple.com) and the audience
        // (our iOS bundle id), and rejects expired tokens.
        let payload: AppleIdTokenType;
        try {
            payload = await appleSignin.verifyIdToken(identity_token, {
                audience: process.env.APPLE_CLIENT_ID,
                ignoreExpiration: false,
            });
        } catch {
            return next(new AppError("Invalid Apple token", 400));
        }

        const appleId = payload.sub;
        const email = payload.email;
        if (!email) {
            return next(
                new AppError(
                    "Apple did not return an email for this account",
                    400,
                ),
            );
        }

        // Apple sends the name only on first authorization, in the native
        // credential (not the token) — the client forwards it as `full_name`.
        // Fall back to the email local-part so the required `fullName` field is
        // always populated for a brand-new account.
        const fullName =
            (typeof full_name === "string" && full_name.trim()) ||
            email.split("@")[0] ||
            "Apple User";

        // Only ACTIVE accounts take part in sign-in. A soft-deleted account
        // (self-deleted or admin-deactivated) is treated as gone: we never
        // revive it — we create a brand-new account instead.
        let user =
            (await UserModel.findOne({ appleId, active: true })) ||
            (await UserModel.findOne({ email, active: true }));

        const returningUser = !!user && user.appleId === appleId;

        if (!returningUser) {
            // We're about to assign this appleId (either linking Apple to an
            // existing active account, or creating a fresh one). The unique
            // appleId index is global, so first release it from any soft-deleted
            // rows that still hold it — otherwise the assignment/insert 11000s.
            await UserModel.updateMany(
                { appleId, active: false },
                { $unset: { appleId: "" } },
            );

            if (user) {
                // Existing active account (matched by email) linking Apple.
                user.appleId = appleId;
                if (!user.provider) user.provider = "apple";
                await user.save({ validateBeforeSave: false });
            } else {
                user = await UserModel.create({
                    email,
                    fullName,
                    provider: "apple",
                    appleId,
                    verified: true,
                });
                await bootstrapNewUserChats(user);
            }
        }

        // Capture a refresh token so the credential can be revoked when the user
        // deletes their account. Best-effort: no-ops unless the APPLE_* signing
        // key is configured, and never blocks the login.
        if (authorization_code) {
            const refreshToken = await exchangeAppleAuthCode(authorization_code);
            if (refreshToken) {
                user.appleRefreshToken = refreshToken;
                await user.save({ validateBeforeSave: false });
            }
        }

        // Auto-join any groups this email was invited to (covers a brand-new
        // Apple user whose email had a pending invite).
        await processPendingGroupInvitesForUser({
            _id: user._id,
            email: user.email,
        });

        delete user.password;

        createSendToken(
            user,
            StatusCodes.OK,
            res,
            "Logged in Successfully!",
            platform,
        );
    },
);

// `protect` runs on every authenticated request, so this was the single most
// frequent query in the app — a full, hydrated user document per request.
//
// The TTL is short and every user write invalidates the key from schema
// middleware (see userModel), because `active` is the deactivation kill-switch
// and `role` gates restrictTo: a stale entry means a deactivated user keeps
// access. The TTL is the backstop for the paths middleware can't see (a direct
// mongo edit, an updateMany), not the primary mechanism.
const USER_CACHE_TTL_SEC = 60;

// What gets cached. Note this is narrower than the old findById, which returned
// otp/passwordResetToken/fcmTokens too: `toJSON` strips secrets on serialization
// but does NOT run on .lean() objects, so caching the full document would write
// live OTPs and reset tokens into Redis. Nothing reads those off req.user —
// only _id, id, role and fullName are ever accessed.
const PROTECT_SELECT =
    "-password -otp -otpExpires -passwordResetToken -passwordResetExpires -fcmTokens";

async function loadUserForRequest(userId: string) {
    const lean = await cached(cacheKeys.user(String(userId)), USER_CACHE_TTL_SEC, () =>
        UserModel.findById(userId).select(PROTECT_SELECT).lean()
    );
    if (!lean) return null;

    // hydrate() rebuilds a real Mongoose document from the plain (JSON
    // round-tripped) object with no DB call, so req.user keeps its ObjectId _id,
    // its `id` virtual and its methods. Without this, req.user._id would be a
    // string and req.user.id undefined.
    return UserModel.hydrate(lean);
}

export const protect = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        let token: string | null;
        if (
            req.headers.authorization &&
            req.headers.authorization.startsWith("Bearer")
        ) {
            token = req.headers.authorization.split(" ")[1];
        }
        if (!token) {
            return next(
                new AppError(
                    "You are not logged in! Please log in to get access.",
                    StatusCodes.UNAUTHORIZED,
                ),
            );
        }
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
        const currentUser = await loadUserForRequest(decoded.id);
        if (!currentUser) {
            return next(
                new AppError(
                    "The user belonging to this token does no longer exist.",
                    StatusCodes.UNAUTHORIZED,
                ),
            );
        }
        if (currentUser.active === false) {
            return next(
                new AppError(
                    "Your account has been deactivated. Please contact support.",
                    StatusCodes.UNAUTHORIZED,
                ),
            );
        }
        // if (currentUser.changedPasswordAfter(decoded.iat)) {
        //     return next(
        //         new AppError(
        //             "User recently changed password! Please log in again.",
        //             StatusCodes.UNAUTHORIZED
        //         )
        //     );
        // }
        req.user = currentUser;
        next();
    },
);

export const injectUserId = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        if (req.user) {
            req.params.id = req.user._id.toString();
        }
        next();
    },
);

export const restrictTo = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!roles.includes(req.user.role)) {
            return next(
                new AppError(
                    "You do not have permission to perform this action",
                    StatusCodes.FORBIDDEN,
                ),
            );
        }
        next();
    };
};

export const forgotPassword = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const user = await UserModel.findOne({ email: req.body.email });

        if (!user) {
            return next(
                new AppError(
                    "There is no user with that email address",
                    StatusCodes.NOT_FOUND,
                ),
            );
        }

        // 1️⃣ Generate reset token
        const resetToken = user.createPasswordResetToken();
        await user.save({ validateBeforeSave: false });

        // 2️⃣ Create reset URL
        const resetURL = `${process.env.CLIENT_URL}/auth/reset-password/${resetToken}`;

        try {
            await sendEmail({
                email: user.email,
                subject: "Your password reset link (valid for 3 hours)",
                html: RESET_LINK_HTML(user.fullName, resetURL),
            });
            sendResponse(
                res,
                StatusCodes.OK,
                "Password reset link sent to your email!",
            );
        } catch (err) {
            return next(
                new AppError(
                    "There was an error sending the email. Try again later!",
                    StatusCodes.INTERNAL_SERVER_ERROR,
                ),
            );
        }
    },
);

export const verifyOtp = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { otp, email, platform } = req.body;

        // Require string inputs (prevents NoSQL operator injection like
        // `{ otp: { $ne: null } }`) and enforce OTP expiry.
        if (typeof otp !== "string" || typeof email !== "string") {
            return next(
                new AppError(
                    "OTP and email are required",
                    StatusCodes.BAD_REQUEST,
                ),
            );
        }

        const user = await UserModel.findOne(
            {
                otp: otp,
                email: email,
                otpExpires: { $gt: new Date() },
            },
            "-fcmTokens",
        ).sort({ createdAt: -1 });

        if (!user) {
            return next(
                new AppError(
                    "OTP is invalid or has expired",
                    StatusCodes.BAD_REQUEST,
                ),
            );
        }
        user.otp = null;
        user.otpExpires = null;
        user.verified = true;

        await user.save({ validateBeforeSave: false });

        // Auto-join any groups this email was invited to before signup.
        await processPendingGroupInvitesForUser({
            _id: user._id,
            email: user.email,
        });

        try {
            await sendEmail({
                email,
                subject: "Welcome to Coachiatry",
                html: WELCOME_EMAIL_HTML(user.fullName),
            });
        } catch (err) {
            console.warn("Failed to send welcome email:", err);
        }

        // If OTP is valid, send success response
        createSendToken(
            user,
            StatusCodes.CREATED,
            res,
            "Signed up successfully!",
            platform,
        );
    },
);

export const resetPassword = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { token, password } = req.body;

        // 1️⃣ Hash the token before searching (since we stored it hashed)
        const hashedToken = crypto
            .createHash("sha256")
            .update(token)
            .digest("hex");

        // 2️⃣ Find user with matching token and valid expiration
        const user = await UserModel.findOne({
            passwordResetToken: hashedToken,
            passwordResetExpires: { $gt: Date.now() },
        });

        if (!user) {
            return next(
                new AppError(
                    "Token is invalid or has expired",
                    StatusCodes.BAD_REQUEST,
                ),
            );
        }

        // 3️⃣ Set the new password and clear reset fields
        user.password = password;
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;

        await user.save();
        sendResponse(res, 200, "Password reset successfully!");
    },
);

export const updatePassword = catchAsync(
    async (req: any, res: Response, next: NextFunction) => {
        const user = await UserModel.findById(req.user.id).select("+password");
        if (
            !user
            // ||
            // !(await user.correctPassword(
            //     req.body.passwordCurrent,
            //     user.password
            // ))
        ) {
            return next(
                new AppError(
                    "Your current password is wrong",
                    StatusCodes.UNAUTHORIZED,
                ),
            );
        }
        user.password = req.body.password;
        await user.save();
        sendResponse(res, StatusCodes.OK, "Password updated successfully!");
    },
);

export const updateFCMToken = catchAsync(
    async (req: any, res: Response, next: NextFunction) => {
        const token = req.body.fcmToken;
        if (!token) {
            return sendResponse(
                res,
                StatusCodes.BAD_REQUEST,
                "fcmToken is required",
            );
        }
        const user = req.user;

        await UserModel.findByIdAndUpdate(user._id, {
            $addToSet: { fcmTokens: token },
        });

        sendResponse(res, StatusCodes.OK, "FCM token registered");
    },
);

export const removeFCMToken = catchAsync(
    async (req: any, res: Response, next: NextFunction) => {
        const token = req.body.fcmToken;
        if (!token) {
            return sendResponse(
                res,
                StatusCodes.BAD_REQUEST,
                "fcmToken is required",
            );
        }

        await UserModel.updateMany(
            { fcmTokens: token },
            { $pull: { fcmTokens: token } },
        );

        sendResponse(res, StatusCodes.OK, "FCM token removed");
    },
);
