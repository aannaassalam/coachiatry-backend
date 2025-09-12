import mongoose, { Document, Schema } from "mongoose";

export interface IUserDocument extends Document {
    fullName: string;
    email: string;
    photo?: string;
    phone?: string;
    role: "user" | "coach";
    password: string | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
    correctPassword(
        candidatePassword: string,
        userPassword: string
    ): Promise<boolean>;
}
