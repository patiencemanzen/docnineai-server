// =============================================================
// Thin HTTP layer.
// =============================================================

import * as projectService from "../../services/projects/project.service.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";
import { jobs, streams, hydrateJobFromRedis, hydrateJobFromDb } from "../../../services/job-registry.service.js";
import { SECTIONS } from "../../../models/DocumentVersion.js";
import { PlanUsage } from "../../../models/PlanUsage.js";

// ── Lazy export services ──────────────────────────────────────
let _exportToPDF = null;
let _exportToNotion = null;
let _exportToGoogleDocs = null;
let _getGoogleDocsOAuthUrl = null;
let _getGoogleDocsConnectionStatus = null;
let _disconnectGoogleDocs = null;
let _genWorkflow = null;

// ── Domain error handler ──────────────────────────────────────
const DOMAIN_CODES = new Set([
  "INVALID_REPO_URL",
  "DUPLICATE_PROJECT",
  "PROJECT_NOT_FOUND",
  "PROJECT_RUNNING",
  "PROJECT_ARCHIVED",
  "PROJECT_NOT_READY",
  "INVALID_SECTION",
  "VERSION_NOT_FOUND",
]);

function handleErr(res, err, ctx) {
  if (DOMAIN_CODES.has(err.code))
    return fail(res, err.code, err.message, err.status || 400);
  return serverError(res, err, ctx);
}

async function getExportToPDF() {
  if (_exportToPDF) return _exportToPDF;

  try {
    const m = await import("../../../services/export.service.js");
    _exportToPDF = m.exportToPDF;
  } catch (e) {
    console.error("Failed to load exportToPDF:", e);
  }

  return _exportToPDF;
}

async function getExportToNotion() {
  if (_exportToNotion) return _exportToNotion;

  try {
    const m = await import("../../../services/export.service.js");
    _exportToNotion = m.exportToNotion;
  } catch (e) {
    console.error("Failed to load exportToNotion:", e);
  }

  return _exportToNotion;
}

async function getGoogleDocsExport() {
  if (_exportToGoogleDocs) return _exportToGoogleDocs;
  try {
    const m = await import("../../../services/googleDocs.service.js");
    _exportToGoogleDocs = m.exportToGoogleDocs;
    _getGoogleDocsOAuthUrl = m.getGoogleDocsOAuthUrl;
    _getGoogleDocsConnectionStatus = m.getGoogleDocsConnectionStatus;
    _disconnectGoogleDocs = m.disconnectGoogleDocs;
  } catch (e) {
    console.error("Failed to load googleDocs.service:", e);
  }
  return _exportToGoogleDocs;
}

async function getGenWorkflow() {
  if (_genWorkflow) return _genWorkflow;

  try {
    const m = await import("../../../services/webhook.service.js");
    _genWorkflow = m.generateGitHubActionsWorkflow;
  } catch (e) {
    console.error("Failed to load generateGitHubActionsWorkflow:", e);
  }

  return _genWorkflow;
}

// ─────────────────────────────────────────────────────────────
// PROJECT CRUD
// ─────────────────────────────────────────────────────────────
export async function createProject(req, res) {
  try {
    const project = await projectService.createProject({
      userId: req.user.userId,
      repoUrl: req.body.repoUrl,
    });
    // checkProjectLimit already reserved the slot atomically : only increment for unlimited plans.
    if (!req._projectSlotReserved) {
      await PlanUsage.increment(req.user.userId, { projectCount: 1 }).catch(() => {});
    }
    return ok(
      res,
      { project, streamUrl: `/projects/${project._id}/stream` },
      "Pipeline started.",
      201,
    );
  } catch (err) {
    // Release the reserved slot so the user isn't unfairly penalised.
    if (req._projectSlotReserved) {
      await PlanUsage.increment(req.user.userId, { projectCount: -1 }).catch(() => {});
    }
    return handleErr(res, err, "createProject");
  }
}

