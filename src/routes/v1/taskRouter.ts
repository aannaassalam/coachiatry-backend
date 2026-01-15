import express from "express";
import { protect } from "../../controllers/authController";
import {
    accessSharedTasks,
    // assignToCoach,
    createTask,
    createTaskByCoach,
    deleteTask,
    editTask,
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
    .get(factory.getAllUnpaginated(TaskModel, { currentUserOnly: true }))
    .post(createTask);

router
    .route("/coach")
    .get(
        restrictTo("admin", "manager", "coach"),
        factory.getAllUnpaginated(TaskModel)
    )
    .post(createTaskByCoach);

// router.patch("/assign-toggle", assignToCoach);
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
