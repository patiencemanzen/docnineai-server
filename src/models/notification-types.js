// ===================================================================
// notification-types.js
// Central registry: priority + entityType + title/message templates
// for every notification type defined in Notification.js.
//
// messageTemplate(ctx) receives a context object and returns a
// human-readable string. All fields in ctx are optional — use
// fallbacks where needed.
// ===================================================================

/**
 * @typedef {Object} NotificationTypeConfig
 * @property {"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"} priority
 * @property {string}  entityType
 * @property {(ctx: Record<string,string>) => string} titleTemplate
 * @property {(ctx: Record<string,string>) => string} messageTemplate
 */

/** @type {Record<string, NotificationTypeConfig>} */
export const NOTIFICATION_TYPE_CONFIG = {
  // ── Pipeline ────────────────────────────────────────────────────
  PIPELINE_COMPLETED: {
    priority: "MEDIUM",
    entityType: "PIPELINE",
    titleTemplate: () => "Documentation generated",
    messageTemplate: ({ projectName = "Your project" }) =>
      `${projectName} documentation was generated successfully.`,
  },
  PIPELINE_FAILED: {
    priority: "HIGH",
    entityType: "PIPELINE",
    titleTemplate: () => "Documentation generation failed",
    messageTemplate: ({
      projectName = "Your project",
      reason = "an unexpected error",
    }) => `${projectName} failed to generate documentation due to ${reason}.`,
  },
  PIPELINE_TIMEOUT: {
    priority: "HIGH",
    entityType: "PIPELINE",
    titleTemplate: () => "Documentation generation timed out",
    messageTemplate: ({ projectName = "Your project" }) =>
      `${projectName} documentation generation took too long and was stopped.`,
  },

  // ── Documentation ───────────────────────────────────────────────
  DOC_SECTION_UPDATED: {
    priority: "LOW",
    entityType: "DOCUMENTATION",
    titleTemplate: () => "Documentation section updated",
    messageTemplate: ({ projectName = "A project", section = "a section" }) =>
      `Section "${section}" in ${projectName} was updated.`,
  },
  DOC_VERSION_RESTORED: {
    priority: "MEDIUM",
    entityType: "DOCUMENTATION",
    titleTemplate: () => "Documentation version restored",
    messageTemplate: ({
      projectName = "A project",
      version = "a previous version",
    }) => `${projectName} documentation was restored to ${version}.`,
  },
  DOC_STATUS_CHANGED: {
    priority: "LOW",
    entityType: "DOCUMENTATION",
    titleTemplate: () => "Documentation status changed",
    messageTemplate: ({ projectName = "A project", status = "a new status" }) =>
      `${projectName} documentation status changed to ${status}.`,
  },
  DOC_CHANGES_REQUESTED: {
    priority: "MEDIUM",
    entityType: "DOCUMENTATION",
    titleTemplate: () => "Changes requested on documentation",
    messageTemplate: ({
      projectName = "A project",
      requesterName = "A team member",
    }) => `${requesterName} requested changes on ${projectName} documentation.`,
  },
  DOC_APPROVED: {
    priority: "LOW",
    entityType: "DOCUMENTATION",
    titleTemplate: () => "Documentation approved",
    messageTemplate: ({
      projectName = "A project",
      approverName = "A team member",
    }) => `${approverName} approved ${projectName} documentation.`,
  },

  // ── Security ────────────────────────────────────────────────────
  SECURITY_CRITICAL_FINDING: {
    priority: "CRITICAL",
    entityType: "SECURITY",
    titleTemplate: () => "Critical security vulnerability detected",
    messageTemplate: ({
      projectName = "Your project",
      finding = "a critical vulnerability",
    }) =>
      `${projectName} security scan found ${finding}. Immediate action required.`,
  },
  SECURITY_HIGH_FINDING: {
    priority: "HIGH",
    entityType: "SECURITY",
    titleTemplate: () => "High-severity security vulnerability detected",
    messageTemplate: ({
      projectName = "Your project",
      finding = "a high-severity vulnerability",
    }) => `${projectName} security scan found ${finding}.`,
  },
  SECURITY_REPORT_READY: {
    priority: "MEDIUM",
    entityType: "SECURITY",
    titleTemplate: () => "Security report ready",
    messageTemplate: ({ projectName = "Your project" }) =>
      `Security analysis for ${projectName} is complete and ready to review.`,
  },

  // ── Sharing ─────────────────────────────────────────────────────
  SHARE_INVITE_RECEIVED: {
    priority: "MEDIUM",
    entityType: "SHARE",
    titleTemplate: () => "You've been invited to a project",
    messageTemplate: ({ inviterName = "Someone", projectName = "a project" }) =>
      `${inviterName} invited you to collaborate on ${projectName}.`,
  },
  SHARE_INVITE_ACCEPTED: {
    priority: "LOW",
    entityType: "SHARE",
    titleTemplate: () => "Collaboration invite accepted",
    messageTemplate: ({
      inviteeName = "Someone",
      projectName = "your project",
    }) => `${inviteeName} accepted your invite and joined ${projectName}.`,
  },
  SHARE_MEMBER_REMOVED: {
    priority: "LOW",
    entityType: "SHARE",
    titleTemplate: () => "You were removed from a project",
    messageTemplate: ({ projectName = "a project" }) =>
      `Your access to ${projectName} has been revoked.`,
  },
  SHARE_ROLE_CHANGED: {
    priority: "LOW",
    entityType: "SHARE",
    titleTemplate: () => "Your project role was updated",
    messageTemplate: ({ projectName = "a project", newRole = "a new role" }) =>
      `Your role in ${projectName} was changed to ${newRole}.`,
  },

  // ── Portal ──────────────────────────────────────────────────────
  PORTAL_PUBLISHED: {
    priority: "LOW",
    entityType: "PORTAL",
    titleTemplate: () => "Developer portal published",
    messageTemplate: ({ projectName = "Your project" }) =>
      `${projectName} developer portal is now publicly accessible.`,
  },
  PORTAL_VIEWED_MILESTONE: {
    priority: "LOW",
    entityType: "PORTAL",
    titleTemplate: () => "Portal reached a view milestone",
    messageTemplate: ({
      projectName = "Your project",
      count = "a milestone",
    }) => `${projectName} portal has reached ${count} views.`,
  },

  // ── Subscription & Billing ──────────────────────────────────────
  SUBSCRIPTION_PAYMENT_SUCCESS: {
    priority: "LOW",
    entityType: "PAYMENT",
    titleTemplate: () => "Payment successful",
    messageTemplate: ({ plan = "your plan", amount = "" }) =>
      `Your ${plan} subscription payment${amount ? ` of ${amount}` : ""} was processed successfully.`,
  },
  SUBSCRIPTION_PAYMENT_FAILED: {
    priority: "CRITICAL",
    entityType: "PAYMENT",
    titleTemplate: () => "Payment failed",
    messageTemplate: ({ plan = "your plan" }) =>
      `We couldn't process your ${plan} subscription payment. Please update your payment method.`,
  },
  SUBSCRIPTION_PLAN_EXPIRING: {
    priority: "HIGH",
    entityType: "SUBSCRIPTION",
    titleTemplate: () => "Subscription expiring soon",
    messageTemplate: ({ plan = "Your plan", days = "soon" }) =>
      `${plan} subscription expires in ${days} day${days === "1" ? "" : "s"}. Renew to avoid interruption.`,
  },
  SUBSCRIPTION_PLAN_EXPIRED: {
    priority: "CRITICAL",
    entityType: "SUBSCRIPTION",
    titleTemplate: () => "Subscription expired",
    messageTemplate: ({ plan = "Your plan" }) =>
      `${plan} subscription has expired. Upgrade to restore full access.`,
  },
  SUBSCRIPTION_UPGRADED: {
    priority: "LOW",
    entityType: "SUBSCRIPTION",
    titleTemplate: () => "Plan upgraded",
    messageTemplate: ({ newPlan = "a higher plan" }) =>
      `Your subscription was upgraded to the ${newPlan} plan.`,
  },
  SUBSCRIPTION_DOWNGRADED: {
    priority: "MEDIUM",
    entityType: "SUBSCRIPTION",
    titleTemplate: () => "Plan downgraded",
    messageTemplate: ({ newPlan = "a lower plan" }) =>
      `Your subscription was changed to the ${newPlan} plan.`,
  },
  PLAN_LIMIT_APPROACHING: {
    priority: "MEDIUM",
    entityType: "SUBSCRIPTION",
    titleTemplate: () => "Approaching plan limit",
    messageTemplate: ({
      resource = "resources",
      percent = "80",
      plan = "your plan",
    }) =>
      `You've used ${percent}% of your ${resource} limit on the ${plan} plan.`,
  },
  PLAN_LIMIT_REACHED: {
    priority: "HIGH",
    entityType: "SUBSCRIPTION",
    titleTemplate: () => "Plan limit reached",
    messageTemplate: ({ resource = "resources", plan = "your plan" }) =>
      `You've reached the ${resource} limit on the ${plan} plan. Upgrade to continue.`,
  },

  // ── Integrations ────────────────────────────────────────────────
  SLACK_CONNECTED: {
    priority: "LOW",
    entityType: "SLACK",
    titleTemplate: () => "Slack connected",
    messageTemplate: ({ workspaceName = "your Slack workspace" }) =>
      `Docnine is now connected to ${workspaceName}.`,
  },
  SLACK_DISCONNECTED: {
    priority: "MEDIUM",
    entityType: "SLACK",
    titleTemplate: () => "Slack disconnected",
    messageTemplate: () =>
      "Your Slack integration has been disconnected. Pipeline alerts will no longer be sent.",
  },
  EXPORT_COMPLETED: {
    priority: "LOW",
    entityType: "EXPORT",
    titleTemplate: () => "Export ready",
    messageTemplate: ({ projectName = "Your project", format = "file" }) =>
      `${projectName} ${format} export is ready for download.`,
  },

  // ── System ──────────────────────────────────────────────────────
  SYSTEM_ANNOUNCEMENT: {
    priority: "MEDIUM",
    entityType: "SYSTEM",
    titleTemplate: () => "Announcement",
    messageTemplate: ({
      body = "Please check the Docnine dashboard for details.",
    }) => body,
  },
  SYSTEM_MAINTENANCE: {
    priority: "HIGH",
    entityType: "SYSTEM",
    titleTemplate: () => "Scheduled maintenance",
    messageTemplate: ({ scheduledAt = "soon" }) =>
      `Docnine will undergo maintenance ${scheduledAt}. Expect brief downtime.`,
  },
  WELCOME: {
    priority: "LOW",
    entityType: "SYSTEM",
    titleTemplate: () => "Welcome to Docnine!",
    messageTemplate: ({ userName = "there" }) =>
      `Hey ${userName}! Generate your first API documentation in seconds.`,
  },
};

/**
 * Resolve the title for a notification type + context.
 * Falls back to a formatted version of the type string if type is unknown.
 */
export function resolveTitle(type, ctx = {}) {
  const config = NOTIFICATION_TYPE_CONFIG[type];
  if (!config) return type.replace(/_/g, " ").toLowerCase();
  return config.titleTemplate(ctx);
}

/**
 * Resolve the message for a notification type + context.
 * Falls back to an empty string if type is unknown.
 */
export function resolveMessage(type, ctx = {}) {
  const config = NOTIFICATION_TYPE_CONFIG[type];
  if (!config) return "";
  return config.messageTemplate(ctx);
}

/**
 * Resolve the default priority for a notification type.
 * Falls back to "MEDIUM".
 */
export function resolvePriority(type) {
  return NOTIFICATION_TYPE_CONFIG[type]?.priority ?? "MEDIUM";
}

/**
 * Resolve the entity type for a notification type.
 * Falls back to "SYSTEM".
 */
export function resolveEntityType(type) {
  return NOTIFICATION_TYPE_CONFIG[type]?.entityType ?? "SYSTEM";
}
