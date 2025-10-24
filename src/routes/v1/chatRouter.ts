import express from "express";
import { protect } from "../../controllers/authController";
import ChatModel from "../../model/chatModel";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import {
    chatPartUrls,
    chatUploadComplete,
    createGroup,
    editGroup,
    getAllConversations,
    getConversation,
    startChatMultipartUpload,
} from "../../controllers/chatController";
import upload from "../../utils/multerConfig";
import { getUsersById } from "../../controllers/userController";

const router = express.Router();
router.use(protect);

router.route("/").get(getAllConversations);

router.route("/:roomId").get(getConversation);

router.post("/upload/start", startChatMultipartUpload);
router.post("/upload/parts", chatPartUrls);
router.post("/upload/complete", chatUploadComplete);

router.post("/group", upload.single("groupPhoto"), createGroup);
router.post("/group/edit", upload.single("groupPhoto"), editGroup);

export default router;
