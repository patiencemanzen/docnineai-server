
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { Schema, model } = mongoose;

const UserSchema = new Schema(
  {

    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [80, "Name must be 80 characters or fewer"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email format"],
    },

    password: {
      type: String,
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },


    provider: {
      type: String,
      enum: ["email", "github", "google"],
      default: "email",
    },


    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },


    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },


    refreshTokenHash: {
      type: String,
      select: false,
    },


    githubId: {
      type: String,
      sparse: true,
      unique: true,
    },
    githubUsername: {
      type: String,
      trim: true,
    },


    gitlabId: {
      type: String,
      sparse: true,
      unique: true,
    },
    gitlabUsername: {
      type: String,
      trim: true,
    },
    gitlabTokenEncrypted: {
      type: String,
      select: false,
    },
    gitlabRefreshTokenEncrypted: {
      type: String,
      select: false,
    },
    gitlabConnectedAt: Date,


    bitbucketId: {
      type: String,
      sparse: true,
      unique: true,
    },
    bitbucketUsername: {
      type: String,
      trim: true,
    },
    bitbucketTokenEncrypted: {
      type: String,
      select: false,
    },
    bitbucketRefreshTokenEncrypted: {
      type: String,
      select: false,
    },
    bitbucketConnectedAt: Date,


    azureDevOpsId: {
      type: String,
      sparse: true,
      unique: true,
    },
    azureDevOpsUsername: {
      type: String,
      trim: true,
    },
    azureDevOpsTokenEncrypted: {
      type: String,
      select: false,
    },
    azureDevOpsRefreshTokenEncrypted: {
      type: String,
      select: false,
    },
    azureDevOpsConnectedAt: Date,


    googleId: {
      type: String,
      sparse: true,
      unique: true,
    },
    googleUsername: {
      type: String,
      trim: true,
    },


    webhookSecret: {
      type: String,
      select: false,
    },
    webhookEnabled: {
      type: Boolean,
      default: true,
    },
    lastWebhookAt: Date,
    lastWebhookStatus: {
      type: String,
      enum: ["success", "failed", "skipped"],
      default: null,
    },


    role: {
      type: String,
      enum: ["user", "super-admin"],
      default: "user",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);


UserSchema.pre("validate", function (next) {
  if (this.provider === "email" && this.isNew && !this.password) {
    this.invalidate("password", "Password is required for email sign-up");
  }
  next();
});


UserSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});


UserSchema.methods.comparePassword = async function (candidate) {
  if (!this.password) {

    throw new Error("PASSWORD_LOGIN_NOT_AVAILABLE");
  }
  return bcrypt.compare(candidate, this.password);
};


UserSchema.set("toJSON", {
  transform(doc, ret) {
    delete ret.password;
    delete ret.refreshTokenHash;
    delete ret.emailVerificationToken;
    delete ret.emailVerificationExpires;
    delete ret.passwordResetToken;
    delete ret.passwordResetExpires;
    delete ret.webhookSecret;
    return ret;
  },
});

export const User = model("User", UserSchema);
