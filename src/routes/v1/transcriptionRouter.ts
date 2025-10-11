import { injectUserId } from "./../../controllers/authController";
import express from "express";
import { protect } from "../../controllers/authController";
import TranscriptionModel from "../../model/transcriptionModel";
import { validateUserUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(factory.getAll(TranscriptionModel, { currentUserOnly: true }))
    .post(factory.createOne(TranscriptionModel, { userAsDocumentOwner: true }));

router.route("/:id").get(factory.getOne(TranscriptionModel));
// .patch(validateUserUpdate, factory.updateOne(TranscriptionModel));

export default router;
