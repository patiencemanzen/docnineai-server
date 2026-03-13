/**
 * ProjectChangeLog Service
 *
 * Handles logging all project changes and exports for audit trail
 * and user-visible version history.
 */

import ProjectChangeLog from "../models/ProjectChangeLog.js";
import crypto from "crypto";

/**
 * Log a project change
 * @param {string} projectId - Project ID
 * @param {string} userId - User ID
 * @param {string} changeType - Type of change (see ProjectChangeLog schema)
 * @param {object} options - Additional options
 */
export async function logProjectChange(
  projectId,
  userId,
  changeType,
  options = {},
) {
  try {
    const changeLog = new ProjectChangeLog({
      projectId,
      userId,
      changeType,
      section: options.section,
      tabId: options.tabId,
      tabName: options.tabName,
      details: options.details,
      affectedCount: options.affectedCount,
      customTabCount: options.customTabCount,
      exportMetadata: options.exportMetadata,
      contentHash: options.contentHash,
      previousValue: options.previousValue,
      newValuePreview: options.newValuePreview
        ? options.newValuePreview.substring(0, 500)
        : undefined,
    });

    await changeLog.save();
    return changeLog;
  } catch (err) {
    console.error("Error logging project change:", err);
    return null;
  }
}

/**
 * Log an export activity
 * @param {string} projectId - Project ID
 * @param {string} userId - User ID
 * @param {string} exportType - Type of export (pdf, yaml, notion, google_docs)
 * @param {object} exportData - Export data with tab info
 * @param {object} result - Result from export service
 */
export async function logExport(
  projectId,
  userId,
  exportType,
  exportData,
  result = {},
) {
  const changeTypeMap = {
    pdf: "export_pdf",
    yaml: "export_yaml",
    notion: "export_notion",
    google_docs: "export_google_docs",
  };

  try {
    const changeType = changeTypeMap[exportType] || `export_${exportType}`;
    const nativeTabs =
      exportData?.tabs?.filter((t) => !t.isCustom)?.length || 0;
    const customTabs = exportData?.tabs?.filter((t) => t.isCustom)?.length || 0;

    await logProjectChange(projectId, userId, changeType, {
      details: `Exported ${nativeTabs} section${nativeTabs !== 1 ? "s" : ""}${customTabs > 0 ? ` + ${customTabs} custom tab${customTabs !== 1 ? "s" : ""}` : ""}`,
      affectedCount: nativeTabs,
      customTabCount: customTabs,
      exportMetadata: {
        documentUrl: result.documentUrl,
        notionPageUrl: result.mainPageUrl,
        fileName: result.fileName,
        sectionCount: exportData?.totalTabs,
      },
    });
  } catch (err) {
    console.error("Error logging export:", err);
    // Don't throw
  }
}

/**
 * Log a section edit
 * @param {string} projectId - Project ID
 * @param {string} userId - User ID
 * @param {string} section - Section name
 * @param {string} previousContent - Previous content
 * @param {string} newContent - New content
 */
export async function logSectionEdit(
  projectId,
  userId,
  section,
  previousContent = "",
  newContent = "",
) {
  try {
    const contentHash = crypto
      .createHash("sha256")
      .update(newContent)
      .digest("hex");

    await logProjectChange(projectId, userId, "section_edited", {
      section,
      details: `Edited ${section} section`,
      contentHash,
      previousValue: previousContent.substring(0, 100),
      newValuePreview: newContent.substring(0, 500),
    });
  } catch (err) {
    console.error("Error logging section edit:", err);
  }
}

/**
 * Log a section acceptance (AI content)
 * @param {string} projectId - Project ID
 * @param {string} userId - User ID
 * @param {string} section - Section name
 */
export async function logSectionAccept(projectId, userId, section) {
  try {
    await logProjectChange(projectId, userId, "section_accepted", {
      section,
      details: `Accepted AI-generated content for ${section} section`,
    });
  } catch (err) {
    console.error("Error logging section accept:", err);
  }
}

/**
 * Get project change history
 * @param {string} projectId - Project ID
 * @param {number} limit - Max records to return (default: 50)
 * @param {number} skip - Skip N records (for pagination)
 */
export async function getProjectHistory(projectId, limit = 50, skip = 0) {
  try {
    const logs = await ProjectChangeLog.find({ projectId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ProjectChangeLog.countDocuments({ projectId });

    return { logs, total };
  } catch (err) {
    console.error("Error fetching project history:", err);
    return { logs: [], total: 0 };
  }
}

/**
 * Clear old logs (admin/maintenance)
 * @param {Date} beforeDate - Delete logs before this date
 */
export async function clearOldLogs(beforeDate) {
  try {
    const result = await ProjectChangeLog.deleteMany({
      createdAt: { $lt: beforeDate },
    });
    console.log(`Cleared ${result.deletedCount} old change logs`);
    return result.deletedCount;
  } catch (err) {
    console.error("Error clearing old logs:", err);
    return 0;
  }
}
