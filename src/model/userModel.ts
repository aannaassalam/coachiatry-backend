import mongoose, { Schema } from "mongoose";
import validator from "validator";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

import { IUserDocument } from "../constants/interfaces/IUser";
import AppError from "../utils/appError";

const userSchema = new Schema<IUserDocument>(
    {
        fullName: {
            type: String,
            required: [true, "Please tell us your name!"],
        },
        email: {
            type: String,
            required: [true, "Please provide your email"],
            lowercase: true,
            validate: [validator.isEmail, "please provide a valid email"],
        },
        photo: String,
        phone: {
            type: String,
            validate: {
                validator: function (v: string) {
                    return /^\+?[1-9]\d{1,14}$/.test(v); // E.164 format
                },
                message: "Please provide a valid phone number",
            },
            required: false, // Optional field
            minlength: 10, // Minimum length for phone number
            maxlength: 15, // Maximum length for phone number
        },
        role: {
            type: String,
            enum: ["admin", "manager", "user", "coach"],
            default: "user",
        },
        assignedCoach: [
            {
                type: mongoose.Types.ObjectId,
                ref: "User",
            },
        ],
        password: {
            type: String,
            // required: [true, "please provide a password"],
            minlength: 8,
            select: false,
        },
        passwordResetToken: {
            type: String,
        },
        passwordResetExpires: {
            type: Date,
        },
        shareId: {
            type: String,
            default: uuidv4,
            unique: true,
        },
        sharedViewers: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        ],
        active: {
            type: Boolean,
            default: true,
            // select: false,
        },
        fcmTokens: [
            {
                type: String,
            },
        ],
        otp: {
            type: String,
        },
        otpExpires: {
            type: Date,
        },
        verified: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                delete ret.password;
                delete ret.otp;
                delete ret.otpExpires;
                delete ret.passwordResetToken;
                delete ret.passwordResetExpires;
                return ret;
            },
        },
    },
);

userSchema.index(
    { email: 1 },
    { unique: true, partialFilterExpression: { verified: true, active: true } },
);
userSchema.index(
    { createdAt: 1 },
    {
        expireAfterSeconds: 60 * 60 * 24,
        partialFilterExpression: { verified: false },
    },
);
userSchema.index({ name: "text" });
userSchema.index({ role: 1 });
userSchema.index({ assignedCoach: 1 });
// User lists filter on { active, verified }; email lookups happen with varying
// active/verified combos that don't always match the unique partial index.
userSchema.index({ active: 1, verified: 1 });
userSchema.index({ email: 1 });

userSchema.pre<IUserDocument>("save", async function (next) {
    if (!this.isModified("password")) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
});

// userSchema.pre(/^find/, function (this: mongoose.Query<IUserDocument, IUserDocument>, next) {
//     this.find({ active: { $ne: false } });
//     next();
// });

userSchema.methods.correctPassword = async function (
    candidatePassword: string,
    userPassword: string,
) {
    //check user is active or not
    if (!this.active) {
        return;
        throw new AppError(
            "Your account is deactivated. Please contact support.",
            403,
        );
    }
    return await bcrypt.compare(candidatePassword, userPassword);
};

userSchema.methods.createPasswordResetToken = function () {
    const resetToken = crypto.randomBytes(32).toString("hex");

    // Hash it before saving to DB (so it’s not readable if DB leaks)
    this.passwordResetToken = crypto
        .createHash("sha256")
        .update(resetToken)
        .digest("hex");

    // Token valid for 3 hours
    this.passwordResetExpires = Date.now() + 3 * 60 * 60 * 1000; // 3h in ms

    return resetToken;
};

const UserModel = mongoose.model<IUserDocument>("User", userSchema);
export default UserModel;
