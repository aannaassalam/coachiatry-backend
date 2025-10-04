import mongoose, { Schema } from "mongoose";
import { IStatus } from "../constants/interfaces/IStatus";

const statusSchema = new Schema<IStatus>(
    {
        title: {
            type: String,
            required: [true, "Please enter transcription title!"],
        },
        user: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        public: {
            type: Boolean,
            default: false,
        },
        active: {
            type: Boolean,
            default: true,
        },
    },
    {
        timestamps: true,
    }
);

statusSchema.index({ title: 1 });

const StatusModel = mongoose.model<IStatus>("Status", statusSchema);
export default StatusModel;
