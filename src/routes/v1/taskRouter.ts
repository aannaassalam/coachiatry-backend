import { restrictTo } from "./../../controllers/authController";
import express from "express";
import { protect } from "../../controllers/authController";
import { validateDocumentUpdate } from "../../utils/validator";
import * as factory from "./../../controllers/handleFactory";
import TaskModel from "../../model/taskModel";
import {
    accessSharedTasks,
    importBulkTasks,
    updateSubtaskStatus,
    updateTaskStatus,
} from "../../controllers/taskController";

const router = express.Router();
router.use(protect);

router
    .route("/")
    .get(factory.getAllUnpaginated(TaskModel, { currentUserOnly: true }))
    .post(factory.createOne(TaskModel, { userAsDocumentOwner: true }));

router
    .route("/coach")
    .get(restrictTo("coach"), factory.getAllUnpaginated(TaskModel))
    .post(restrictTo("coach"), factory.createOne(TaskModel));

router.patch("/move-to-status/:id", updateTaskStatus);
router.patch("/completed/:task_id/:subtask_id", updateSubtaskStatus);

router.get("/shared/:shareId", accessSharedTasks);

router
    .route("/:id")
    .get(factory.getOne(TaskModel))
    .patch(factory.updateOne(TaskModel))
    .delete(factory.deleteOne(TaskModel));

router.post("/import-bulk-tasks", importBulkTasks);

export default router;
