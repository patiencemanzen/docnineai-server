// ===================================================================
// notification.service.js
//
// Fire-and-forget notification writer. NEVER throws, NEVER blocks.
// Follows the same pattern as activity-log.service.js.
//
// All public methods that create notifications do so via setImmediate
// so that no calling request is delayed.
//
// Public API:
//   NotificationService.create(opts)
//   NotificationService.createForMany(userIds, opts)
//   NotificationService.createBatch(items)
//   NotificationService.getUserNotifications(userId, options)
//   NotificationService.markAsRead(userId, notificationId)
//   NotificationService.markAllAsRead(userId)
//   NotificationService.archive(userId, notificationId)
//   NotificationService.getUnreadCount(userId)
//   NotificationService.deleteOne(userId, notificationId)
// ===================================================================

import mongoose from "mongoose";

import { Notification, NOTIFICATION_TYPES } from "../models/Notification.js";
import {
  resolveTitle,
  resolveMessage,
  resolvePriority,
  resolveEntityType,
} from "../models/notification-types.js";

const VALID_TYPES = new Set(NOTIFICATION_TYPES);

// Duplicate suppression window : 5 minutes (ms)
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// ─── Internal helpers ─────────────────────────────────────────────

/**
 * Core writer : called from setImmediate, never propagates.
 * @param {object} opts
 */
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

    // ── Duplicate suppression ─────────────────────────────────────
    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS);
    const query = {
      userId,
      type,
      createdAt: { $gte: dedupSince },
    };
    if (projectId) query.projectId = projectId;

    const existing = await Notification.exists(query);
    if (existing) return; // silent dedup

    // ── Resolve title / message / priority from type if not given ──
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

// ─── Public API ───────────────────────────────────────────────────

class _NotificationService {
  /**
   * Create one notification for one user (fire-and-forget).
   * @param {object} opts
   * @param {string|mongoose.Types.ObjectId} opts.userId
   * @param {string} opts.type
   * @param {object} [opts.metadata]   : passed to title/message templates as ctx
   * @param {string} [opts.title]      : override auto-resolved title
   * @param {string} [opts.message]    : override auto-resolved message
   * @param {string} [opts.priority]    : override auto-resolved priority
   * @param {string} [opts.entityType] : override auto-resolved entityType
   * @param {string} [opts.projectId]
   * @param {string} [opts.entityId]
   * @param {string} [opts.actionUrl]
   * @param {Date}   [opts.expiresAt]
   */
  create(opts) {
    setImmediate(() => _write(opts));
  }

  /**
   * Create the same notification for multiple users (fire-and-forget).
   * @param {(string|mongoose.Types.ObjectId)[]} userIds
   * @param {Omit<Parameters<NotificationService["create"]>[0], "userId">} opts
   */
  createForMany(userIds, opts) {
    if (!Array.isArray(userIds) || userIds.length === 0) return;
    for (const userId of userIds) {
      setImmediate(() => _write({ ...opts, userId }));
    }
  }

  /**
   * Create a batch of different notifications at once (fire-and-forget).
   * Each item must include userId + type; other fields are optional.
   * @param {Parameters<NotificationService["create"]>[0][]} items
   */
  createBatch(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    for (const item of items) {
      setImmediate(() => _write(item));
    }
  }

  /**
   * Fetch a page of notifications for a user.
   * @returns {Promise<{notifications: object[], total: number, unreadCount: number}>}
   */
  async getUserNotifications(
    userId,
    { page = 1, limit = 20, unreadOnly = false, archived = false } = {},
  ) {
    const query = { userId, isArchived: archived };
    if (unreadOnly) query.isRead = false;

    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ userId, isRead: false, isArchived: false }),
    ]);

    return { notifications, total, unreadCount };
  }

  /**
   * Mark a single notification as read.
   * @returns {Promise<object|null>}
   */
  async markAsRead(userId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isRead: true },
      { new: true },
    ).lean();
  }

  /**
   * Mark all unread notifications as read for a user.
   * @returns {Promise<{modifiedCount: number}>}
   */
  async markAllAsRead(userId) {
    const result = await Notification.updateMany(
      { userId, isRead: false },
      { isRead: true },
    );
    return { modifiedCount: result.modifiedCount };
  }

  /**
   * Archive a notification (hides from feed without deleting).
   * @returns {Promise<object|null>}
   */
  async archive(userId, notificationId) {
    return Notification.findOneAndUpdate(
      { _id: notificationId, userId },
      { isArchived: true, isRead: true },
      { new: true },
    ).lean();
  }

  /**
   * Get the number of unread notifications for a user.
   * @returns {Promise<number>}
   */
  async getUnreadCount(userId) {
    return Notification.countDocuments({
      userId,
      isRead: false,
      isArchived: false,
    });
  }

  /**
   * Hard-delete a single notification for a user.
   * @returns {Promise<boolean>}
   */
  async deleteOne(userId, notificationId) {
    const result = await Notification.deleteOne({
      _id: notificationId,
      userId,
    });
    return result.deletedCount === 1;
  }

  /**
   * Cleanup helper: remove already-expired or archived notifications
   * older than the cutoff date. Used by the scheduler for manual GC
   * in addition to the MongoDB TTL index.
   * @param {Date} before
   * @returns {Promise<number>} number of deleted documents
   */
  async cleanup(before) {
    const result = await Notification.deleteMany({
      $or: [
        { expiresAt: { $lt: before } },
        { isArchived: true, createdAt: { $lt: before } },
      ],
    });
    return result.deletedCount;
  }
}

export const NotificationService = new _NotificationService();
