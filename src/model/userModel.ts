import mongoose, { Schema } from "mongoose";
import validator from "validator";
import bcrypt from "bcryptjs";

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
            unique: true,
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
            enum: ["user", "coach"],
            default: "user",
        },
        password: {
            type: String,
            // required: [true, "please provide a password"],
            minlength: 8,
            select: false,
        },

        active: {
            type: Boolean,
            default: true,
            // select: false,
        },
    },
    {
        timestamps: true,
    }
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ name: "text" });

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
    userPassword: string
) {
    //check user is active or not
    if (!this.active) {
        throw new AppError(
            "Your account is deactivated. Please contact support.",
            403
        );
    }
    return await bcrypt.compare(candidatePassword, userPassword);
};

const UserModel = mongoose.model<IUserDocument>("User", userSchema);
export default UserModel;
