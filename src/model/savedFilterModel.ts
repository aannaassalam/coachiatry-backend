import mongoose, { Document, ObjectId, Schema } from "mongoose";

export interface ISavedFilter extends Document {
    name: string;
    /** Who created it. Only the creator may edit or delete it. */
    user: ObjectId;
    /**
     * Whose task sheet it filters — the client when a coach saves one while
     * viewing that client's account. A watcher's filter therefore lives on the
     * client's sheet without ever appearing in the client's own list, which
     * only shows filters where `user` is the client themselves.
     */
    forUser: ObjectId;
    // Mirrors the client-side Filter shape used by the task sheet's FilterBox.
    filters: {
        selectedKey: string;
        selectedOperator: string;
        selectedValue: string;
    }[];
    createdAt: Date;
    updatedAt: Date;
}

const savedFilterSchema = new Schema<ISavedFilter>(
    {
        name: {
            type: String,
            required: [true, "Please enter a filter name!"],
            trim: true,
        },
        user: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        forUser: {
            type: mongoose.Types.ObjectId,
            required: true,
            ref: "User",
        },
        filters: [
            {
                _id: false,
                selectedKey: { type: String, required: true },
                selectedOperator: { type: String, required: true },
                selectedValue: { type: String, default: "" },
            },
        ],
    },
    {
        timestamps: true,
    }
);

// Every list query is "the filters on this sheet", narrowed by creator.
savedFilterSchema.index({ forUser: 1, user: 1 });

const SavedFilterModel = mongoose.model<ISavedFilter>(
    "SavedFilter",
    savedFilterSchema
);
export default SavedFilterModel;