export async function createFromScratchProject(req, res) {
  try {
    const project = await projectService.createFromScratchProject({
      userId: req.user.userId,
      projectName: req.body.projectName,
    });
    // checkProjectLimit already reserved the slot atomically : only increment for unlimited plans.
    if (!req._projectSlotReserved) {
      await PlanUsage.increment(req.user.userId, { projectCount: 1 }).catch(() => {});
    }
    return ok(res, { project }, "From-scratch project created.", 201);
  } catch (err) {
    // Release the reserved slot so the user isn't unfairly penalised.
    if (req._projectSlotReserved) {
      await PlanUsage.increment(req.user.userId, { projectCount: -1 }).catch(() => {});
    }
    return handleErr(res, err, "createFromScratchProject");
  }
}

export async function listProjects(req, res) {
  const { page = "1", limit = "20", status, sort, search } = req.query;
  try {
    const result = await projectService.listProjects({
      userId: req.user.userId,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      status,
      sort,
      search,
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err, "listProjects");
  }
}

export async function getProject(req, res) {
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    // Return the effectiveOutput (merges user edits on top of AI output)
    return ok(res, {
      project,
      effectiveOutput: project.effectiveOutput,
      editedSections: project.editedSections,
      lastSyncedCommit: project.lastDocumentedCommit,
      shareRole: project._shareRole ?? "owner", // "owner" | "editor" | "viewer"
    });
  } catch (err) {
    return handleErr(res, err, "getProject");
  }
}

