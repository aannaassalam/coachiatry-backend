import express from "express";
import { protect } from "../../controllers/authController";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import StatusModel from "../../model/statusModel";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(
        factory.getAllUnpaginated(StatusModel, {
            publicTypeFilter: true,
        })
    )
    .post(factory.createOne(StatusModel, { userAsDocumentOwner: true }));

router
    .route("/:id")
    .get(factory.getOne(StatusModel))
    .patch(validateDocumentUpdate, factory.updateOne(StatusModel));

export default router;
