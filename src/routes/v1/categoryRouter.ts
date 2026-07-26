import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import { authorizeSharedView } from "../../utils/authorize";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import CategoryModel from "../../model/categoryModel";
import { deleteCategory } from "../../controllers/categoryController";

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

// Same as statuses: a share-link watcher reads the sheet OWNER's categories.
router.get(
    "/shared/:shareId",
    authorizeSharedView(),
    factory.getAllUnpaginated(CategoryModel, { coachTypeFilter: true })
);

router
    .route("/coach/:userId")
    .get(
        restrictTo("admin", "manager", "coach"),
        factory.getAllUnpaginated(CategoryModel, {
            coachTypeFilter: true,
        })
    )
    .post(
        restrictTo("admin", "manager", "coach"),
        factory.createOne(CategoryModel, { ownerFromParam: "userId" })
    );

router
    .route("/:id")
    .get(factory.getOne(CategoryModel))
    .patch(validateDocumentUpdate, factory.updateOne(CategoryModel))
    .delete(deleteCategory);

export default router;
