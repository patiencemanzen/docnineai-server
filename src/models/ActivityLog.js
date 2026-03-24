import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Action constants
// ---------------------------------------------------------------------------
export const ACTIVITY_ACTIONS = {
  // Auth
  AUTH_LOGIN:                 "AUTH_LOGIN",
  AUTH_LOGOUT:                "AUTH_LOGOUT",
  AUTH_SIGNUP:                "AUTH_SIGNUP",
  AUTH_PASSWORD_CHANGED:      "AUTH_PASSWORD_CHANGED",
  AUTH_EMAIL_VERIFIED:        "AUTH_EMAIL_VERIFIED",
  AUTH_PASSWORD_RESET:        "AUTH_PASSWORD_RESET",

  // Project lifecycle
  PROJECT_CREATED:            "PROJECT_CREATED",
  PROJECT_DELETED:            "PROJECT_DELETED",
  PROJECT_UPDATED:            "PROJECT_UPDATED",
  PROJECT_ARCHIVED:           "PROJECT_ARCHIVED",
  PROJECT_RESTORED:           "PROJECT_RESTORED",
  PROJECT_RETRIED:            "PROJECT_RETRIED",

  // Pipeline
  PIPELINE_STARTED:           "PIPELINE_STARTED",
  PIPELINE_COMPLETED:         "PIPELINE_COMPLETED",
  PIPELINE_FAILED:            "PIPELINE_FAILED",
  PIPELINE_TIMEOUT:           "PIPELINE_TIMEOUT",

  // Agents (batch-buffered)
  AGENT_STARTED:              "AGENT_STARTED",
  AGENT_COMPLETED:            "AGENT_COMPLETED",
  AGENT_FAILED:               "AGENT_FAILED",
  AGENT_SKIPPED:              "AGENT_SKIPPED",

  // Documentation
  DOC_SECTION_EDITED:         "DOC_SECTION_EDITED",
  DOC_SECTION_RESTORED:       "DOC_SECTION_RESTORED",
  DOC_VERSION_CREATED:        "DOC_VERSION_CREATED",
  DOC_VERSION_RESTORED:       "DOC_VERSION_RESTORED",

  // Security
  SECURITY_SCAN_COMPLETED:    "SECURITY_SCAN_COMPLETED",
  SECURITY_FINDING_CRITICAL:  "SECURITY_FINDING_CRITICAL",
  SECURITY_FINDING_HIGH:      "SECURITY_FINDING_HIGH",

  // API spec
  APISPEC_GENERATED:          "APISPEC_GENERATED",
  APISPEC_UPDATED:            "APISPEC_UPDATED",

  // Custom tabs / attachments
  ATTACHMENT_UPLOADED:        "ATTACHMENT_UPLOADED",
  ATTACHMENT_DELETED:         "ATTACHMENT_DELETED",

  // Sharing
  SHARE_INVITE_SENT:          "SHARE_INVITE_SENT",
  SHARE_INVITE_ACCEPTED:      "SHARE_INVITE_ACCEPTED",
  SHARE_MEMBER_REMOVED:       "SHARE_MEMBER_REMOVED",
  SHARE_ROLE_CHANGED:         "SHARE_ROLE_CHANGED",

  // Portal
  PORTAL_PUBLISHED:           "PORTAL_PUBLISHED",
  PORTAL_UNPUBLISHED:         "PORTAL_UNPUBLISHED",
  PORTAL_SETTINGS_UPDATED:    "PORTAL_SETTINGS_UPDATED",

  // Exports
  EXPORT_PDF:                 "EXPORT_PDF",
  EXPORT_YAML:                "EXPORT_YAML",
  EXPORT_NOTION:              "EXPORT_NOTION",
  EXPORT_GOOGLE_DOCS:         "EXPORT_GOOGLE_DOCS",

  // Integrations
  INTEGRATION_GITHUB_CONNECTED:       "INTEGRATION_GITHUB_CONNECTED",
  INTEGRATION_GITHUB_DISCONNECTED:    "INTEGRATION_GITHUB_DISCONNECTED",
  INTEGRATION_GITLAB_CONNECTED:       "INTEGRATION_GITLAB_CONNECTED",
  INTEGRATION_GITLAB_DISCONNECTED:    "INTEGRATION_GITLAB_DISCONNECTED",
  INTEGRATION_BITBUCKET_CONNECTED:    "INTEGRATION_BITBUCKET_CONNECTED",
  INTEGRATION_BITBUCKET_DISCONNECTED: "INTEGRATION_BITBUCKET_DISCONNECTED",
  INTEGRATION_NOTION_CONNECTED:       "INTEGRATION_NOTION_CONNECTED",
  INTEGRATION_NOTION_DISCONNECTED:    "INTEGRATION_NOTION_DISCONNECTED",
  INTEGRATION_GOOGLE_DOCS_CONNECTED:  "INTEGRATION_GOOGLE_DOCS_CONNECTED",
  INTEGRATION_GOOGLE_DOCS_DISCONNECTED: "INTEGRATION_GOOGLE_DOCS_DISCONNECTED",
  INTEGRATION_WEBHOOK_CREATED:        "INTEGRATION_WEBHOOK_CREATED",
  INTEGRATION_WEBHOOK_ROTATED:        "INTEGRATION_WEBHOOK_ROTATED",
  INTEGRATION_SLACK_CONNECTED:        "INTEGRATION_SLACK_CONNECTED",
  INTEGRATION_SLACK_DISCONNECTED:     "INTEGRATION_SLACK_DISCONNECTED",

  // Subscription & billing
  SUBSCRIPTION_UPGRADED:      "SUBSCRIPTION_UPGRADED",
  SUBSCRIPTION_DOWNGRADED:    "SUBSCRIPTION_DOWNGRADED",
  SUBSCRIPTION_CANCELLED:     "SUBSCRIPTION_CANCELLED",
  SUBSCRIPTION_PAYMENT_FAILED: "SUBSCRIPTION_PAYMENT_FAILED",

  // API tokens
  API_TOKEN_CREATED:          "API_TOKEN_CREATED",
  API_TOKEN_REVOKED:          "API_TOKEN_REVOKED",

  // System / internal
  SYSTEM_ERROR:               "SYSTEM_ERROR",
};

