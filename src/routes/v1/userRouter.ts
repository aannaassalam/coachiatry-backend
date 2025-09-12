import express from "express";
import { injectUserId, protect } from "../../controllers/authController";
import UserModel from "../../model/userModel";
import { validateUserUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";

const router = express.Router();
router.use(protect);

router
    .route("/me")
    .get(injectUserId, factory.getOne(UserModel))
    .patch(injectUserId, validateUserUpdate, factory.updateOne(UserModel));

export default router;
