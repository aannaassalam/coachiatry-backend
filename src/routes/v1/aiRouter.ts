import express from "express";
import { protect } from "../../controllers/authController";
import {
    aiController,
    aiNativeController,
    transcriptionAIController,
} from "../../controllers/LLMController";

const router = express.Router();
router.use(protect);

router.post("/", aiController);
router.post("/native", aiNativeController);
router.post("/transcript", transcriptionAIController);

export default router;
