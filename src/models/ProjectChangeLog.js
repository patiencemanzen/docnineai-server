import mongoose from "mongoose";

const { Schema, model } = mongoose;

const ProjectChangeLogSchema = new Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    changeType: {
      type: String,
      enum: [
        "section_edited",
        "section_accepted",
        "export_pdf",
        "export_yaml",
        "export_notion",
        "export_google_docs",
        "pipeline_started",
        "pipeline_completed",
        "pipeline_failed",
        "custom_tab_created",
        "custom_tab_updated",
        "custom_tab_deleted",
        "status_changed",
      ],
      required: true,
      index: true,
    },

    section: {
      type: String,
      enum: ["readme", "api", "schema", "internal", "security", "other_docs"],
    },

    tabId: String,
    tabName: String,

    details: {
      type: String,
    },

    affectedCount: Number,
    customTabCount: Number,

    exportMetadata: {
      documentUrl: String,
      notionPageUrl: String,
      fileName: String,
      sectionCount: Number,
    },

    contentHash: String,

    previousValue: String,

    newValuePreview: String,

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { collection: "projectChangeLogs" },
);

export default model("ProjectChangeLog", ProjectChangeLogSchema);
