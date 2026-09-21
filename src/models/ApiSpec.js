
import mongoose from "mongoose";

const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;


const ParameterSchema = new Schema(
  {
    in: { type: String },
    name: { type: String },
    required: { type: Boolean, default: false },
    description: { type: String },
    schema: { type: Mixed },
    example: { type: Mixed },
  },
  { _id: false },
);


const EndpointSchema = new Schema(
  {
    id: { type: String },
    method: { type: String },
    path: { type: String },
    summary: { type: String },
    description: { type: String },
    tags: [String],
    operationId: { type: String },
    parameters: [ParameterSchema],
    requestBody: { type: Mixed },
    responses: { type: Mixed },
    security: { type: Mixed },
    deprecated: { type: Boolean, default: false },
    customNote: { type: String },
  },
  { _id: false },
);


const ApiSpecSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      unique: true,
      index: true,
    },


    source: { type: String, enum: ["file", "url", "raw"], required: true },
    sourceUrl: { type: String },


    specVersion: {
      type: String,
      enum: ["2.0", "3.0", "3.1", "postman", "unknown"],
      default: "unknown",
    },


    rawContent: { type: String, select: false },


    info: {
      title: { type: String },
      version: { type: String },
      description: { type: String },
      contact: { type: Mixed },
      license: { type: Mixed },
      termsOfService: { type: String },
    },


    servers: [
      {
        url: { type: String },
        description: { type: String },
        _id: false,
      },
    ],


    tags: [
      {
        name: { type: String },
        description: { type: String },
        _id: false,
      },
    ],


    endpoints: [EndpointSchema],


    schemas: { type: Mixed, default: {} },


    securitySchemes: { type: Mixed, default: {} },


    autoSync: { type: Boolean, default: false },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true },
);

export const ApiSpec = model("ApiSpec", ApiSpecSchema);
