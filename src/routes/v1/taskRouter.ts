import express from "express";
import { protect } from "../../controllers/authController";
import {
    accessSharedTasks,
    assignToCoach,
    createTask,
    createTaskByCoach,
    deleteTask,
    editTask,
    getCoachTasks,
    getMyTasks,
    getTaskAssignees,
    importBulkTasks,
    updateSubtaskStatus,
    updateTaskStatus,
} from "../../controllers/taskController";
import TaskModel from "../../model/taskModel";
import { restrictTo } from "./../../controllers/authController";
import * as factory from "./../../controllers/handleFactory";
import { authorizeTaskAccess } from "../../utils/authorize";

const router = express.Router();
router.use(protect);

router
    .route("/")
    // Dedicated controller (not the generic factory) so the list uses a
    // projected + lean populate — see getMyTasks / fetchTaskList.
    .get(getMyTasks)
    .post(createTask);

router.post(
    "/coach",
    restrictTo("admin", "manager", "coach"),
    createTaskByCoach
);

// Coach/manager/admin viewing a specific client's tasks (owned by OR
// assigned to that client). Path param keeps the client id out of the
// generic query-filter pipeline.
router.get(
    "/coach/:userId",
    restrictTo("admin", "manager", "coach"),
    getCoachTasks
);

router.patch("/assign-toggle", assignToCoach);
router.get("/:id/assignees", authorizeTaskAccess("id"), getTaskAssignees);
router.patch(
    "/move-to-status/:id",
    authorizeTaskAccess("id"),
    updateTaskStatus
);
router.patch(
    "/completed/:task_id/:subtask_id",
    authorizeTaskAccess("task_id"),
    updateSubtaskStatus
);

router.get("/shared/:shareId", accessSharedTasks);

router
    .route("/:id")
    .get(authorizeTaskAccess("id"), factory.getOne(TaskModel))
    .patch(authorizeTaskAccess("id"), editTask)
    .delete(authorizeTaskAccess("id"), deleteTask);

router.post("/import-bulk-tasks", importBulkTasks);

export default router;
