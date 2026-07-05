import express from "express";
import { protect, restrictTo } from "../../controllers/authController";
import {
    editScheduleMessage,
    getMessages,
    getScheduleMessages,
    getScheduleMessagesByCoach,
    scheduleMessage,
} from "../../controllers/messageController";
import {
    authorizeChatAccess,
    authorizeChatMembership,
    authorizeManagedUser,
} from "../../utils/authorize";

const router = express.Router();
router.use(protect);

router.route("/schedule").get(getScheduleMessages).post(scheduleMessage);
router.get(
    "/schedule/coach/:userId",
    restrictTo("admin", "manager", "coach"),
    authorizeManagedUser("userId"),
    getScheduleMessagesByCoach
);
router.route("/schedule/:messageId").patch(editScheduleMessage);

// Coach/admin/manager view a client's room. Role-gated (not membership-gated)
// so they can read a room they aren't a member of. Must be declared before the
// "/:roomId" catch-all. Mirrors chatRouter's "/coach/room/:roomId".
router.get(
    "/coach/room/:roomId",
    restrictTo("admin", "manager", "coach"),
    authorizeChatAccess("roomId"),
    getMessages
);

// User-facing route: the requester must be a member of the chat.
router.route("/:roomId").get(authorizeChatMembership("roomId"), getMessages);
// .post(factory.createOne(ChatModel, { userAsDocumentOwner: true }));

export default router;
