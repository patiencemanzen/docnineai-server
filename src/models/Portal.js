
import mongoose from "mongoose";
const { Schema, model } = mongoose;



const FooterLinkSchema = new Schema(
  {
    label: { type: String, required: true },
    href: { type: String, required: true },
  },
  { _id: false },
);

const BrandingSchema = new Schema(
  {
    logo: String,
    favicon: String,
    primaryColor: String,
    bgColor: String,
    accentColor: String,
    headerText: String,
    footerText: String,
    footerLinks: { type: [FooterLinkSchema], default: [] },
  },
  { _id: false },
);

const PortalSectionSchema = new Schema(
  {
    sectionKey: {
      type: String,
      required: true,
      enum: [
        "readme",
        "internalDocs",
        "apiReference",
        "schemaDocs",
        "securityReport",
      ],
    },
    visibility: {
      type: String,
      enum: ["public", "internal", "coming_soon"],
      default: "public",
    },
  },
  { _id: false },
);



const PortalSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
      index: true,
    },


    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9][a-z0-9-]*$/,
    },

    isPublished: { type: Boolean, default: false },

    accessMode: {
      type: String,
      enum: ["public", "password"],
      default: "public",
    },


    passwordHash: { type: String, select: false },

    branding: { type: BrandingSchema, default: () => ({}) },

    templateId: {
      type: String,
      enum: [
        "classic",
        "teal-studio",
        "midnight",
        "minimal",
        "company-showcase",
        "developer-terminal",
        "enterprise-handbook",
        "startup-guide",
        "product-manual",
        "agency-portfolio",
      ],
      default: "classic",
    },


    sections: { type: [PortalSectionSchema], default: [] },

    seoTitle: String,
    seoDescription: String,


    customDomain: { type: String, trim: true, lowercase: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const Portal = model("Portal", PortalSchema);
