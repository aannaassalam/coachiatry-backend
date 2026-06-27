import { restrictTo } from "./../../controllers/authController";
import express from "express";
import { protect } from "../../controllers/authController";
import { getClients } from "../../controllers/coachController";
import {
    deleteTranscription,
    getTranscription,
} from "../../controllers/transcriptionController";
import { authorizeTranscriptionAccess } from "../../utils/authorize";

const router = express.Router();
router.use(protect);

router.get("/clients", restrictTo("coach"), getClients);

// Dual-read aware so coaches see segments from the new per-segment model,
// not just legacy embedded arrays. Cascade-deletes segments too.
router
    .route("/:id")
    .get(authorizeTranscriptionAccess("id"), getTranscription)
    .delete(authorizeTranscriptionAccess("id"), deleteTranscription);

export default router;
