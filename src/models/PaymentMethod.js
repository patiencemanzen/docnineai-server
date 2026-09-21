
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const CardDetailsSchema = new Schema(
  {
    last4: { type: String },
    brand: { type: String },
    expMonth: { type: Number },
    expYear: { type: Number },
  },
  { _id: false },
);

const MobileMoneyDetailsSchema = new Schema(
  {
    phone: { type: String },
    network: { type: String },
    country: { type: String },
  },
  { _id: false },
);

const PaymentMethodSchema = new Schema(
  {

    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },


    type: {
      type: String,
      enum: ["card", "mobile_money", "bank_transfer"],
      required: true,
    },


    card: { type: CardDetailsSchema, default: null },
    mobileMoney: { type: MobileMoneyDetailsSchema, default: null },



    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },


    flutterwaveToken: {
      type: String,
      required: true,
      select: false,
    },


    currency: {
      type: String,
      default: "USD",
      uppercase: true,
    },


    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);


PaymentMethodSchema.virtual("displayLabel").get(function () {
  if (this.type === "card" && this.card) {
    return `${this.card.brand} ****${this.card.last4} (${this.card.expMonth}/${this.card.expYear})`;
  }
  if (this.type === "mobile_money" && this.mobileMoney) {
    return `${this.mobileMoney.network} ${this.mobileMoney.phone}`;
  }
  return "Bank Transfer";
});

PaymentMethodSchema.set("toJSON", { virtuals: true });

export const PaymentMethod = model("PaymentMethod", PaymentMethodSchema);
