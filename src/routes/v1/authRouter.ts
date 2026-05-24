import express from "express";
import * as authController from "../../controllers/authController";
import * as oauthExt from "../../controllers/oauthExtensionController";
import { validateUserSignup } from "../../utils/validator";

const router = express.Router();

router.post("/signup", validateUserSignup, authController.signup);
router.post("/login", authController.login);
router.post("/google-auth", authController.googleAuth);
// Server-mediated Google OAuth for the Chrome extension. See
// controllers/oauthExtensionController for the full flow rationale.
router.get("/google/extension-start", oauthExt.extensionStart);
router.get("/google/extension-callback", oauthExt.extensionCallback);
router.post("/forgot-password", authController.forgotPassword);
router.post("/verifyOtp", authController.verifyOtp);
router.post("/reset-password", authController.resetPassword);

// Protect all routes after this middleware
router.use(authController.protect);

router.patch("/update-password", authController.updatePassword);
router.patch("/update-fcm-token", authController.updateFCMToken);
router.delete("/delete-fcm-token", authController.removeFCMToken);

// Example of role-based restriction:
// router.get('/adminOnly', authController.restrictTo('admin'), (req, res) => res.send('Admin only!'));

export default router;
