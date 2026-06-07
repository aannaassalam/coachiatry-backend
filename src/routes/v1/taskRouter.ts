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
    getTaskAssignees,
    importBulkTasks,
    updateSubtaskStatus,
    updateTaskStatus,
} from "../../controllers/taskController";
import TaskModel from "../../model/taskModel";
import { restrictTo } from "./../../controllers/authController";
import * as factory from "./../../controllers/handleFactory";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(
        factory.getAllUnpaginated(TaskModel, {
            ownedOrAssignedToCurrentUser: true,
            requirePopulated: ["status", "category"],
        })
    )
    .post(createTask);

router.post("/coach", createTaskByCoach);

// Coach/manager/admin viewing a specific client's tasks (owned by OR
// assigned to that client). Path param keeps the client id out of the
// generic query-filter pipeline.
router.get(
    "/coach/:userId",
    restrictTo("admin", "manager", "coach"),
    getCoachTasks
);

router.patch("/assign-toggle", assignToCoach);
router.get("/:id/assignees", getTaskAssignees);
router.patch("/move-to-status/:id", updateTaskStatus);
router.patch("/completed/:task_id/:subtask_id", updateSubtaskStatus);

router.get("/shared/:shareId", accessSharedTasks);

router
    .route("/:id")
    .get(factory.getOne(TaskModel))
    .patch(editTask)
    .delete(deleteTask);

router.post("/import-bulk-tasks", importBulkTasks);

export default router;
