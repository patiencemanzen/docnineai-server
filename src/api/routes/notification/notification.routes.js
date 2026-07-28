// ===================================================================
// notification.routes.js
// Base: /api/notifications
// ===================================================================

import { Router } from "express";
import { param } from "express-validator";
import { protect } from "../../../middleware/auth.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  archiveNotification,
  deleteNotification,
} from "../../controllers/notification/notification.controller.js";

const router = Router();

router.use(protect);

// Reusable MongoId guard : prevents CastError 500s on invalid :id values
const validateId = [param("id").isMongoId().withMessage("Invalid notification ID"), validate];

// GET /api/notifications
router.get("/", getNotifications);

// GET /api/notifications/unread-count
// NOTE: must be declared before /:id routes to avoid param collision
router.get("/unread-count", getUnreadCount);

// PATCH /api/notifications/read-all
router.patch("/read-all", markAllAsRead);

// PATCH /api/notifications/:id/read
router.patch("/:id/read", ...validateId, markAsRead);

// PATCH /api/notifications/:id/archive
router.patch("/:id/archive", ...validateId, archiveNotification);

// DELETE /api/notifications/:id
router.delete("/:id", ...validateId, deleteNotification);

export default router;
