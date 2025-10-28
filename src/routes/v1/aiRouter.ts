import express from "express";
import { protect } from "../../controllers/authController";
import transcriptionAIController, {
    aiController,
} from "../../controllers/LLMController";

const router = express.Router();
router.use(protect);

router.post("/", aiController);
router.post("/transcript", transcriptionAIController);

export default router;
