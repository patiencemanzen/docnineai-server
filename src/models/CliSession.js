import mongoose from "mongoose";

const { Schema, model } = mongoose;

const CliSessionSchema = new Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "cancelled", "expired"],
      default: "pending",
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    cliToken: {
      type: String,
      default: null,
      select: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
      // MongoDB TTL index: automatically purge sessions after 24 hours
      expires: 60 * 60 * 24,
    },
    userAgent: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
  },
  {
    versionKey: false,
  },
);

export const CliSession = model("CliSession", CliSessionSchema);
