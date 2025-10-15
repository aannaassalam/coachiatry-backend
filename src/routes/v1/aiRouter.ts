import express from "express";
import { protect } from "../../controllers/authController";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import CategoryModel from "../../model/categoryModel";
import { aiController } from "../../controllers/LLMController";

const router = express.Router();
router.use(protect);

router.post("/", aiController);

export default router;
