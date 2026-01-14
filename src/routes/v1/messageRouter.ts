import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import {
    editScheduleMessage,
    getMessages,
    getScheduleMessages,
    getScheduleMessagesByCoach,
    scheduleMessage,
} from "../../controllers/messageController";

const router = express.Router();
router.use(protect);

router.route("/schedule").get(getScheduleMessages).post(scheduleMessage);
router.get(
    "/schedule/coach/:userId",
    restrictTo("admin", "manager", "coach"),
    getScheduleMessagesByCoach
);
router.route("/schedule/:messageId").patch(editScheduleMessage);
router.route("/:roomId").get(getMessages);
// .post(factory.createOne(ChatModel, { userAsDocumentOwner: true }));

export default router;
