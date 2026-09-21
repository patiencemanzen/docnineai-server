import mongoose from "mongoose";
import { randomUUID } from "crypto";

const ProjectShareSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    inviteeEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    inviteeUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    role: {
      type: String,
      enum: ["viewer", "editor"],
      default: "viewer",
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked"],
      default: "pending",
    },

    token: {
      type: String,
      default: () => randomUUID(),
      index: true,
    },

    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

export const ProjectShare = mongoose.model("ProjectShare", ProjectShareSchema);
