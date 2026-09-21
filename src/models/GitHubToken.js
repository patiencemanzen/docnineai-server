import mongoose from "mongoose";

const { Schema, model } = mongoose;

const GitHubTokenSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    accessTokenEncrypted: {
      type: String,
      required: true,
      select: false,
    },

    scopes: {
      type: [String],
      default: [],
    },

    githubUserId: String,
    githubUsername: String,
    githubEmail: String,

    connectedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const GitHubToken = model("GitHubToken", GitHubTokenSchema);
