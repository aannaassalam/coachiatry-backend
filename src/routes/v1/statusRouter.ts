import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
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
    .route("/coach/:userId")
    .get(
        restrictTo("coach"),
        factory.getAllUnpaginated(StatusModel, {
            coachTypeFilter: true,
        })
    )
    .post(restrictTo("coach"), factory.createOne(StatusModel));

router
    .route("/:id")
    .get(factory.getOne(StatusModel))
    .patch(validateDocumentUpdate, factory.updateOne(StatusModel));

export default router;
