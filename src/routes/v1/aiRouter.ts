import express from "express";
import { protect } from "../../controllers/authController";
import { preventConcurrentDuplicateAI } from "../../middleware/aiIdempotency";
import {
    aiController,
    aiNativeController,
    transcriptionAIController,
} from "../../controllers/LLMController";

const router = express.Router();
router.use(protect);
// Every route here fans out into multiple Gemini calls, so a duplicate in-flight
// request is both billed twice and races its twin's response.
router.use(preventConcurrentDuplicateAI);

router.post("/", aiController);
router.post("/native", aiNativeController);
router.post("/transcript", transcriptionAIController);

export default router;
