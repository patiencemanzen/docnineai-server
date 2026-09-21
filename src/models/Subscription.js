import mongoose from "mongoose";

const { Schema, model } = mongoose;

const SubscriptionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    plan: {
      type: String,
      enum: ["free", "starter", "pro", "team"],
      default: "free",
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },

    seats: {
      type: Number,
      default: 1,
      min: 1,
    },

    extraSeats: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      enum: ["free", "trialing", "active", "past_due", "cancelled", "paused"],
      default: "free",
      index: true,
    },

    trialEndsAt: {
      type: Date,
      default: null,
    },

    trialUsedAt: {
      type: Date,
      default: null,
    },

    currentPeriodStart: {
      type: Date,
      default: null,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
      index: true,
    },

    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },

    pendingPlan: {
      type: String,
      enum: ["free", "starter", "pro", "team", null],
      default: null,
    },
    pendingBillingCycle: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
    },

    pausedAt: {
      type: Date,
      default: null,
    },
    pauseEndsAt: {
      type: Date,
      default: null,
    },

    dunningAttemptCount: {
      type: Number,
      default: 0,
    },
    dunningStartedAt: {
      type: Date,
      default: null,
      index: true,
    },

    flutterwaveCustomerId: {
      type: String,
      default: null,
      select: false,
    },

    retentionOfferUsed: {
      type: Boolean,
      default: false,
    },
    lastBillingNote: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const Subscription = model("Subscription", SubscriptionSchema);
