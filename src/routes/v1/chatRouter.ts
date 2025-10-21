import express from "express";
import { protect } from "../../controllers/authController";
import ChatModel from "../../model/chatModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    chatPartUrls,
    chatUploadComplete,
    getAllConversations,
    getConversation,
    startChatMultipartUpload,
} from "../../controllers/chatController";
import upload from "../../utils/multerConfig";

const router = express.Router();
router.use(protect);

router.route("/").get(getAllConversations);

router.route("/:roomId").get(getConversation);

router.post("/upload/start", startChatMultipartUpload);
router.post("/upload/parts", chatPartUrls);
router.post("/upload/complete", chatUploadComplete);

export default router;
