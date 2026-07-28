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
    deleteMyAccount,
    deleteUserSoft,
    getAllUsers,
    getAllWatching,
    getMe,
    getUserById,
    getUsers,
    getUsersById,
    revokeViewerAccess,
    setUserPassword,
    suggestUsers,
    findWatcherByEmail,
    inviteWatchersByEmail,
    updateProfilePicture,
    updateUserByHierarchy,
} from "../../controllers/userController";
import upload from "../../utils/multerConfig";

const router = express.Router();
router.use(protect);

router
    .route("/me")
    .get(getMe)
    .patch(injectUserId, validateUserUpdate, factory.updateOne(UserModel))
    .delete(deleteMyAccount);

router.patch(
    "/me/update-profile-picture",
    upload.single("profilePicture"),
    updateProfilePicture
);

router.get("/suggestions", suggestUsers);
router.get("/find-watcher-by-email", findWatcherByEmail);
router.post("/invite-watchers", inviteWatchersByEmail);
router.get("/user-by-ids", getUsersById);
router.get("/user-by-id/:userId", getUserById);
router.post("/add-watchers", addWatchersById);

router.get("/share/:shareId", addWatchersByLink);
router.get("/get-all-watching", getAllWatching);
router.delete("/share/:viewerId", revokeViewerAccess);

// Coach-managing-a-client mirrors of the self-scoped routes above. Same
// handlers — resolveTargetUser swaps `req.user` for the `:userId` client once
// it has checked the caller is staff. Used by the client settings modal.
router.post("/:userId/add-watchers", addWatchersById);
router.post("/:userId/invite-watchers", inviteWatchersByEmail);
router.delete("/:userId/share/:viewerId", revokeViewerAccess);
router.patch(
    "/:userId/update-profile-picture",
    upload.single("profilePicture"),
    updateProfilePicture,
);
router.patch("/:userId/password", setUserPassword);

router.get("/get-users", getUsers);
router.get("/get-all", getAllUsers);
router.post("/create-user", createUserByHierarchy);
router.put("/update-user/:id", updateUserByHierarchy);
router.delete("/delete-user/:id", deleteUserSoft);

export default router;
