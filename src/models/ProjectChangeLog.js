import mongoose from "mongoose";

const { Schema, model } = mongoose;

/**
 * ProjectChangeLog
 *
 * Records every significant change to a project for audit/version tracking.
 * Users can view this to understand what has been modified and exported.
 *
 * Change types:
 * - "section_edited": User manually edited a documentation section
 * - "section_accepted": User accepted AI-generated content for a stale section
 * - "export_pdf": PDF export was generated
 * - "export_yaml": YAML/GitHub Actions export was generated
 * - "export_notion": Notion export was pushed
 * - "export_google_docs": Google Docs export was created
 * - "pipeline_started": Documentation generation pipeline started
 * - "pipeline_completed": Documentation generation pipeline finished
 * - "pipeline_failed": Documentation generation pipeline failed
 * - "custom_tab_created": New custom tab was created
 * - "custom_tab_updated": Custom tab content was updated
 * - "custom_tab_deleted": Custom tab was deleted
 */

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
    // For section-related changes
    section: {
      type: String,
      enum: ["readme", "api", "schema", "internal", "security", "other_docs"],
    },
    // For custom tab changes
    tabId: String,
    tabName: String,
    // What changed
    details: {
      type: String, // Short description of what changed
    },
    // How many sections/tabs were affected (for exports)
    affectedCount: Number,
    customTabCount: Number,
    // For exports, store metadata
    exportMetadata: {
      documentUrl: String, // For Google Docs exports
      notionPageUrl: String, // For Notion exports
      fileName: String, // For PDF/YAML exports
      sectionCount: Number,
    },
    // Content hash for diffing/comparison
    contentHash: String,
    // Previous value (for comparison)
    previousValue: String,
    // New value (truncated, first 500 chars for display)
    newValuePreview: String,
    // Timestamp
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { collection: "projectChangeLogs" },
);

/**
 * Compound index for efficient querying:
 * - Get all changes for a project ordered by date
 */
ProjectChangeLogSchema.index({ projectId: 1, createdAt: -1 });

/**
 * TTL index: Keep logs for 1 year (31536000 seconds)
 * Older logs are automatically deleted
 */
ProjectChangeLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 31536000 },
);

export default model("ProjectChangeLog", ProjectChangeLogSchema);
