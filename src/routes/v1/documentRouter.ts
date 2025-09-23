import express from "express";
import { protect } from "../../controllers/authController";
import DocumentModel from "../../model/documentModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(factory.getAll(DocumentModel, { currentUserOnly: true }))
    .post(factory.createOne(DocumentModel, { userAsDocumentOwner: true }));

router
    .route("/:id")
    .get(factory.getOne(DocumentModel))
    .patch(validateDocumentUpdate, factory.updateOne(DocumentModel));

export default router;
