import { restrictTo } from "./../../controllers/authController";
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
    getAllConversationsByCoach,
    getConversation,
    leaveGroup,
    startChatMultipartUpload,
} from "../../controllers/chatController";
import upload from "../../utils/multerConfig";
import { getUsersById } from "../../controllers/userController";

const router = express.Router();
router.use(protect);

router.get("/", getAllConversations);
router.get("/coach/:userId", restrictTo("coach"), getAllConversationsByCoach);
router.get("/coach/room/:roomId", restrictTo("coach"), getConversation);

router.post("/upload/start", startChatMultipartUpload);
router.post("/upload/parts", chatPartUrls);
router.post("/upload/complete", chatUploadComplete);

router.post("/group", upload.single("groupPhoto"), createGroup);
router.post("/group/edit", upload.single("groupPhoto"), editGroup);
router.delete("/leave-group/:chatId", leaveGroup);

router.get("/:roomId", getConversation);

export default router;
