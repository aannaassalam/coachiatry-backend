import { NextFunction, Request, Response } from "express";
import SavedFilterModel from "../model/savedFilterModel";
import AppError from "../utils/appError";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";

// Whose task sheet is being filtered: the client on the `/coach/:userId`
// routes, otherwise the requester's own sheet.
const sheetOwner = (req: Request) =>
    req.params.userId ?? req.user._id.toString();

/**
 * Filters belong to the SHEET, not to whoever typed them: the sheet's owner and
 * anyone watching that account share one set and both can add to it. What stays
 * separate is the watcher's *own* sheet — its filters carry a different
 * `forUser`, so they never show up on the account being watched, or vice versa.
 */
export const getSavedFilters = catchAsync(
    async (req: Request, res: Response) => {
        const forUser = sheetOwner(req);
        const me = req.user._id.toString();

        const query = req.params.userId
            ? { forUser }
            : {
                  // `forUser: null` also matches filters saved before the field
                  // existed — those belong to whoever created them.
                  $or: [{ forUser }, { user: me, forUser: null }],
              };

        const docs = await SavedFilterModel.find(query).sort({ createdAt: 1 });
        sendResponse(res, 200, "Saved filters retrieved successfully", docs);
    },
);

export const createSavedFilter = catchAsync(
    async (req: Request, res: Response) => {
        const doc = await SavedFilterModel.create({
            name: req.body.name,
            filters: req.body.filters,
            // Ownership comes from the token and the route, never the body.
            user: req.user._id,
            forUser: sheetOwner(req),
        });
        sendResponse(res, 201, "Saved filter created successfully", doc);
    },
);

// Who may edit/delete is decided by authorizeSavedFilterAccess on the route:
// the sheet's owner, or someone managing them.
export const updateSavedFilter = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await SavedFilterModel.findByIdAndUpdate(
            req.params.id,
            { name: req.body.name, filters: req.body.filters },
            { new: true, runValidators: true },
        );
        if (!doc) return next(new AppError("Saved filter not found", 404));
        sendResponse(res, 200, "Saved filter updated successfully", doc);
    },
);

export const deleteSavedFilter = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const doc = await SavedFilterModel.findByIdAndDelete(req.params.id);
        if (!doc) return next(new AppError("Saved filter not found", 404));
        sendResponse(res, 200, "Saved filter deleted successfully", null);
    },
);
