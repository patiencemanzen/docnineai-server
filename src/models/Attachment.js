import mongoose from "mongoose";

const { Schema, model } = mongoose;

const AttachmentSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    uploaderName: { type: String, default: "Unknown" },

    fileName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },

    description: { type: String, default: "", trim: true },

    data: { type: Buffer, required: true, select: false },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const Attachment = model("Attachment", AttachmentSchema);
