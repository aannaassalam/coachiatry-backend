import crypto from "crypto";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { StatusCodes, getReasonPhrase } from "http-status-codes";
import UserModel from "../model/userModel";
import catchAsync from "../utils/catchAsync";
import AppError from "../utils/appError";
import { sendResponse } from "../utils/response";
import { sendEmail, azureSendMail } from "../utils/email_sms";
import { OAuth2Client } from "google-auth-library";
import {
    OTP_EMAIL_HTML,
    PASSWORD_HTML,
    RESET_LINK_HTML,
    WELCOME_EMAIL_HTML,
} from "../constants/constants";
import ChatModel from "../model/chatModel";
import { createDirectChatIfNotExists } from "./chatController";
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
                    "Please login using Google",
                    StatusCodes.BAD_REQUEST,
                ),
            );
        createSendToken(
            user,
            StatusCodes.OK,
            res,
            "Logged in Successfully!",
            platform,
        );
    },
);

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

        // Check or create user in your DB
        let user = await UserModel.findOne({ email });
        if (!user) {
            // The extension may only sign IN existing users. New accounts must
            // be created via the website so the onboarding flow runs in full.
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
                verified: true,
            });

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
        }

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
        const currentUser = await UserModel.findById(decoded.id);
        if (!currentUser) {
            return next(
                new AppError(
                    "The user belonging to this token does no longer exist.",
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
        console.log(req.body);
        const user = await UserModel.findOne(
            {
                otp: otp,
                email: email,
                // otpExpires: { $gt: Date.now() },
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
