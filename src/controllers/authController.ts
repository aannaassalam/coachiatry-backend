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
import {
    PASSWORD_HTML,
    RESET_LINK_HTML,
    WELCOME_EMAIL_HTML,
} from "../constants/constants";
// import sendEmail from '../utils/email_sms'; // Uncomment and implement as needed

const signToken = (id: string) => {
    return jwt.sign({ id }, process.env.JWT_SECRET as string, {
        expiresIn: process.env.JWT_EXPIRES_IN,
    });
};

const createSendToken = (
    user: any,
    statusCode: number,
    res: Response,
    message: string
) => {
    const token = signToken(user._id);
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
                        StatusCodes.INTERNAL_SERVER_ERROR
                    )
                );
            }
        }

        const newUser = await UserModel.create({
            fullName,
            email,
            password: finalPassword,
            photo,
            phone,
            role,
        });

        // Send welcome email
        try {
            await sendEmail({
                email,
                subject: "Welcome to Coachiatry!",
                html: WELCOME_EMAIL_HTML(fullName),
            });
        } catch (err) {
            console.warn("Failed to send welcome email:", err);
        }

        createSendToken(
            newUser,
            StatusCodes.CREATED,
            res,
            "Signed up successfully!"
        );
    }
);

export const login = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { email, password } = req.body;
        if (!email || !password) {
            return next(
                new AppError(
                    "Please provide email and password!",
                    StatusCodes.BAD_REQUEST
                )
            );
        }
        const user = await UserModel.findOne({ email }).select("+password");
        user.updatedAt = new Date(); // Update the last updated time
        await user.save({ validateBeforeSave: false });
        if (!user || !(await user.correctPassword(password, user.password))) {
            return next(
                new AppError(
                    "Incorrect email or password",
                    StatusCodes.UNAUTHORIZED
                )
            );
        }
        createSendToken(user, StatusCodes.OK, res, "Logged in Successfully!");
    }
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
                    StatusCodes.UNAUTHORIZED
                )
            );
        }
        const decoded: any = await promisify(jwt.verify)(
            token,
            process.env.JWT_SECRET as string
        );
        const currentUser = await UserModel.findById(decoded.id);
        if (!currentUser) {
            return next(
                new AppError(
                    "The user belonging to this token does no longer exist.",
                    StatusCodes.UNAUTHORIZED
                )
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
    }
);

export const injectUserId = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        if (req.user) {
            req.params.id = req.user._id.toString();
        }
        next();
    }
);

export const restrictTo = (...roles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!roles.includes(req.user.role)) {
            return next(
                new AppError(
                    "You do not have permission to perform this action",
                    StatusCodes.FORBIDDEN
                )
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
                    StatusCodes.NOT_FOUND
                )
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
                "Password reset link sent to your email!"
            );
        } catch (err) {
            return next(
                new AppError(
                    "There was an error sending the email. Try again later!",
                    StatusCodes.INTERNAL_SERVER_ERROR
                )
            );
        }
    }
);

export const verifyOtp = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { otp, email } = req.body;
        const user = await UserModel.findOne({
            otp: otp,
            email: email,
            otpExpires: { $gt: Date.now() },
        });
        if (!user) {
            return next(
                new AppError(
                    "OTP is invalid or has expired",
                    StatusCodes.BAD_REQUEST
                )
            );
        }

        await user.save({ validateBeforeSave: false });
        // If OTP is valid, send success response
        sendResponse(res, StatusCodes.OK, "OTP is valid", { userId: user._id });
    }
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
                    StatusCodes.BAD_REQUEST
                )
            );
        }

        // 3️⃣ Set the new password and clear reset fields
        user.password = password;
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;

        await user.save();
        sendResponse(res, 200, "Password reset successfully!");
    }
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
                    StatusCodes.UNAUTHORIZED
                )
            );
        }
        user.password = req.body.password;
        await user.save();
        sendResponse(res, StatusCodes.OK, "Password updated successfully!");
    }
);
