import express from "express";
import { protect } from "../../controllers/authController";
import ChatModel from "../../model/chatModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    getAllConversations,
    getConversation,
} from "../../controllers/chatController";

const router = express.Router();
router.use(protect);

router.route("/").get(getAllConversations);

router.route("/:roomId").get(getConversation);
// .post(factory.createOne(ChatModel, { userAsDocumentOwner: true }));

export default router;
