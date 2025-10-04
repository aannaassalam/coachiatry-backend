import express from "express";
import { protect } from "../../controllers/authController";
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
    .route("/:id")
    .get(factory.getOne(CategoryModel))
    .patch(validateDocumentUpdate, factory.updateOne(CategoryModel));

export default router;
