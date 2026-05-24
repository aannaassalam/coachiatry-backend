import express, { Request, Response, NextFunction } from "express";
import authRouter from "./authRouter";
import userRouter from "./userRouter";
import transcriptionRouter from "./transcriptionRouter";
import meetingsRouter from "./meetingsRouter";
import documentRouter from "./documentRouter";
import chatRouter from "./chatRouter";
import messageRouter from "./messageRouter";
import categoryRouter from "./categoryRouter";
import statusRouter from "./statusRouter";
import taskRouter from "./taskRouter";
import aiRouter from "./aiRouter";
import coachRouter from "./coachRouter";
import uploadFileRouter from "./uploadFileRouter";
import { protect } from "../../controllers/authController";
import catchAsync from "../../utils/catchAsync";
import TaskModel from "../../model/taskModel";
import TranscriptionModel from "../../model/transcriptionModel";
import DocumentModel from "../../model/documentModel";
import ChatModel from "../../model/chatModel";
import { sendResponse } from "../../utils/response";

const router = express.Router();

router.get("/", (req, res) => res.send("API is running..."));
router.get(
    "/search",
    protect,
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const currentUserId = req.user?._id;
        const { query = "", category = "all" } = req.query;

        const queryArrays = [
            {
                name: "task",
                model: TaskModel.find({
                    title: { $regex: query as string, $options: "i" },
                    user: currentUserId,
                }).limit(10),
            },
            {
                name: "transcript",
                model: TranscriptionModel.find({
                    title: { $regex: query as string, $options: "i" },
                    user: currentUserId,
                }).limit(10),
            },
            {
                name: "document",
                model: DocumentModel.find({
                    title: { $regex: query as string, $options: "i" },
                    user: currentUserId,
                }).limit(10),
            },
        ];

        const results = (
            await Promise.all(
                queryArrays.map(async (item) => {
                    if (category === "all" || category === item.name) {
                        const data = await item.model;
                        return data.map((doc) => ({
                            ...doc.toJSON(),
                            type: item.name,
                        }));
                    }
                    return null;
                })
            )
        )
            .flatMap((r) => r ?? [])
            .sort((a, b) => {
                return (
                    new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime()
                );
            });

        sendResponse(res, 200, "", results);
    })
);

router.use("/auth", authRouter);
router.use("/user", userRouter);
router.use("/transcriptions", transcriptionRouter);
router.use("/meetings", meetingsRouter);
router.use("/documents", documentRouter);
router.use("/chat", chatRouter);
router.use("/message", messageRouter);
router.use("/categories", categoryRouter);
router.use("/statuses", statusRouter);
router.use("/task", taskRouter);
router.use("/ai", aiRouter);
router.use("/coach", coachRouter);
// router.use('/uploads', uploadFileRouter);

export default router;
