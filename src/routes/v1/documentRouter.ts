import express from "express";
import { protect } from "../../controllers/authController";
import DocumentModel from "../../model/documentModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    accessSharedDocument,
    getAllDocuments,
} from "../../controllers/documentController";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(getAllDocuments)
    .post(factory.createOne(DocumentModel, { userAsDocumentOwner: true }));

router
    .route("/:id")
    .get(factory.getOne(DocumentModel))
    .patch(validateDocumentUpdate, factory.updateOne(DocumentModel))
    .delete(factory.deleteOne(DocumentModel));

router.route("/share/:shareId").get(accessSharedDocument);

export default router;
