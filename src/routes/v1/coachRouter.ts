import { injectUserId, restrictTo } from "./../../controllers/authController";
import express from "express";
import { protect } from "../../controllers/authController";
import TranscriptionModel from "../../model/transcriptionModel";
import { validateUserUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import { getClients } from "../../controllers/coachController";

const router = express.Router();
router.use(protect);

router.get("/clients", restrictTo("coach"), getClients);

router
    .route("/:id")
    .get(factory.getOne(TranscriptionModel))
    .delete(factory.deleteOne(TranscriptionModel));
// .patch(validateUserUpdate, factory.updateOne(TranscriptionModel));

export default router;
