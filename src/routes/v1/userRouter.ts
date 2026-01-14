import express from "express";
import multer from "multer";
import { injectUserId, protect } from "../../controllers/authController";
import UserModel from "../../model/userModel";
import { validateUserUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    addWatchersById,
    addWatchersByLink,
    createUserByHierarchy,
    deleteUserSoft,
    getAllUsers,
    getAllWatching,
    getUserById,
    getUsers,
    getUsersById,
    revokeViewerAccess,
    suggestUsers,
    updateProfilePicture,
    updateUserByHierarchy,
} from "../../controllers/userController";
import upload from "../../utils/multerConfig";

const router = express.Router();
router.use(protect);

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
router.get("/user-by-ids", getUsersById);
router.get("/user-by-id/:userId", getUserById);
router.post("/add-watchers", addWatchersById);

router.get("/share/:shareId", addWatchersByLink);
router.get("/get-all-watching", getAllWatching);
router.delete("/share/:viewerId", revokeViewerAccess);

router.get("/get-users", getUsers);
router.get("/get-all", getAllUsers);
router.post("/create-user", createUserByHierarchy);
router.put("/update-user/:id", updateUserByHierarchy);
router.delete("/delete-user/:id", deleteUserSoft);

export default router;
