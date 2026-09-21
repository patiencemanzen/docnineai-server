
import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const SECTIONS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "securityReport",
];
export const MAX_VERSIONS_PER_SECTION = 20;

const DocumentVersionSchema = new Schema(
  {

    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },


    section: {
      type: String,
      enum: SECTIONS,
      required: true,
    },


    content: {
      type: String,
      required: true,
    },


    source: {
      type: String,
      enum: ["ai_full", "ai_incremental", "user"],
      required: true,
    },


    meta: {

      commitSha: String,

      changedFiles: [String],

      agentsRun: [String],

      changeSummary: String,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);


DocumentVersionSchema.statics.createVersion = async function ({
  projectId,
  section,
  content,
  source,
  meta = {},
}) {
  await this.create({ projectId, section, content, source, meta });


  const versions = await this.find({ projectId, section })
    .sort({ createdAt: -1 })
    .select("_id")
    .lean();

  if (versions.length > MAX_VERSIONS_PER_SECTION) {
    const toDelete = versions.slice(MAX_VERSIONS_PER_SECTION).map((v) => v._id);
    await this.deleteMany({ _id: { $in: toDelete } });
  }
};

export const DocumentVersion = model("DocumentVersion", DocumentVersionSchema);
