import { Request, Response, NextFunction } from "express";
import catchAsync from "./../utils/catchAsync";
import AppError from "./../utils/appError";
import APIFeatures from "./../utils/apiFeatures";
import { Model } from "mongoose";
import { sendEmail } from "../utils/email_sms";
import { contactUsHTML } from "../constants/constants";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Parser } from "json2csv";
import dayjs from "dayjs";
import { sendResponse } from "../utils/response";
import qs from "qs";
import { QueryValue } from "../constants/interfaces";

interface Message {
    message?: string;
}

interface CreateOptions extends Message {
    afterCreate?: (doc: any) => Promise<void> | void;
    userAsDocumentOwner?: boolean;
    // Force the created doc's `user` to a route param (e.g. the client a
    // coach/manager/admin is acting on behalf of), regardless of the body.
    ownerFromParam?: string;
}

interface GetAllOptions extends Message {
    role?: string;
    currentUserOnly?: boolean;
    // Scope to docs the current user OWNS (`user`) OR is ASSIGNED to
    // (`assignedTo` array contains them). Skipped when the request already
    // filters by an explicit `user` (e.g. a coach viewing a specific
    // client's tasks via ?user=<id>), so that override keeps working.
    ownedOrAssignedToCurrentUser?: boolean;
    additionalFilter?: object;
    publicTypeFilter?: boolean;
    coachTypeFilter?: boolean;
    // Paths that must always be populated AND resolve to a non-null doc.
    // Tasks with a dangling FK (or no FK at all) on any listed path are
    // dropped from the response. Applied in addition to the caller's
    // ?populate= so the field is never silently missed.
    requirePopulated?: string[];
    // Default field projection applied when the request didn't pass ?fields=.
    // Pushed to MongoDB, so an excluded field (e.g. a heavy embedded array) is
    // never even read from disk. Use to keep list payloads small.
    selectFields?: string;
    // Return plain JS objects instead of hydrated Mongoose docs — cheaper for
    // read-only list endpoints.
    lean?: boolean;
}

export const deleteOne = <T = any>(Model: Model<T>, options?: Message) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await Model.findByIdAndDelete(req.params.id);

        if (!doc) {
            return next(
                new AppError(`No ${Model.modelName} found with that ID`, 404),
            );
        }

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} deleted successfully`,
            null,
        );
    });

export const updateOne = <T = any>(Model: Model<T>, options?: Message) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        });
        if (!doc) {
            return next(
                new AppError(`No ${Model.modelName} found with that ID`, 404),
            );
        }
        doc.save({ validateBeforeSave: false });
        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} updated successfully`,
            doc,
        );
    });

export const createOne = <T = any>(
    Model: Model<T>,
    options?: CreateOptions,
) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const body = req.body;
        if (options?.userAsDocumentOwner) {
            body.user = req.user._id;
        }
        // Authoritatively set ownership from the route param so a
        // coach/manager/admin acting on a client's behalf can't (accidentally
        // or maliciously) misfile the doc under someone else via the body.
        if (options?.ownerFromParam && req.params?.[options.ownerFromParam]) {
            body.user = req.params[options.ownerFromParam];
        }
        const doc = await Model.create(body);

        // Execute afterCreate callback if provided
        if (options?.afterCreate) {
            await options.afterCreate(doc);
        }

        sendResponse(
            res,
            201,
            options?.message ?? `${Model.modelName} created successfully`,
            doc,
        );
    });

