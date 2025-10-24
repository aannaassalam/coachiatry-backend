import express from "express";
import { protect } from "../../controllers/authController";
import {
    editScheduleMessage,
    getMessages,
    getScheduleMessages,
    scheduleMessage,
} from "../../controllers/messageController";

const router = express.Router();
router.use(protect);

router.route("/schedule").get(getScheduleMessages).post(scheduleMessage);
router.route("/schedule/:messageId").patch(editScheduleMessage);
router.route("/:roomId").get(getMessages);
// .post(factory.createOne(ChatModel, { userAsDocumentOwner: true }));

export default router;
