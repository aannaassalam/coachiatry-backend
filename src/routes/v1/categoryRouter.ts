import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import CategoryModel from "../../model/categoryModel";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(
        factory.getAllUnpaginated(CategoryModel, {
            publicTypeFilter: true,
        })
    )
    .post(factory.createOne(CategoryModel, { userAsDocumentOwner: true }));

router
    .route("/coach/:userId")
    .get(
        restrictTo("coach"),
        factory.getAllUnpaginated(CategoryModel, {
            coachTypeFilter: true,
        })
    )
    .post(restrictTo("coach"), factory.createOne(CategoryModel));

router
    .route("/:id")
    .get(factory.getOne(CategoryModel))
    .patch(validateDocumentUpdate, factory.updateOne(CategoryModel));

export default router;