export const getOne = <T = any>(Model: Model<T>, options?: Message) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const populateFields = req.query.populate
            ? (req.query.populate as any)?.split(",").join(" ")
            : "";
        const query = Model.findById(req.params.id).populate(populateFields);

        const doc = await query.exec();

        if (!doc) {
            return next(
                new AppError(`No ${Model.modelName} found with that ID`, 404),
            );
        }

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} retrieved successfully`,
            doc,
        );
    });

export const getAll = <T = any>(Model: Model<T>, options?: GetAllOptions) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        let filter = options?.additionalFilter ?? {};
        if (options?.role) filter = { role: options.role };

        if (options?.currentUserOnly && req.user) {
            filter = { ...filter, user: req.user._id };
        }

        if (
            options?.ownedOrAssignedToCurrentUser &&
            req.user &&
            !req.query.user
        ) {
            filter = {
                ...filter,
                $or: [
                    { user: req.user._id },
                    { assignedTo: req.user._id },
                ],
            };
        }

        if (options?.publicTypeFilter && req.user) {
            // System docs are public AND owned by nobody (user: null); a
            // user's own public doc must NOT leak to others, so only the
            // {user: me} branch surfaces those.
            filter = {
                ...filter,
                $or: [
                    { public: true, user: null },
                    { user: req.user._id },
                ],
            };
        }

        const features = new APIFeatures(Model.find(filter), req.query as any)
            .filter()
            .sort()
            .limitFields()
            .paginate()
            .search()
            .populate();

        // Default projection (only when the caller didn't pass ?fields=, to
        // avoid mixing inclusion/exclusion). Excludes heavy fields at the DB
        // level so list payloads stay small.
        if (options?.selectFields && !req.query.fields) {
            features.query = features.query.select(options.selectFields);
        }
        if (options?.lean) {
            features.query = features.query.lean();
        }

        await features.calculateTotalCount();
        const doc = await features.query;

        const totalPages = Math.ceil(features.totalCount / features.limit);
        const currentPage = parseInt(req.query.page as string, 10) || 1;

        const responseData = {
            data: doc,
            meta: {
                results: doc.length,
                limit: features.limit,
                currentPage,
                totalPages,
                totalCount: features.totalCount,
            },
        };

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} retrieved successfully`,
            responseData,
        );
    });

