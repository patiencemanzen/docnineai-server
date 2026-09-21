
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const PlanUsageSchema = new Schema(
  {

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },


    aiChatsUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    aiChatsResetAt: {
      type: Date,
      default: null,
      index: true,
    },


    projectCount: {
      type: Number,
      default: 0,
      min: 0,
    },


    portalCount: {
      type: Number,
      default: 0,
      min: 0,
    },


    activeShareCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);


PlanUsageSchema.statics.increment = async function (userId, delta) {
  const inc = {};
  for (const [key, val] of Object.entries(delta)) {
    inc[key] = val;
  }
  return this.findOneAndUpdate(
    { userId },
    { $inc: inc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

export const PlanUsage = model("PlanUsage", PlanUsageSchema);
