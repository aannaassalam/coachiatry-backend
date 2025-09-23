import express from "express";
import { protect } from "../../controllers/authController";
import { getMessages } from "../../controllers/messageController";

const router = express.Router();
router.use(protect);

router.route("/:roomId").get(getMessages);
// .post(factory.createOne(ChatModel, { userAsDocumentOwner: true }));

export default router;
