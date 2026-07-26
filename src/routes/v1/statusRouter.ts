import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import { authorizeSharedView } from "../../utils/authorize";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import StatusModel from "../../model/statusModel";
import { deleteStatus } from "../../controllers/statusController";

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

// A share-link watcher reads the sheet OWNER's statuses — grouping and the
// filter dropdowns are meaningless against their own.
router.get(
    "/shared/:shareId",
    authorizeSharedView(),
    factory.getAllUnpaginated(StatusModel, { coachTypeFilter: true })
);

router
    .route("/coach/:userId")
    .get(
        restrictTo("admin", "manager", "coach"),
        factory.getAllUnpaginated(StatusModel, {
            coachTypeFilter: true,
        })
    )
    .post(
        restrictTo("admin", "manager", "coach"),
        factory.createOne(StatusModel, { ownerFromParam: "userId" })
    );

router
    .route("/:id")
    .get(factory.getOne(StatusModel))
    .patch(validateDocumentUpdate, factory.updateOne(StatusModel))
    .delete(deleteStatus);

export default router;
