import { Router } from "express";
import { protect } from "../../../middleware/auth.middleware.js";
import {
  listActivityLogs,
  listProjectActivityLogs,
} from "../../controllers/activity/activity-log.controller.js";

const router = Router();

router.use(protect);

// GET /activity-logs
router.get("/", listActivityLogs);

// GET /activity-logs/project/:projectId
router.get("/project/:projectId", listProjectActivityLogs);

export default router;
