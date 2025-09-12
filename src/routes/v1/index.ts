import express from "express";
import authRouter from "./authRouter";
import userRouter from "./userRouter";
import transcriptionRouter from "./transcriptionRouter";
import documentRouter from "./documentRouter";
import uploadFileRouter from "./uploadFileRouter";
import dashboardRouter from "./dashboardRouter";

const router = express.Router();

router.use("/auth", authRouter);
router.use("/user", userRouter);
router.use("/transcriptions", transcriptionRouter);
router.use("/documents", documentRouter);
// router.use('/uploads', uploadFileRouter);
// router.use('/dashboard', dashboardRouter);

export default router;
