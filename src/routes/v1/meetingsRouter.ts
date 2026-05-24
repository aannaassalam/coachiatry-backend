import express from "express";

import { protect } from "../../controllers/authController";
import * as meetingTasks from "../../controllers/meetingTasksController";

const router = express.Router();
router.use(protect);

router.post("/:meetingId/tasks/generate", meetingTasks.generateTasks);
router.post("/:meetingId/tasks/import", meetingTasks.importTasks);

export default router;
