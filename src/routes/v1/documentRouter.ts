import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import DocumentModel from "../../model/documentModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    accessSharedDocument,
    getAllDocuments,
    getAllDocumentsByCoach,
} from "../../controllers/documentController";
import { authorizeDocumentAccess } from "../../utils/authorize";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(getAllDocuments)
    .post(factory.createOne(DocumentModel, { userAsDocumentOwner: true }));

router
    .route("/coach")
    .get(restrictTo("admin", "manager", "coach"), getAllDocumentsByCoach)
    .post(
        restrictTo("admin", "manager", "coach"),
        factory.createOne(DocumentModel)
    );

router
    .route("/:id")
    .get(authorizeDocumentAccess("id"), factory.getOne(DocumentModel))
    .patch(
        authorizeDocumentAccess("id"),
        validateDocumentUpdate,
        factory.updateOne(DocumentModel)
    )
    .delete(authorizeDocumentAccess("id"), factory.deleteOne(DocumentModel));

router.route("/share/:shareId").get(accessSharedDocument);

export default router;
