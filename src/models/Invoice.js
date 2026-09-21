
import mongoose from "mongoose";

const { Schema, model } = mongoose;

let _invoiceCounter = null;

const InvoiceLineSchema = new Schema(
  {
    description: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

const InvoiceSchema = new Schema(
  {

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },


    invoiceNumber: {
      type: String,
      unique: true,
    },


    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "USD",
      uppercase: true,
    },


    lineItems: {
      type: [InvoiceLineSchema],
      default: [],
    },


    status: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded", "void"],
      default: "pending",
      index: true,
    },


    description: {
      type: String,
      required: true,
    },


    paymentMethodSnapshot: {
      type: String,
      default: null,
    },


    flutterwaveRef: { type: String, default: null },
    flutterwaveTxId: { type: Number, default: null },


    planId: { type: String, default: null },
    billingCycle: { type: String, default: null },
    seats: { type: Number, default: 1 },
    seatDelta: { type: Number, default: 0 },

    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },


    customerName: { type: String, default: null },
    customerEmail: { type: String, default: null },

    vatNumber: { type: String, default: null },
    companyName: { type: String, default: null },


    type: {
      type: String,
      enum: ["checkout", "renewal", "upgrade", "downgrade", "team_seat_adjustment", "seat_addition", "refund"],
      default: "checkout",
    },

    prorationType: {
      type: String,
      enum: ["mid_cycle_team_seat", "daily_seat_change", "plan_upgrade", "plan_downgrade", null],
      default: null,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);


InvoiceSchema.pre("save", async function (next) {
  if (this.invoiceNumber) return next();
  
  const now = new Date();
  const prefix = `INV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-DOC9`;
  

  const count = await mongoose.model("Invoice").countDocuments({
    invoiceNumber: new RegExp(`^${prefix}-`),
  });

  this.invoiceNumber = `${prefix}-${String(count + 1).padStart(4, "0")}`;

  next();
});

export const Invoice = model("Invoice", InvoiceSchema);
