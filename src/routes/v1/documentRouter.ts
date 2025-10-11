import express from "express";
import { protect } from "../../controllers/authController";
import DocumentModel from "../../model/documentModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    addDocument,
    updateDocument,
} from "../../controllers/documentController";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(factory.getAll(DocumentModel, { currentUserOnly: true }))
    .post(addDocument);

router
    .route("/:id")
    .get(factory.getOne(DocumentModel))
    .patch(validateDocumentUpdate, updateDocument)
    .delete(factory.deleteOne(DocumentModel));

export default router;
