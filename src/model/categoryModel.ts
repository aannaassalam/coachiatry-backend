import mongoose, { Schema } from "mongoose";
import { ICategory } from "../constants/interfaces/ICategory";

const categorySchema = new Schema<ICategory>(
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
        color: {
            bg: {
                type: String,
                required: true,
            },
            text: {
                type: String,
                required: true,
            },
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

categorySchema.index({ title: 1 });
categorySchema.index({ user: 1 });

const CategoryModel = mongoose.model<ICategory>("Category", categorySchema);
export default CategoryModel;
