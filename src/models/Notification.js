// ===================================================================
// Notification model — in-app notification feed for all users.
//
// Notifications are fire-and-forget — they never block request flows.
// TTL index on expiresAt auto-deletes documents after 90 days.
//
// Priority levels (UI mapping):
//   CRITICAL → red badge
//   HIGH     → orange badge
//   MEDIUM   → blue badge
//   LOW      → gray badge
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

// ── Notification type enum ────────────────────────────────────────
// Extend here — never allow free-form strings.

export const NOTIFICATION_TYPES = [
  // Pipeline & Documentation
  "PIPELINE_COMPLETED",
  "PIPELINE_FAILED",
  "PIPELINE_TIMEOUT",
  "DOC_SECTION_UPDATED",
  "DOC_VERSION_RESTORED",
  "DOC_STATUS_CHANGED",
  "DOC_CHANGES_REQUESTED",
  "DOC_APPROVED",
  // Security
  "SECURITY_CRITICAL_FINDING",
  "SECURITY_HIGH_FINDING",
  "SECURITY_REPORT_READY",
  // Collaboration & Sharing
  "SHARE_INVITE_RECEIVED",
  "SHARE_INVITE_ACCEPTED",
  "SHARE_MEMBER_REMOVED",
  "SHARE_ROLE_CHANGED",
  // Portal
  "PORTAL_PUBLISHED",
  "PORTAL_VIEWED_MILESTONE",
  // Subscription & Billing
  "SUBSCRIPTION_PAYMENT_SUCCESS",
  "SUBSCRIPTION_PAYMENT_FAILED",
  "SUBSCRIPTION_PLAN_EXPIRING",
  "SUBSCRIPTION_PLAN_EXPIRED",
  "SUBSCRIPTION_UPGRADED",
  "SUBSCRIPTION_DOWNGRADED",
  "PLAN_LIMIT_APPROACHING",
  "PLAN_LIMIT_REACHED",
  // Integrations
  "SLACK_CONNECTED",
  "SLACK_DISCONNECTED",
  "EXPORT_COMPLETED",
  // System
  "SYSTEM_ANNOUNCEMENT",
  "SYSTEM_MAINTENANCE",
  "WELCOME",
];

// ── Entity type enum ──────────────────────────────────────────────
export const ENTITY_TYPES = [
  "PROJECT",
  "DOCUMENTATION",
  "SECURITY",
  "PAYMENT",
  "SUBSCRIPTION",
  "SHARE",
  "PORTAL",
  "PIPELINE",
  "SYSTEM",
  "SLACK",
  "EXPORT",
];

// ── Priority enum ─────────────────────────────────────────────────
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

// ─── 90-day TTL ───────────────────────────────────────────────────
const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days in seconds

const NotificationSchema = new Schema(
  {
    // ── Recipient ─────────────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Classification ────────────────────────────────────────
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    priority: {
      type: String,
      enum: PRIORITIES,
      default: "MEDIUM",
    },
    entityType: {
      type: String,
      enum: ENTITY_TYPES,
      default: null,
    },

    // ── Human-readable content ────────────────────────────────
    title: {
      type: String,
      required: true,
      maxlength: 160,
    },
    message: {
      type: String,
      required: true,
      maxlength: 500,
    },

    // ── Related entities ──────────────────────────────────────
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
    },
    entityId: {
      type: String,
      default: null,
    },

    // ── Deep-link navigation ──────────────────────────────────
    actionUrl: {
      type: String,
      default: null,
    },

    // ── Read / archive state ──────────────────────────────────
    isRead: {
      type: Boolean,
      default: false,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },

    // ── Flexible metadata ─────────────────────────────────────
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

    // ── Auto-expiry ───────────────────────────────────────────
    // MongoDB removes documents when expiresAt is in the past.
    // expiresAt is set at insert time to createdAt + 90 days.
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + TTL_SECONDS * 1000),
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// ── Indexes ───────────────────────────────────────────────────────

// Primary feed query — unread notifications for a user
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

// Full feed query
NotificationSchema.index({ userId: 1, createdAt: -1 });

// Archived feed
NotificationSchema.index({ userId: 1, isArchived: 1, createdAt: -1 });

// Project-scoped notifications
NotificationSchema.index({ projectId: 1, createdAt: -1 });

// TTL — MongoDB deletes documents past expiresAt automatically
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Duplicate-prevention compound index ──────────────────────────
// Checked in service before insert.
NotificationSchema.index({ userId: 1, type: 1, projectId: 1, createdAt: -1 });

export const Notification = model("Notification", NotificationSchema);