export const getAllUnpaginated = <T = any>(
    Model: Model<T>,
    options?: GetAllOptions,
) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        let filter = options.additionalFilter ?? {};
        if (options?.role) filter = { role: options.role };

        if (options?.currentUserOnly && req.user) {
            filter = { ...filter, user: req.user._id };
        }

        if (
            options?.ownedOrAssignedToCurrentUser &&
            req.user &&
            !req.query.user
        ) {
            filter = {
                ...filter,
                $or: [
                    { user: req.user._id },
                    { assignedTo: req.user._id },
                ],
            };
        }

        if (options?.publicTypeFilter && req.user) {
            // System docs are public AND owned by nobody (user: null); a
            // user's own public doc must NOT leak to others, so only the
            // {user: me} branch surfaces those.
            filter = {
                ...filter,
                $or: [
                    { public: true, user: null },
                    { user: req.user._id },
                ],
            };
        }

        if (options?.coachTypeFilter && req.params?.userId) {
            // System docs (public + user: null) plus the viewed client's own.
            filter = {
                ...filter,
                $or: [
                    { public: true, user: null },
                    { user: req.params?.userId },
                ],
            };
        }

        if (options?.requirePopulated?.length) {
            for (const path of options.requirePopulated) {
                filter = { ...filter, [path]: { $ne: null } };
            }
        }

        const features = new APIFeatures(Model.find(filter), req.query as any)
            .filter()
            .sort()
            .limitFields()
            .search()
            .populate();

        if (options?.requirePopulated?.length) {
            for (const path of options.requirePopulated) {
                // @ts-expect-error: type widening from populate()
                features.query = features.query.populate(path);
            }
        }

        if (req.query.limit) {
            const limit = parseInt(req.query.limit as string, 10);
            if (!isNaN(limit) && limit > 0) {
                features.query = features.query.limit(limit);
            }
        }

        let doc = (await features.query) as any[];

        if (options?.requirePopulated?.length && Array.isArray(doc)) {
            doc = doc.filter((d) =>
                options.requirePopulated!.every((p) => d?.[p] != null),
            );
        }

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} retrieved successfully`,
            doc,
        );
    });

export const sendContactUsMail = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { name, email, phone, companyName, message } = req.body;
        if (!name || !email || !message) {
            return next(
                new AppError("Please provide all required fields", 400),
            );
        }
        await sendEmail({
            email: "support@taxcenter.co.in",
            subject: "Contact Us",
            html: contactUsHTML(name, email, phone, companyName, message),
        });
        sendResponse(res, 200, "Mail sent successfully", null);
    },
);

export const downloadReport = async (
    Model: any, // Model to query transactions from
    condition: any, // Condition to apply to the query
    format: string, // The format of the report (csv or pdf)
    fields: any[], // Fields to include in the report
    heading: string = "Report",
) => {
    try {
        const foundTx = await Model.find(condition); // Query the model with the passed condition
        // Configure the parser with the updated fields
        const json2csvParser = new Parser({ fields });
        let csvContent = json2csvParser.parse(foundTx); // Generate CSV

        // If the format is PDF, convert the CSV to PDF
        if (format === "pdf") {
            csvContent = await convertCsvToPdf(csvContent, `${heading}`);
        }

        return csvContent; // Return the generated CSV or PDF content
    } catch (error) {
        // Handle any errors during report generation
        return new AppError(
            "Error generating transaction report: " + error.message,
            401,
        );
    }
};

// (pdfMake as any).vfs = pdfFonts.pdfMake.vfs;

// export const convertCsvToPdf = (csvContent: string): Promise<Buffer> => {
//     return new Promise((resolve, reject) => {
//         const data: any[] = [];

//         // Create a readable stream from the CSV content string
//         const csvStream = Readable.from(csvContent);

//         // Parse the CSV content using the csv-parser module
//         csvStream
//             .pipe(csvParser()) // Corrected usage
//             .on('data', (row) => {
//                 data.push(row);
//             })
//             .on('end', () => {
//                 try {
//                     const docDefinition = {
//                         content: [
//                             {
//                                 table: {
//                                     headerRows: 1,
//                                     widths: Array(Object.keys(data[0]).length).fill('*'),
//                                     body: [
//                                         Object.keys(data[0]).map((key) => key),
//                                         ...data.map((row) => Object.values(row)),
//                                     ],
//                                 },
//                             },
//                         ],
//                     };

//                     const pdfDoc = pdfMake.createPdf(docDefinition);

//                     pdfDoc.getBuffer((pdfBytes: Uint8Array) => {
//                         const pdfBuffer = Buffer.from(pdfBytes);
//                         resolve(pdfBuffer);
//                     });
//                 } catch (error) {
//                     reject(new Error(`Error generating PDF: ${error.message}`));
//                 }
//             })
//             .on('error', (error) => {
//                 reject(new Error(`Error processing CSV: ${error.message}`));
//             });
//     });
// };
export const convertCsvToPdf = async (
    csvContent,
    heading: string = "Report",
) => {
    try {
        const pdfDoc = await PDFDocument.create();
        const pageSize: [number, number] = [841.89, 595.28]; // A4 size in points (width, height)
        const fontSize = 12;
        const headingFontSize = 18;
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const createNewPage = () => {
            const page = pdfDoc.addPage(pageSize);
            const { width, height } = page.getSize();
            page.drawText(heading, {
                x: 10,
                y: height - headingFontSize - 10,
                size: headingFontSize,
                font: boldFont,
            });
            return page;
        };

        let page = createNewPage();
        const { width, height } = page.getSize();

        const lines = csvContent.split("\n");
        const cellPadding = 5;
        const cellHeight = fontSize + cellPadding * 2;
        let yPosition = height - cellHeight - headingFontSize - 20;

        const table = lines.map((line) => line.split(","));

        // Calculate the column widths
        const colWidths = [];
        table[0].forEach((_, colIndex) => {
            const maxColWidth = Math.max(
                ...table.map((row) => row[colIndex].length),
            );
            colWidths.push(maxColWidth * fontSize * 0.6 + cellPadding * 2); // estimate width based on character count
        });

        // Draw table
        for (const row of table) {
            if (yPosition < cellHeight) {
                // Add a new page if the current page is full
                page = createNewPage();
                yPosition = height - cellHeight - headingFontSize - 20;
            }

            let xPosition = 10;
            row.forEach((cell, colIndex) => {
                const cellWidth = colWidths[colIndex];

                // Draw cell border
                page.drawRectangle({
                    x: xPosition,
                    y: yPosition,
                    width: cellWidth,
                    height: cellHeight,
                    borderColor: rgb(0, 0, 0),
                    borderWidth: 1,
                });

                // Draw cell text
                page.drawText(cell, {
                    x: xPosition + cellPadding,
                    y: yPosition + cellPadding,
                    size: fontSize,
                    font: font,
                });

                xPosition += cellWidth;
            });
            yPosition -= cellHeight;
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    } catch (error) {
        throw new AppError(
            "Error generating transaction report: " + error.message,
            401,
        );
    }
};
export const formatDateTime = (date: Date) => {
    return dayjs(date).format("YYYY-MM-DD hh:mma").toLowerCase();
};
