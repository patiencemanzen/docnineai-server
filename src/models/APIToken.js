/**
 * APIToken Model
 * Stores API tokens for programmatic access (MCP, CLI, integrations)
 */

import mongoose from "mongoose";
import { randomBytes } from "crypto";
import { hashToken } from "../utils/crypto.util.js";

const apiTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    // Never store plain token : only hash
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Last 4 chars of token for display (e.g., "...abc1")
    lastChars: {
      type: String,
      required: true,
    },
    // Scope: which APIs/features this token can access
    scope: {
      type: [String],
      enum: ["mcp", "cli", "api"],
      default: ["api"],
    },
    // Optional: restrict to specific projects
    projectIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Project",
      },
    ],
    // Expiry (optional)
    expiresAt: {
      type: Date,
      default: null,
    },
    // Last used timestamp
    lastUsedAt: {
      type: Date,
      default: null,
    },
    // IP whitelist (optional)
    ipWhitelist: [String],
    // Is revoked?
    isRevoked: {
      type: Boolean,
      default: false,
    },
    revokedAt: Date,
  },
  {
    timestamps: true,
  },
);

// ── Index for faster queries ──
apiTokenSchema.index({ userId: 1, isRevoked: 1 });
apiTokenSchema.index({ expiresAt: 1 }, { sparse: true });

// ── Statics ──

/**
 * Generate a new token and return { plainToken, hash }
 * plainToken is given to user once; hash is stored in DB
 */
apiTokenSchema.statics.generateToken = function () {
  const prefix = "docnine_";
  const randomPart = randomBytes(24).toString("hex");
  const plainToken = `${prefix}${randomPart}`;
  const tokenHash = hashToken(plainToken);
  const lastChars = plainToken.slice(-6);

  return { plainToken, tokenHash, lastChars };
};

/**
 * Verify a plain token against hash
 */
apiTokenSchema.statics.verifyToken = function (plainToken, tokenHash) {
  return hashToken(plainToken) === tokenHash;
};

// ── Instance Methods ──

/**
 * Check if token is valid (not revoked, not expired)
 */
apiTokenSchema.methods.isValid = function () {
  if (this.isRevoked) return false;
  if (this.expiresAt && new Date() > this.expiresAt) return false;
  return true;
};

/**
 * Check if token has required scope
 */
apiTokenSchema.methods.hasScope = function (requiredScope) {
  return this.scope.includes(requiredScope);
};

/**
 * Check if token has access to project
 */
apiTokenSchema.methods.hasProjectAccess = function (projectId) {
  // If no project restrictions, allow all
  if (!this.projectIds || this.projectIds.length === 0) return true;
  return this.projectIds.some((p) => p.toString() === projectId.toString());
};

/**
 * Update last used timestamp
 */
apiTokenSchema.methods.recordUsage = async function (ipAddress) {
  this.lastUsedAt = new Date();
  if (ipAddress) this.lastIpAddress = ipAddress;
  await this.save();
};

/**
 * Safe representation (never show token hash or plain token)
 */
apiTokenSchema.methods.toSafeJSON = function () {
  return {
    id: this._id,
    name: this.name,
    description: this.description,
    lastChars: this.lastChars,
    scope: this.scope,
    expiresAt: this.expiresAt,
    lastUsedAt: this.lastUsedAt,
    createdAt: this.createdAt,
    isRevoked: this.isRevoked,
    revokedAt: this.revokedAt,
  };
};

export const APIToken = mongoose.model("APIToken", apiTokenSchema);
