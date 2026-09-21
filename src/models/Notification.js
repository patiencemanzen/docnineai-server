import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const NOTIFICATION_TYPES = [
  "PIPELINE_COMPLETED",
  "PIPELINE_FAILED",
  "PIPELINE_TIMEOUT",
  "DOC_SECTION_UPDATED",
  "DOC_VERSION_RESTORED",
  "DOC_STATUS_CHANGED",
  "DOC_CHANGES_REQUESTED",
  "DOC_APPROVED",

  "SECURITY_CRITICAL_FINDING",
  "SECURITY_HIGH_FINDING",
  "SECURITY_REPORT_READY",

  "SHARE_INVITE_RECEIVED",
  "SHARE_INVITE_ACCEPTED",
  "SHARE_MEMBER_REMOVED",
  "SHARE_ROLE_CHANGED",

  "PORTAL_PUBLISHED",
  "PORTAL_VIEWED_MILESTONE",

  "SUBSCRIPTION_PAYMENT_SUCCESS",
  "SUBSCRIPTION_PAYMENT_FAILED",
  "SUBSCRIPTION_PLAN_EXPIRING",
  "SUBSCRIPTION_PLAN_EXPIRED",
  "SUBSCRIPTION_UPGRADED",
  "SUBSCRIPTION_DOWNGRADED",
  "PLAN_LIMIT_APPROACHING",
  "PLAN_LIMIT_REACHED",

  "SLACK_CONNECTED",
  "SLACK_DISCONNECTED",
  "EXPORT_COMPLETED",

  "SYSTEM_ANNOUNCEMENT",
  "SYSTEM_MAINTENANCE",
  "WELCOME",
];

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

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const TTL_SECONDS = 90 * 24 * 60 * 60;

const NotificationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

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

    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      default: null,
    },
    entityId: {
      type: String,
      default: null,
    },

    actionUrl: {
      type: String,
      default: null,
    },

    isRead: {
      type: Boolean,
      default: false,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },

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

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

NotificationSchema.index({ userId: 1, createdAt: -1 });

NotificationSchema.index({ userId: 1, isArchived: 1, createdAt: -1 });

NotificationSchema.index({ projectId: 1, createdAt: -1 });

NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

NotificationSchema.index({ userId: 1, type: 1, projectId: 1, createdAt: -1 });

export const Notification = model("Notification", NotificationSchema);
