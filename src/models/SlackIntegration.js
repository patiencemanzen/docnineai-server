
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const SlackIntegrationSchema = new Schema(
  {

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


    workspaceId: {
      type: String,

      trim: true,
    },
    workspaceName: {
      type: String,
      trim: true,
    },
    teamId: {

      type: String,
      trim: true,
    },


    isCustomApp: {
      type: Boolean,
      default: false,

    },
    slackClientId: {
      type: String,
      select: false,
    },
    slackClientSecret: {
      type: String,
      select: false,
    },
    slackSigningSecret: {
      type: String,
      select: false,
    },
    slackClientIdEncrypted: {
      type: String,

    },
    slackClientSecretEncrypted: {
      type: String,

    },
    slackSigningSecretEncrypted: {
      type: String,

    },


    botUserId: {
      type: String,

      trim: true,
    },
    botAccessToken: {
      type: String,

      select: false,
    },
    botTokenEncrypted: {
      type: String,

    },
    appId: {
      type: String,
      trim: true,
    },
    installedAt: Date,
    installedBy: String,


    oauthState: {
      type: String,
      trim: true,
    },


    alertChannelId: {
      type: String,
      trim: true,
    },
    alertChannelName: {
      type: String,
      trim: true,
    },


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


    lastAlertedSecurityScore: {
      type: Number,
      default: 100,
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


SlackIntegrationSchema.pre("validate", async function (next) {
  try {
    const { encrypt } = await import("../utils/crypto.util.js");
    

    if (this.isModified("botAccessToken")) {
      this.botTokenEncrypted = encrypt(this.botAccessToken);
    }
    

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
    this.events = this.events.slice(-100);
  }
  await this.save();
};

export const SlackIntegration = model(
  "SlackIntegration",
  SlackIntegrationSchema,
);
