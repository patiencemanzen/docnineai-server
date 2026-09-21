import mongoose from "mongoose";

const { Schema, model } = mongoose;

const SecurityFindingSchema = new Schema(
  {
    id: String,
    severity: { type: String, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
    title: String,
    file: String,
    line: String,
    advice: String,
    source: { type: String, enum: ["static", "llm"] },
  },
  { _id: false },
);

const SecuritySchema = new Schema(
  {
    score: Number,
    grade: String,
    counts: {
      CRITICAL: { type: Number, default: 0 },
      HIGH: { type: Number, default: 0 },
      MEDIUM: { type: Number, default: 0 },
      LOW: { type: Number, default: 0 },
    },
    findings: { type: [SecurityFindingSchema], default: [] },
  },
  { _id: false },
);

const StatsSchema = new Schema(
  {
    filesAnalysed: { type: Number, default: 0 },
    endpoints: { type: Number, default: 0 },
    models: { type: Number, default: 0 },
    relationships: { type: Number, default: 0 },
    components: { type: Number, default: 0 },

    lastSyncedAt: { type: Date, default: null },
    lastSyncDuration: { type: Number, default: null },
  },
  { _id: false },
);

const OutputSchema = new Schema(
  {
    readme: { type: String, default: "" },
    internalDocs: { type: String, default: "" },
    apiReference: { type: String, default: "" },
    schemaDocs: { type: String, default: "" },
    securityReport: { type: String, default: "" },
  },
  { _id: false },
);

const EditedSectionSchema = new Schema(
  {
    section: { type: String, required: true },
    editedAt: { type: Date, required: true },

    stale: { type: Boolean, default: false },
  },
  { _id: false },
);

const FileManifestEntrySchema = new Schema(
  {
    path: { type: String, required: true },
    sha: { type: String, required: true },
    role: { type: String },
  },
  { _id: false },
);

const AgentOutputsSchema = new Schema(
  {
    endpoints: { type: [Schema.Types.Mixed], default: [] },

    models: { type: [Schema.Types.Mixed], default: [] },

    relationships: { type: [Schema.Types.Mixed], default: [] },

    components: { type: [Schema.Types.Mixed], default: [] },

    findings: { type: [Schema.Types.Mixed], default: [] },

    projectMap: { type: [Schema.Types.Mixed], default: [] },
  },
  { _id: false },
);

const ProjectSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    repoUrl: { type: String, required: true, trim: true },
    repoOwner: { type: String, required: true, trim: true },
    repoName: { type: String, required: true, trim: true },

    jobId: {
      type: String,
      unique: true,
      sparse: true,
    },

    status: {
      type: String,
      enum: ["queued", "running", "done", "error", "archived"],
      default: "queued",
      index: true,
    },

    errorMessage: String,

    meta: {
      name: String,
      description: String,
      language: String,
      stars: Number,
      defaultBranch: String,
      isPrivate: Boolean,
      topics: [String],
    },

    techStack: [String],

    stats: { type: StatsSchema, default: () => ({}) },
    security: { type: SecuritySchema, default: () => ({}) },

    output: { type: OutputSchema, default: () => ({}) },

    editedOutput: {
      type: OutputSchema,
      default: () => ({}),
    },

    editedSections: {
      type: [EditedSectionSchema],
      default: [],
    },

    lastDocumentedCommit: { type: String, default: null },

    fileManifest: {
      type: [FileManifestEntrySchema],
      default: [],
      select: false,
    },

    agentOutputs: {
      type: AgentOutputsSchema,
      default: () => ({}),
      select: false,
    },

    chatSessionId: String,

    archivedAt: Date,

    events: {
      type: [Schema.Types.Mixed],
      default: [],
      select: false,
    },
    provider: {
      type: String,
      enum: ["github", "gitlab", "bitbucket", "azure", "zip", "manual"],
      default: "github",
    },

    providerToken: {
      type: String,
      select: false,
    },

    sourceType: {
      type: String,
      enum: ["github", "gitlab", "bitbucket", "azure", "zip", "manual"],
      default: "github",
    },

    zipMetadata: {
      type: Schema.Types.Mixed,
      default: () => ({}),
      select: false,
    },

    customTabs: {
      type: [
        {
          _id: { type: Schema.Types.ObjectId, auto: true },
          name: { type: String, required: true },
          description: { type: String, default: "" },
          content: { type: String, default: "" },
          order: { type: Number, required: true },
          isNative: { type: Boolean, default: false },
          createdAt: { type: Date, default: Date.now },
          updatedAt: { type: Date, default: Date.now },
          createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        },
      ],
      default: [],
    },

    editedCustomTabs: {
      type: [
        {
          tabId: { type: Schema.Types.ObjectId, required: true },
          editedAt: { type: Date, required: true },
          stale: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

ProjectSchema.index({ repoOwner: 1, repoName: 1 }, { name: "project_repo_lookup" });

ProjectSchema.index(
  { repoName: "text", repoOwner: "text", "meta.description": "text" },
  { name: "project_search", language_override: "search_language" },
);

ProjectSchema.virtual("effectiveOutput").get(function () {
  const sections = ["readme", "internalDocs", "apiReference", "schemaDocs", "securityReport"];
  const merged = {};
  for (const s of sections) {
    merged[s] = this.editedOutput?.[s] || this.output?.[s] || "";
  }
  return merged;
});

export const Project = model("Project", ProjectSchema);