export async function deleteProject(req, res) {
  try {
    await projectService.deleteProject({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    // Decrement usage counter
    await PlanUsage.increment(req.user.userId, { projectCount: -1 }).catch(
      () => {},
    );
    return ok(res, null, "Project deleted.");
  } catch (err) {
    return handleErr(res, err, "deleteProject");
  }
}

export async function updateProject(req, res) {
  try {
    const project = await projectService.updateProject({
      projectId: req.params.id,
      userId: req.user.userId,
      updates: req.body,
    });
    return ok(res, { project }, "Project updated.");
  } catch (err) {
    return handleErr(res, err, "updateProject");
  }
}

export async function retryProject(req, res) {
  try {
    const project = await projectService.retryProject({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(
      res,
      { project, streamUrl: `/projects/${project._id}/stream` },
      "Pipeline restarted.",
      202,
    );
  } catch (err) {
    return handleErr(res, err, "retryProject");
  }
}

// ─────────────────────────────────────────────────────────────
// INCREMENTAL SYNC
// ─────────────────────────────────────────────────────────────
/**
 * Check for new commits and re-document only what changed.
 * Uses forceFullRun=true query param to bypass incremental logic.
 */
export async function syncProject(req, res) {
  const forceFullRun = req.query.force === "true";
  try {
    const result = await projectService.syncProject({
      projectId: req.params.id,
      userId: req.user.userId,
      forceFullRun,
    });
    return ok(
      res,
      { project: result.project, streamUrl: result.streamUrl },
      forceFullRun ? "Full re-run started." : "Incremental sync started.",
      202,
    );
  } catch (err) {
    return handleErr(res, err, "syncProject");
  }
}

// ─────────────────────────────────────────────────────────────
// SSE STREAM
// ─────────────────────────────────────────────────────────────
/**
 * Returns the persisted pipeline event log for a project.
 * Events are stored per-project in MongoDB (last 200, select:false).
 */
export async function getProjectEvents(req, res) {
  try {
    const result = await projectService.getProjectEvents({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(res, result);
  } catch (err) {
    return handleErr(res, err, "getProjectEvents");
  }
}

export async function streamProject(req, res) {
  const projectId = req.params.id;

  let project;
  try {
    project = await projectService.getProjectById({
      projectId,
      userId: req.user.userId,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      error: { code: err.code || "INTERNAL_ERROR", message: err.message },
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // ── Wait for job to be registered (up to 5 seconds) ────────
  // This handles serverless environments where webhook and stream
  // might run on different instances, or there's a slight delay in
  // job registration between instances.

  const jobId = project.jobId;
  let job = jobs.get(jobId);

  if (!job && project.status === "running") {
    let waited = 0;
    while (!job && waited < 5000) {
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
      job = jobs.get(jobId);
    }
  }

  /**
   * Job not in memory. Resolution order:
   * 1. done/error project   → serve synthetic result from DB and close.
   * 2. Redis hit            → hydrate from Redis (events + status).
   * 3. MongoDB events       → fallback hydration from Project.events.
   * 4. Nothing              → pipeline is dead, send error/retry message.
   *
   * After hydration the code falls through to the normal streaming path.
   */
  if (!job) {
    if (project.status === "done" || project.status === "error") {
      const syntheticResult = {
        success: project.status === "done",
        output: project.effectiveOutput,
        stats: project.stats,
        security: project.security,
        techStack: project.techStack,
        meta: project.meta,
        chat: project.chatSessionId ? { sessionId: project.chatSessionId } : null,
        error: project.errorMessage || null,
      };
      res.write(`data: ${JSON.stringify({ step: "done", result: syntheticResult })}\n\n`);
      return res.end();
    }

    // Project is "running" : try Redis first, then MongoDB events fallback.
    job = await hydrateJobFromRedis(jobId);

    if (!job && project.events?.length) {
      job = hydrateJobFromDb(jobId, project.events);
    }

    if (!job) {
      // No events anywhere : pipeline is dead (server restart / Vercel kill).
      const isLikelyVercelTimeout = project.meta?.vercelTimedOut === true;
      const message = isLikelyVercelTimeout
        ? "Pipeline was interrupted by Vercel's 60s HTTP timeout. It may still be running in the background. Please retry."
        : "Pipeline was interrupted (server restart). Please retry this project.";

      res.write(
        `data: ${JSON.stringify({
          step: "error",
          status: "error",
          msg: message,
          vercelTimeout: isLikelyVercelTimeout,
          retryUrl: `/projects/${project._id}/retry`,
        })}\n\n`,
      );
      return res.end();
    }
    // Fall through to the normal streaming path below.
  }

  // ── Job exists and is running ──────────────────────────────
  // Stream all buffered events first (for late-connecting clients)
  for (const e of job.events) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  // If job is already done, close immediately
  if (job.status !== "running") {
    res.write(
      `data: ${JSON.stringify({ step: "done", result: job.result })}\n\n`,
    );
    return res.end();
  }

  // Register this client for future events
  const clients = streams.get(jobId) || new Set();
  clients.add(res);
  streams.set(jobId, clients);

  // Heartbeat to keep connection alive (25s interval)
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      /* gone */
    }
  }, 25_000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    const s = streams.get(jobId);
    if (s) s.delete(res);
  });
}

// ─────────────────────────────────────────────────────────────
// DOCUMENT EDITING
// ─────────────────────────────────────────────────────────────
/**
 * Save a user edit for one documentation section.
 */
export async function editDocSection(req, res) {
  const { section } = req.params;
  const { content } = req.body;
  if (typeof content !== "string" || content.trim().length === 0)
    return fail(
      res,
      "VALIDATION_ERROR",
      "content must be a non-empty string.",
      422,
    );
  try {
    const project = await projectService.editDocSection({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
      content: content.trim(),
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      `Section "${section}" saved.`,
    );
  } catch (err) {
    return handleErr(res, err, "editDocSection");
  }
}

/**
 * Revert to AI-generated content (clear the user edit).
 */
export async function revertDocSection(req, res) {
  const { section } = req.params;
  try {
    const project = await projectService.revertDocSection({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      `Section "${section}" reverted to AI version.`,
    );
  } catch (err) {
    return handleErr(res, err, "revertDocSection");
  }
}

/**
 * User accepts the new AI-generated content for a stale section.
 * Equivalent to revert but semantically clearer when invoked after a sync.
 */
export async function acceptAISection(req, res) {
  const { section } = req.params;
  try {
    const project = await projectService.acceptAISection({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      `Accepted new AI content for "${section}".`,
    );
  } catch (err) {
    return handleErr(res, err, "acceptAISection");
  }
}

// ─────────────────────────────────────────────────────────────
// VERSION HISTORY
// ─────────────────────────────────────────────────────────────
export async function listVersions(req, res) {
  const { section } = req.params;
  const { page = "1", limit = "20" } = req.query;
  try {
    const result = await projectService.listVersions({
      projectId: req.params.id,
      userId: req.user.userId,
      section,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    return ok(res, result);
  } catch (err) {
    return handleErr(res, err, "listVersions");
  }
}

export async function getVersion(req, res) {
  try {
    const version = await projectService.getVersion({
      projectId: req.params.id,
      userId: req.user.userId,
      versionId: req.params.versionId,
    });
    return ok(res, { version });
  } catch (err) {
    return handleErr(res, err, "getVersion");
  }
}

export async function restoreVersion(req, res) {
  try {
    const project = await projectService.restoreVersion({
      projectId: req.params.id,
      userId: req.user.userId,
      versionId: req.params.versionId,
    });
    return ok(
      res,
      {
        project,
        effectiveOutput: project.effectiveOutput,
        editedSections: project.editedSections,
      },
      "Version restored.",
    );
  } catch (err) {
    return handleErr(res, err, "restoreVersion");
  }
}

// ─────────────────────────────────────────────────────────────
// CHANGE LOG / ACTIVITY HISTORY
// ─────────────────────────────────────────────────────────────

/**
 * Returns the change log for a project (all user-facing edits, exports, etc)
 * Users can see what was changed and when.
 */
export async function getProjectChangeLog(req, res) {
  const { page = "1", limit = "50" } = req.query;
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });

    // User has access to the project
    const { getProjectHistory } =
      await import("../../../services/changelog.service.js");
    const result = await getProjectHistory(
      req.params.id,
      parseInt(limit, 10),
      (parseInt(page, 10) - 1) * parseInt(limit, 10),
    );

    return ok(res, result, "Project change log retrieved.");
  } catch (err) {
    return handleErr(res, err, "getProjectChangeLog");
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────
export async function exportPdf(req, res) {
  const exportToPDF = await getExportToPDF();
  if (!exportToPDF)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "PDF export requires pdfkit. Run: npm install pdfkit",
      503,
    );
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    if (project.status !== "done")
      return fail(res, "PROJECT_NOT_READY", "Pipeline has not completed.", 409);

    // Use frontend-provided data (with cleaned markdown) if available, else use project data
    const exportData = req.body?.tabs ? req.body : null;

    exportToPDF(res, {
      meta: project.meta || {},
      output: exportData?.tabs ? exportData : project.effectiveOutput,
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
      tabs: exportData?.tabs, // pass custom tabs if available
      projectDescription: exportData?.projectDescription,
    });

    // Log the export
    const { logExport } =
      await import("../../../services/changelog.service.js");
    await logExport(
      req.params.id,
      req.user.userId,
      "pdf",
      exportData || { tabs: [] },
    );
  } catch (err) {
    return handleErr(res, err, "exportPdf");
  }
}

export async function exportYaml(req, res) {
  const genWorkflow = await getGenWorkflow();
  if (!genWorkflow)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Workflow generator unavailable.",
      503,
    );
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });

    // Use frontend-provided data if available
    const exportData = req.body?.tabs ? req.body : null;

    const yml = genWorkflow(`${req.protocol}://${req.get("host")}`);
    res.setHeader("Content-Type", "text/yaml");
    res.setHeader("Content-Disposition", "attachment; filename=document.yml");
    res.send(yml);

    // Log the export
    const { logExport } =
      await import("../../../services/changelog.service.js");
    await logExport(
      req.params.id,
      req.user.userId,
      "yaml",
      exportData || { tabs: [] },
    );
  } catch (err) {
    return handleErr(res, err, "exportYaml");
  }
}

export async function exportNotion(req, res) {
  const exportToNotion = await getExportToNotion();

  if (!exportToNotion)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Notion export requires @notionhq/client.",
      503,
    );
  try {
    // Fetch this user's Notion credentials (throws NOTION_NOT_CONNECTED if absent)
    const { getDecryptedNotionSettings } =
      await import("../../../services/notion.service.js");
    let notionCreds;
    try {
      notionCreds = await getDecryptedNotionSettings(req.user.userId);
    } catch (credErr) {
      if (credErr.message === "NOTION_NOT_CONNECTED") {
        return fail(
          res,
          "NOTION_NOT_CONNECTED",
          "Connect your Notion account first via Settings → Export connections.",
          403,
        );
      }
      throw credErr;
    }

    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    if (project.status !== "done")
      return fail(res, "PROJECT_NOT_READY", "Pipeline has not completed.", 409);

    // Use frontend-provided data (with cleaned markdown) if available
    const exportData = req.body?.tabs ? req.body : null;

    const result = await exportToNotion({
      meta: project.meta || {},
      output: exportData?.tabs ? exportData : project.effectiveOutput,
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
      apiKey: notionCreds.apiKey,
      parentPageId: notionCreds.parentPageId,
      tabs: exportData?.tabs, // pass custom tabs if available
    });

    // Log the export
    const { logExport } =
      await import("../../../services/changelog.service.js");
    await logExport(
      req.params.id,
      req.user.userId,
      "notion",
      exportData || { tabs: [] },
      result,
    );

    return ok(res, result, "Documentation pushed to Notion.");
  } catch (err) {
    return handleErr(res, err, "exportNotion");
  }
}

// ─────────────────────────────────────────────────────────────
// Google Docs
// ─────────────────────────────────────────────────────────────
export async function googleDocsConnect(req, res) {
  await getGoogleDocsExport(); // load module to populate _getGoogleDocsOAuthUrl

  if (!_getGoogleDocsOAuthUrl)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Google Docs service unavailable.",
      503,
    );
  try {
    await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    const url = _getGoogleDocsOAuthUrl(req.user.userId);
    return ok(res, { url }, "Redirect to Google to grant access.");
  } catch (err) {
    return handleErr(res, err, "googleDocsConnect");
  }
}

export async function googleDocsStatus(req, res) {
  await getGoogleDocsExport();
  if (!_getGoogleDocsConnectionStatus) return ok(res, { connected: false });
  try {
    const status = await _getGoogleDocsConnectionStatus(req.user.userId);
    return ok(res, status);
  } catch (err) {
    return handleErr(res, err, "googleDocsStatus");
  }
}

export async function googleDocsDisconnect(req, res) {
  await getGoogleDocsExport();
  if (!_disconnectGoogleDocs) return ok(res, null, "Not connected.");
  try {
    await _disconnectGoogleDocs(req.user.userId);
    return ok(res, null, "Google Drive disconnected.");
  } catch (err) {
    return handleErr(res, err, "googleDocsDisconnect");
  }
}

export async function exportGoogleDocs(req, res) {
  const exportToGoogleDocs = await getGoogleDocsExport();
  if (!exportToGoogleDocs)
    return fail(
      res,
      "SERVICE_UNAVAILABLE",
      "Google Docs export unavailable.",
      503,
    );
  try {
    const project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    if (project.status !== "done")
      return fail(res, "PROJECT_NOT_READY", "Pipeline has not completed.", 409);

    // Use frontend-provided data (with cleaned markdown) if available
    const exportData = req.body?.tabs ? req.body : null;

    const result = await exportToGoogleDocs({
      meta: project.meta || {},
      output: exportData?.tabs ? exportData : project.effectiveOutput,
      stats: project.stats || {},
      securityScore: project.security?.score ?? null,
      userId: req.user.userId,
      tabs: exportData?.tabs, // pass custom tabs if available
      projectDescription: exportData?.projectDescription,
    });

    // Log the export
    const { logExport } =
      await import("../../../services/changelog.service.js");
    await logExport(
      req.params.id,
      req.user.userId,
      "google_docs",
      exportData || { tabs: [] },
      result,
    );

    return ok(res, result, "Documentation exported to Google Docs.");
  } catch (err) {
    if (err.message === "GOOGLE_NOT_CONNECTED")
      return fail(
        res,
        "GOOGLE_NOT_CONNECTED",
        "Connect your Google account first via Settings → Export Connections.",
        403,
      );
    if (err.message?.includes("GOOGLE_DOCS_CLIENT_ID"))
      return fail(res, "GOOGLE_DOCS_NOT_CONFIGURED", err.message, 503);
    return handleErr(res, err, "exportGoogleDocs");
  }
}

// ─────────────────────────────────────────────────────────────
// CHAT (streaming SSE)
// ─────────────────────────────────────────────────────────────
export async function chatHandler(req, res) {
  const { message } = req.body;
  if (!message?.trim()) {
    return res.status(422).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "message is required" },
    });
  }

  let project;
  try {
    project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
  } catch (err) {
    return handleErr(res, err, "chat");
  }

  if (!project.chatSessionId) {
    return res.status(409).json({
      success: false,
      error: {
        code: "CHAT_SESSION_NOT_FOUND",
        message:
          "No chat session available. Run the documentation pipeline first.",
      },
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const { chatStream, ensureSession } =
    await import("../../../services/chat.service.js");

  // Rebuild the in-memory session from persisted output if the server was
  // restarted since the pipeline last ran (sessions are in-memory only).
  const effectiveOutput = Object.fromEntries(
    [
      "readme",
      "apiReference",
      "schemaDocs",
      "internalDocs",
      "securityReport",
      "otherDocs",
    ].map((k) => [k, project.editedOutput?.[k] || project.output?.[k] || ""]),
  );
  ensureSession({
    jobId: project.chatSessionId,
    output: effectiveOutput,
    meta: project.meta,
  });

  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client gone */
    }
  };

  await chatStream({
    jobId: project.chatSessionId,
    message: message.trim(),
    onToken(token) {
      send({ type: "token", token });
    },
    onDone(result) {
      send({ type: "done", ...result });
      res.end();
    },
    onError(err) {
      send({ type: "error", message: err.message });
      res.end();
    },
  });
}

