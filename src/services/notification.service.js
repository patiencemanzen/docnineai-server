import mongoose from "mongoose";

import { Notification, NOTIFICATION_TYPES } from "../models/Notification.js";
import {
  resolveTitle,
  resolveMessage,
  resolvePriority,
  resolveEntityType,
} from "../models/notification-types.js";

const VALID_TYPES = new Set(NOTIFICATION_TYPES);

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

async function _write(opts) {
  try {
    const {
      userId,
      type,
      title,
      message,
      projectId,
      entityId,
      actionUrl,
      priority,
      entityType,
      metadata,
      expiresAt,
    } = opts;

    if (!userId || !type) return;
    if (!VALID_TYPES.has(type)) {
      console.warn("[Notification] Unknown type, dropping:", type);
      return;
    }

    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS);
    const query = {
      userId,
      type,
      createdAt: { $gte: dedupSince },
    };
    if (projectId) query.projectId = projectId;

    const existing = await Notification.exists(query);
    if (existing) return;

    const ctx = metadata ?? {};
    const resolvedTitle = title ?? resolveTitle(type, ctx);
    const resolvedMessage = message ?? resolveMessage(type, ctx);
    const resolvedPriority = priority ?? resolvePriority(type);
    const resolvedEntityType = entityType ?? resolveEntityType(type);

    await Notification.create({
      userId,
      type,
      priority: resolvedPriority,
      entityType: resolvedEntityType,
      title: resolvedTitle,
      message: resolvedMessage,
      projectId: projectId ?? null,
      entityId: entityId ?? null,
      actionUrl: actionUrl ?? null,
      isRead: false,
      isArchived: false,
      metadata: metadata ?? {},
      expiresAt: expiresAt ?? undefined,
    });
  } catch (err) {
    console.error("[Notification] Write error:", err.message ?? err);
  }
}

class _NotificationService {
  create(opts) {
    setImmediate(() => _write(opts));
  }

  createForMany(userIds, opts) {
    if (!Array.isArray(userIds) || userIds.length === 0) return;
    for (const userId of userIds) {
      setImmediate(() => _write({ ...opts, userId }));
    }
  }

  createBatch(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const item of items) {
      setImmediate(() => _write(item));
    }
  }

  async getUserNotifications(
    userId,
    { page = 1, limit = 20, unreadOnly = false, archived = false } = {},
  ) {
    const query = { userId, isArchived: archived };
    if (unreadOnly) query.isRead = false;

    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ userId, isRead: false, isArchived: false }),
    ]);

    return { notifications, total, unreadCount };
  }

  async markAsRead(userId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isRead: true },
      { new: true },
    ).lean();
  }

  async markAllAsRead(userId) {
    const result = await Notification.updateMany({ userId, isRead: false }, { isRead: true });
    return { modifiedCount: result.modifiedCount };
  }

  async archive(userId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isArchived: true, isRead: true },
      { new: true },
    ).lean();
  }

  async getUnreadCount(userId) {
    return Notification.countDocuments({
      userId,
      isRead: false,
      isArchived: false,
    });
  }

  async deleteOne(userId, notificationId) {
    const result = await Notification.deleteOne({
      _id: notificationId,
      userId,
    });
    return result.deletedCount === 1;
  }

  async cleanup(before) {
    const result = await Notification.deleteMany({
      $or: [{ expiresAt: { $lt: before } }, { isArchived: true, createdAt: { $lt: before } }],
    });
    return result.deletedCount;
  }
}

export const NotificationService = new _NotificationService();
