

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

    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    lastChars: {
      type: String,
      required: true,
    },

    scope: {
      type: [String],
      enum: ["mcp", "cli", "api"],
      default: ["api"],
    },

    projectIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Project",
      },
    ],

    expiresAt: {
      type: Date,
      default: null,
    },

    lastUsedAt: {
      type: Date,
      default: null,
    },

    ipWhitelist: [String],

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


apiTokenSchema.index({ userId: 1, isRevoked: 1 });
apiTokenSchema.index({ expiresAt: 1 }, { sparse: true });




apiTokenSchema.statics.generateToken = function () {
  const prefix = "docnine_";
  const randomPart = randomBytes(24).toString("hex");
  const plainToken = `${prefix}${randomPart}`;
  const tokenHash = hashToken(plainToken);
  const lastChars = plainToken.slice(-6);

  return { plainToken, tokenHash, lastChars };
};


apiTokenSchema.statics.verifyToken = function (plainToken, tokenHash) {
  return hashToken(plainToken) === tokenHash;
};




apiTokenSchema.methods.isValid = function () {
  if (this.isRevoked) return false;
  if (this.expiresAt && new Date() > this.expiresAt) return false;
  return true;
};


apiTokenSchema.methods.hasScope = function (requiredScope) {
  return this.scope.includes(requiredScope);
};


apiTokenSchema.methods.hasProjectAccess = function (projectId) {

  if (!this.projectIds || this.projectIds.length === 0) return true;
  return this.projectIds.some((p) => p.toString() === projectId.toString());
};


apiTokenSchema.methods.recordUsage = async function (ipAddress) {
  this.lastUsedAt = new Date();
  if (ipAddress) this.lastIpAddress = ipAddress;
  await this.save();
};


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