/**
 * Clears the in-memory conversation history for this project's session.
 */
export async function resetChat(req, res) {
  let project;
  try {
    project = await projectService.getProjectById({
      projectId: req.params.id,
      userId: req.user.userId,
    });
  } catch (err) {
    return handleErr(res, err, "resetChat");
  }

  if (project.chatSessionId) {
    const { resetSession } = await import("../../../services/chat.service.js");
    resetSession(project.chatSessionId);
  }

  return ok(res, null, "Chat history cleared.");
}

// ─────────────────────────────────────────────────────────────
// CUSTOM TABS
// ─────────────────────────────────────────────────────────────
export async function createCustomTab(req, res) {
  const { name, description, content } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return fail(
      res,
      "VALIDATION_ERROR",
      "name is required and must be a string",
      422,
    );
  }

  try {
    const result = await projectService.createCustomTab({
      projectId: req.params.id,
      userId: req.user.userId,
      name,
      description,
      content,
    });
    return ok(res, { project: result }, "Custom tab created.", 201);
  } catch (err) {
    return handleErr(res, err, "createCustomTab");
  }
}

export async function updateCustomTab(req, res) {
  const { tabId } = req.params;
  const { name, description, content } = req.body;

  if (!tabId) {
    return fail(res, "VALIDATION_ERROR", "tabId is required", 400);
  }

  try {
    const result = await projectService.updateCustomTab({
      projectId: req.params.id,
      userId: req.user.userId,
      tabId,
      name,
      description,
      content,
    });
    return ok(res, { project: result }, "Custom tab updated.");
  } catch (err) {
    return handleErr(res, err, "updateCustomTab");
  }
}

export async function deleteCustomTab(req, res) {
  const { tabId } = req.params;

  if (!tabId) {
    return fail(res, "VALIDATION_ERROR", "tabId is required", 400);
  }

  try {
    const result = await projectService.deleteCustomTab({
      projectId: req.params.id,
      userId: req.user.userId,
      tabId,
    });
    return ok(res, { project: result }, "Custom tab deleted.");
  } catch (err) {
    return handleErr(res, err, "deleteCustomTab");
  }
}

export async function listCustomTabs(req, res) {
  try {
    const result = await projectService.listCustomTabs({
      projectId: req.params.id,
      userId: req.user.userId,
    });
    return ok(res, result);
  } catch (err) {
    return handleErr(res, err, "listCustomTabs");
  }
}

export async function reorderCustomTabs(req, res) {
  const { orders } = req.body;

  if (!Array.isArray(orders)) {
    return fail(res, "VALIDATION_ERROR", "orders must be an array", 422);
  }

  try {
    const result = await projectService.reorderCustomTabs({
      projectId: req.params.id,
      userId: req.user.userId,
      orders,
    });
    return ok(res, { project: result }, "Custom tabs reordered.");
  } catch (err) {
    return handleErr(res, err, "reorderCustomTabs");
  }
}
