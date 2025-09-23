import express from "express";
import authRouter from "./authRouter";
import userRouter from "./userRouter";
import transcriptionRouter from "./transcriptionRouter";
import documentRouter from "./documentRouter";
import chatRouter from "./chatRouter";
import messageRouter from "./messageRouter";
import uploadFileRouter from "./uploadFileRouter";

const router = express.Router();

router.use("/auth", authRouter);
router.use("/user", userRouter);
router.use("/transcriptions", transcriptionRouter);
router.use("/documents", documentRouter);
router.use("/chat", chatRouter);
router.use("/message", messageRouter);
// router.use('/uploads', uploadFileRouter);

export default router;
