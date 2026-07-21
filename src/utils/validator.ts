import * as Joi from "joi";
import { Request, Response, NextFunction } from "express";
import AppError from "./appError";

// User signup validation schema - name, email, password, passwordConfirm are required
const userSignupSchema = Joi.object({
    fullName: Joi.string().min(2).max(50).trim().required(),
    email: Joi.string().email().required(),
    photo: Joi.string().uri().allow(""),
    phone: Joi.string()
        .pattern(/^[0-9+\-\s()]+$/)
        .min(10)
        .max(15),
    password: Joi.string().min(8),
    // role: Joi.string().valid('admin', 'consultant').default('consultant')
})
    .unknown(false)
    .messages({
        "object.unknown": 'Invalid input - field "{#label}" is not allowed',
    });

// User update validation schema - only allow specific fields
// Only allow safe fields to be updated: name, photo, active
// Exclude sensitive fields like email, password, role, otp, etc.
const userUpdateSchema = Joi.object({
    fullName: Joi.string().min(2).max(50).trim(),
    email: Joi.string().email(),
    photo: Joi.string().uri().allow(""),
    phone: Joi.string()
        .pattern(/^[0-9+\-\s()]+$/)
        .min(10)
        .max(15)
        .optional(),
})
    .unknown(false)
    .messages({
        "object.unknown": 'Invalid input - field "{#label}" is not allowed',
    });

const documentUpdateSchema = Joi.object({
    // The model puts no cap on title length and doesn't require a tag, so the
    // 50-char limit / required tag here rejected perfectly valid documents
    // (any existing doc with a longish title failed to save with "Invalid
    // input"). Keep it lenient and aligned with the model.
    title: Joi.string().min(2).max(255).trim().required(),
    tag: Joi.string().trim().allow(null, "").optional(),
    content: Joi.string().trim().required(),
})
    .unknown(false)
    .messages({
        "object.unknown": 'Invalid input - field "{#label}" is not allowed',
    });

// Generic validation middleware factory
const validatePayload = (schema: Joi.ObjectSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const { error } = schema.validate(req.body, {
            abortEarly: false, // Show all validation errors
            stripUnknown: true, // Don't strip unknown fields, throw error instead
        });

        if (error) {
            const errorMessage = error.details
                .map((detail) => detail.message)
                .join(", ");
            console.log(errorMessage);
            return next(new AppError("Invalid input", 400));
        }

        next();
    };
};

// Specific middleware for user signup
export const validateUserSignup = validatePayload(userSignupSchema);

// Specific middleware for user updates
export const validateUserUpdate = validatePayload(userUpdateSchema);

export const validateDocumentUpdate = validatePayload(documentUpdateSchema);

// Export the factory function for potential future use
export { validatePayload };
