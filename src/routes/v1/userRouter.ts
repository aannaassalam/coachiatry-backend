import express from "express";
import multer from "multer";
import { injectUserId, protect } from "../../controllers/authController";
import UserModel from "../../model/userModel";
import { validateUserUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    addWatchersById,
    addWatchersByLink,
    getAllWatching,
    revokeViewerAccess,
    suggestUsers,
    updateProfilePicture,
} from "../../controllers/userController";

const router = express.Router();
router.use(protect);

// Multer setup with memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

router
    .route("/me")
    .get(injectUserId, factory.getOne(UserModel))
    .patch(injectUserId, validateUserUpdate, factory.updateOne(UserModel));

router.patch(
    "/me/update-profile-picture",
    upload.single("profilePicture"),
    updateProfilePicture
);

router.get("/suggestions", suggestUsers);
router.post("/add-watchers", addWatchersById);

router.get("/share/:shareId", addWatchersByLink);
router.get("/get-all-watching", getAllWatching);
router.delete("/share/:viewerId", revokeViewerAccess);

export default router;