// ---------------------------------------------------------------------------
// Category map
// ---------------------------------------------------------------------------
export const CATEGORY_MAP = {
  AUTH_LOGIN:                   "auth",
  AUTH_LOGOUT:                  "auth",
  AUTH_SIGNUP:                  "auth",
  AUTH_PASSWORD_CHANGED:        "auth",
  AUTH_EMAIL_VERIFIED:          "auth",
  AUTH_PASSWORD_RESET:          "auth",

  PROJECT_CREATED:              "project",
  PROJECT_DELETED:              "project",
  PROJECT_UPDATED:              "project",
  PROJECT_ARCHIVED:             "project",
  PROJECT_RESTORED:             "project",
  PROJECT_RETRIED:              "project",

  PIPELINE_STARTED:             "pipeline",
  PIPELINE_COMPLETED:           "pipeline",
  PIPELINE_FAILED:              "pipeline",
  PIPELINE_TIMEOUT:             "pipeline",
  AGENT_STARTED:                "pipeline",
  AGENT_COMPLETED:              "pipeline",
  AGENT_FAILED:                 "pipeline",
  AGENT_SKIPPED:                "pipeline",

  DOC_SECTION_EDITED:           "doc",
  DOC_SECTION_RESTORED:         "doc",
  DOC_VERSION_CREATED:          "doc",
  DOC_VERSION_RESTORED:         "doc",

  SECURITY_SCAN_COMPLETED:      "security",
  SECURITY_FINDING_CRITICAL:    "security",
  SECURITY_FINDING_HIGH:        "security",

  APISPEC_GENERATED:            "apispec",
  APISPEC_UPDATED:              "apispec",

  ATTACHMENT_UPLOADED:          "attachment",
  ATTACHMENT_DELETED:           "attachment",

  SHARE_INVITE_SENT:            "sharing",
  SHARE_INVITE_ACCEPTED:        "sharing",
  SHARE_MEMBER_REMOVED:         "sharing",
  SHARE_ROLE_CHANGED:           "sharing",

  PORTAL_PUBLISHED:             "portal",
  PORTAL_UNPUBLISHED:           "portal",
  PORTAL_SETTINGS_UPDATED:      "portal",

  EXPORT_PDF:                   "export",
  EXPORT_YAML:                  "export",
  EXPORT_NOTION:                "export",
  EXPORT_GOOGLE_DOCS:           "export",

  INTEGRATION_GITHUB_CONNECTED:         "integration",
  INTEGRATION_GITHUB_DISCONNECTED:      "integration",
  INTEGRATION_GITLAB_CONNECTED:         "integration",
  INTEGRATION_GITLAB_DISCONNECTED:      "integration",
  INTEGRATION_BITBUCKET_CONNECTED:      "integration",
  INTEGRATION_BITBUCKET_DISCONNECTED:   "integration",
  INTEGRATION_NOTION_CONNECTED:         "integration",
  INTEGRATION_NOTION_DISCONNECTED:      "integration",
  INTEGRATION_GOOGLE_DOCS_CONNECTED:    "integration",
  INTEGRATION_GOOGLE_DOCS_DISCONNECTED: "integration",
  INTEGRATION_WEBHOOK_CREATED:          "integration",
  INTEGRATION_WEBHOOK_ROTATED:          "integration",
  INTEGRATION_SLACK_CONNECTED:          "integration",
  INTEGRATION_SLACK_DISCONNECTED:       "integration",

  SUBSCRIPTION_UPGRADED:        "subscription",
  SUBSCRIPTION_DOWNGRADED:      "subscription",
  SUBSCRIPTION_CANCELLED:       "subscription",
  SUBSCRIPTION_PAYMENT_FAILED:  "subscription",

  API_TOKEN_CREATED:            "auth",
  API_TOKEN_REVOKED:            "auth",

  SYSTEM_ERROR:                 "system",
};

