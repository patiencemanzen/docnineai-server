// ===================================================================
// Slack Integration Model
// Stores workspace configuration, tokens, and alert settings
// ===================================================================

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const SlackIntegrationSchema = new Schema(
  {
    // ── User & Workspace ──────────────────────────────────────
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },

    // ── Slack Workspace Info ──────────────────────────────────
    workspaceId: {
      type: String,
      // T12345ABC (workspace ID from Slack)
      // Set during OAuth callback, not required during initialization
      trim: true,
    },
    workspaceName: {
      type: String,
      trim: true,
    },
    teamId: {
      // Legacy Slack field
      type: String,
      trim: true,
    },

    // ── Custom Slack App Credentials (per-workspace) ──────────
    // Users can provide their own Slack app credentials for custom workspaces
    // If present, these override the global env vars for this integration
    isCustomApp: {
      type: Boolean,
      default: false,
      // true if using custom Slack app credentials (user-provided)
    },
    slackClientId: {
      type: String,
      select: false, // Never return in queries by default (plaintext temporary)
    },
    slackClientSecret: {
      type: String,
      select: false, // Never return in queries by default (plaintext temporary)
    },
    slackSigningSecret: {
      type: String,
      select: false, // Never return in queries by default (plaintext temporary)
    },
    slackClientIdEncrypted: {
      type: String,
      // Encrypted Client ID (optional, if null uses global env)
    },
    slackClientSecretEncrypted: {
      type: String,
      // Encrypted Client Secret (optional, if null uses global env)
    },
    slackSigningSecretEncrypted: {
      type: String,
      // Encrypted Signing Secret (optional, if null uses global env)
    },

    // ── Slack App Installation ────────────────────────────────
    botUserId: {
      type: String,
      // U12345ABC (bot user ID)
      // Set during OAuth callback, not required during initialization
      trim: true,
    },
    botAccessToken: {
      type: String,
      // Set during OAuth callback, not required during initialization
      select: false, // Never return in queries by default
    },
    botTokenEncrypted: {
      type: String,
      // Encrypted version of botAccessToken
      // Set during OAuth callback, not required during initialization
    },
    appId: {
      type: String,
      trim: true,
    },
    installedAt: Date,
    installedBy: String, // Slack user ID who installed

    // ── OAuth & State ─────────────────────────────────────────
    oauthState: {
      type: String,
      trim: true,
    },

    // ── Alert Configuration ───────────────────────────────────
    alertChannelId: {
      type: String,
      trim: true, // C12345ABC (channel ID for security alerts)
    },
    alertChannelName: {
      type: String,
      trim: true,
    },

    // Alert rules:
    // CRITICAL always alerts with @channel
    // HIGH always alerts without ping
    // MEDIUM batched into weekly digest
    // LOW suppressed unless requested
    enableCriticalAlerts: {
      type: Boolean,
      default: true,
    },
    enableHighAlerts: {
      type: Boolean,
      default: true,
    },
    enableMediumAlerts: {
      type: Boolean,
      default: false,
    },
    enableLowAlerts: {
      type: Boolean,
      default: false,
    },
    pingOnCritical: {
      type: Boolean,
      default: true,
    },

    // ── Last Security Scan ────────────────────────────────────
    lastAlertedSecurityScore: {
      type: Number,
      default: 100, // A grade
    },
    lastAlertedCriticalCount: {
      type: Number,
      default: 0,
    },
    lastAlertedHighCount: {
      type: Number,
      default: 0,
    },
    lastAlertSentAt: Date,

    // ── Status & Health ───────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastHealthCheck: Date,
    healthStatus: {
      type: String,
      enum: ["healthy", "warning", "error"],
      default: "healthy",
    },
    healthMessage: String,

    // ── Events Logging ────────────────────────────────────────
    events: [
      {
        type: {
          type: String,
          enum: [
            "installed",
            "uninstalled",
            "alert_sent",
            "command_executed",
            "token_refreshed",
            "credentials_set",
            "error",
          ],
        },
        message: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    indexes: [
      { userId: 1, projectId: 1, unique: true },
      { workspaceId: 1 },
      { isActive: 1, lastHealthCheck: 1 },
    ],
  },
);

// Encrypt/decrypt helpers for sensitive fields
SlackIntegrationSchema.pre("validate", async function (next) {
  try {
    const { encrypt } = await import("../utils/crypto.util.js");
    
    // Encrypt bot access token
    if (this.isModified("botAccessToken")) {
      this.botTokenEncrypted = encrypt(this.botAccessToken);
    }
    
    // Encrypt custom Slack credentials if provided
    if (this.isModified("slackClientId")) {
      this.slackClientIdEncrypted = encrypt(this.slackClientId);
    }
    if (this.isModified("slackClientSecret")) {
      this.slackClientSecretEncrypted = encrypt(this.slackClientSecret);
    }
    if (this.isModified("slackSigningSecret")) {
      this.slackSigningSecretEncrypted = encrypt(this.slackSigningSecret);
    }
    
    next();
  } catch (err) {
    next(err);
  }
});

SlackIntegrationSchema.pre("save", function (next) {
  // Never store plaintext sensitive values
  if (this.isModified("botAccessToken")) {
    this.botAccessToken = undefined;
  }
  if (this.isModified("slackClientId")) {
    this.slackClientId = undefined;
  }
  if (this.isModified("slackClientSecret")) {
    this.slackClientSecret = undefined;
  }
  if (this.isModified("slackSigningSecret")) {
    this.slackSigningSecret = undefined;
  }
  next();
});

SlackIntegrationSchema.methods.getDecryptedToken = async function () {
  try {
    const { decrypt } = await import("../utils/crypto.util.js");
    return decrypt(this.botTokenEncrypted);
  } catch (err) {
    throw new Error("Failed to decrypt Slack token");
  }
};

SlackIntegrationSchema.methods.getDecryptedClientId = async function () {
  if (!this.slackClientIdEncrypted) return null;
  try {
    const { decrypt } = await import("../utils/crypto.util.js");
    return decrypt(this.slackClientIdEncrypted);
  } catch (err) {
    throw new Error("Failed to decrypt Slack Client ID");
  }
};

SlackIntegrationSchema.methods.getDecryptedClientSecret = async function () {
  if (!this.slackClientSecretEncrypted) return null;
  try {
    const { decrypt } = await import("../utils/crypto.util.js");
    return decrypt(this.slackClientSecretEncrypted);
  } catch (err) {
    throw new Error("Failed to decrypt Slack Client Secret");
  }
};

SlackIntegrationSchema.methods.getDecryptedSigningSecret = async function () {
  if (!this.slackSigningSecretEncrypted) return null;
  try {
    const { decrypt } = await import("../utils/crypto.util.js");
    return decrypt(this.slackSigningSecretEncrypted);
  } catch (err) {
    throw new Error("Failed to decrypt Slack Signing Secret");
  }
};

SlackIntegrationSchema.methods.recordEvent = async function (
  type,
  message,
) {
  this.events.push({ type, message, timestamp: new Date() });
  if (this.events.length > 100) {
    this.events = this.events.slice(-100); // Keep last 100 events
  }
  await this.save();
};

export const SlackIntegration = model(
  "SlackIntegration",
  SlackIntegrationSchema,
);
