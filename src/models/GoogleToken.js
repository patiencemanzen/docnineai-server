
import mongoose from "mongoose";

const googleTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
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
    refreshTokenEncrypted: {
      type: String,
      required: true,
      select: false,
    },

    expiryDate: {
      type: Number,
      required: true,
    },
    scopes: [String],
    googleUserId: String,
    googleEmail: String,
    googleName: String,
    connectedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

export default mongoose.model("GoogleToken", googleTokenSchema);
