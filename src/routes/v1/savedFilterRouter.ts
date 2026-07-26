import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import {
    createSavedFilter,
    deleteSavedFilter,
    getSavedFilters,
    updateSavedFilter,
} from "../../controllers/savedFilterController";
import {
    authorizeManagedUser,
    authorizeSavedFilterAccess,
} from "../../utils/authorize";
import { validateSavedFilter } from "../../utils/validator";

const router = express.Router();
router.use(protect);

router.route("/").get(getSavedFilters).post(validateSavedFilter, createSavedFilter);

// A coach/manager/admin viewing a client's task sheet works on that client's
// shared set — what they save here is filed against the client's sheet, and the
// client sees and can edit it too. The coach's OWN sheet is separate.
router
    .route("/coach/:userId")
    .get(
        restrictTo("admin", "manager", "coach"),
        authorizeManagedUser("userId"),
        getSavedFilters
    )
    .post(
        restrictTo("admin", "manager", "coach"),
        authorizeManagedUser("userId"),
        validateSavedFilter,
        createSavedFilter
    );

router
    .route("/:id")
    .patch(
        authorizeSavedFilterAccess("id"),
        validateSavedFilter,
        updateSavedFilter
    )
    .delete(authorizeSavedFilterAccess("id"), deleteSavedFilter);

export default router;
