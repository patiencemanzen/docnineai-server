// ===================================================================
// notification.controller.js
// ===================================================================

import { NotificationService } from "../../../services/notification.service.js";
import { ok, fail, serverError, wrap } from "../../../utils/response.util.js";

// GET /api/notifications
export const getNotifications = wrap(async (req, res) => {
  const userId = req.user.userId;
  const page = Math.max(1, parseInt(req.query.page ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "20", 10)));
  const unreadOnly = req.query.unreadOnly === "true";
  const archived = req.query.archived === "true";

  const result = await NotificationService.getUserNotifications(userId, {
    page,
    limit,
    unreadOnly,
    archived,
  });

  return ok(res, {
    notifications: result.notifications,
    total: result.total,
    unreadCount: result.unreadCount,
    page,
    limit,
    hasMore: page * limit < result.total,
  });
});

// GET /api/notifications/unread-count
export const getUnreadCount = wrap(async (req, res) => {
  const count = await NotificationService.getUnreadCount(req.user.userId);
  return ok(res, { count });
});

// PATCH /api/notifications/:id/read
export const markAsRead = wrap(async (req, res) => {
  const notification = await NotificationService.markAsRead(
    req.user.userId,
    req.params.id
  );
  if (!notification) return fail(res, "NOT_FOUND", "Notification not found", 404);
  return ok(res, { notification });
});

// PATCH /api/notifications/read-all
export const markAllAsRead = wrap(async (req, res) => {
  const result = await NotificationService.markAllAsRead(req.user.userId);
  return ok(res, result);
});

// PATCH /api/notifications/:id/archive
export const archiveNotification = wrap(async (req, res) => {
  const notification = await NotificationService.archive(
    req.user.userId,
    req.params.id
  );
  if (!notification) return fail(res, "NOT_FOUND", "Notification not found", 404);
  return ok(res, { notification });
});

// DELETE /api/notifications/:id
export const deleteNotification = wrap(async (req, res) => {
  const deleted = await NotificationService.deleteOne(req.user.userId, req.params.id);
  if (!deleted) return fail(res, "NOT_FOUND", "Notification not found", 404);
  return ok(res, { deleted: true });
});
