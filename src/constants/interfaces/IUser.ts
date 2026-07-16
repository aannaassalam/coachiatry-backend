import mongoose, { Document, Types, Schema } from "mongoose";

export interface IUserDocument extends Document {
    fullName: string;
    email: string;
    photo?: string;
    phone?: string;
    role: "admin" | "manager" | "user" | "coach";
    password: string | null;
    passwordResetToken: String;
    passwordResetExpires: Date;
    assignedCoach: Types.ObjectId[];
    shareId: string;
    sharedViewers: Types.ObjectId[];
    active: boolean;
    fcmTokens?: string[];
    otp: string;
    otpExpires: Date;
    verified: boolean;
    provider?: "local" | "google" | "apple";
    appleId?: string;
    appleRefreshToken?: string;
    createdAt: Date;
    updatedAt: Date;
    correctPassword(
        candidatePassword: string,
        userPassword: string,
    ): Promise<boolean>;
    createPasswordResetToken: () => string;
}
