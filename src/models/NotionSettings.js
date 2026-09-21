import mongoose from "mongoose";

const { Schema, model } = mongoose;

const NotionSettingsSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    apiKeyEncrypted: {
      type: String,
      required: true,
      select: false,
    },

    parentPageId: {
      type: String,
      required: true,
    },

    workspaceName: {
      type: String,
      default: null,
    },

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

export const NotionSettings = model("NotionSettings", NotionSettingsSchema);
