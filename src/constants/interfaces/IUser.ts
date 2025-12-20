import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface IUserDocument extends Document {
    fullName: string;
    email: string;
    photo?: string;
    phone?: string;
    role: "user" | "coach";
    password: string | null;
    passwordResetToken: String;
    passwordResetExpires: Date;
    assignedCoach: ObjectId;
    shareId: string;
    sharedViewers: string[];
    active: boolean;
    fcmTokens?: string[];
    otp: string;
    otpExpires: Date;
    verified: boolean;
    createdAt: Date;
    updatedAt: Date;
    correctPassword(
        candidatePassword: string,
        userPassword: string
    ): Promise<boolean>;
    createPasswordResetToken: () => string;
}
