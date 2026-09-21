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

const validateId = [param("id").isMongoId().withMessage("Invalid notification ID"), validate];

router.get("/", getNotifications);

router.get("/unread-count", getUnreadCount);

router.patch("/read-all", markAllAsRead);

router.patch("/:id/read", ...validateId, markAsRead);

router.patch("/:id/archive", ...validateId, archiveNotification);

router.delete("/:id", ...validateId, deleteNotification);

export default router;