// ---------------------------------------------------------------------------
// Severity map (defaults to "info" for everything not listed)
// ---------------------------------------------------------------------------
export const SEVERITY_MAP = {
  AUTH_SIGNUP:                "success",
  PIPELINE_COMPLETED:         "success",
  PORTAL_PUBLISHED:           "success",
  SUBSCRIPTION_UPGRADED:      "success",

  PIPELINE_TIMEOUT:           "warning",
  AGENT_FAILED:               "warning",
  SECURITY_FINDING_HIGH:      "warning",
  SUBSCRIPTION_DOWNGRADED:    "warning",

  PIPELINE_FAILED:            "error",
  SUBSCRIPTION_PAYMENT_FAILED: "error",
  SYSTEM_ERROR:               "error",

  SECURITY_FINDING_CRITICAL:  "critical",
};

const ALL_ACTIONS  = Object.values(ACTIVITY_ACTIONS);
const ALL_CATEGORIES = ["auth","project","pipeline","doc","security","apispec","attachment","sharing","portal","export","integration","subscription","system"];
const ALL_SEVERITIES = ["info","success","warning","error","critical"];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const activityLogSchema = new mongoose.Schema(
  {
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorName:    { type: String, default: "" },
    actorEmail:   { type: String, default: "" },

    action:       { type: String, enum: ALL_ACTIONS, required: true },
    category:     { type: String, enum: ALL_CATEGORIES, required: true },
    severity:     { type: String, enum: ALL_SEVERITIES, default: "info" },

    projectId:    { type: mongoose.Schema.Types.ObjectId, ref: "Project", index: true, sparse: true },
    projectName:  { type: String, default: "" },
    resourceId:   { type: String, default: "" },   // generic secondary resource id (shareId, versionId, etc.)
    resourceType: { type: String, default: "" },   // "share" | "version" | "attachment" | ...

    metadata:     { type: mongoose.Schema.Types.Mixed, default: {} },

    ipAddress:    { type: String, default: "" },
    userAgent:    { type: String, default: "" },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// Compound query indexes
activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ projectId: 1, createdAt: -1 });
activityLogSchema.index({ category: 1, createdAt: -1 });
activityLogSchema.index({ severity: 1, createdAt: -1 });

// TTL — auto-delete after 90 days
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const ActivityLog = mongoose.model("ActivityLog", activityLogSchema);

export default ActivityLog;
