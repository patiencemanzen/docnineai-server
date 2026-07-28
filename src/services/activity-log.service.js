/**
 * ActivityLogService
 *
 * All writes are fire-and-forget via setImmediate : callers never await this
 * service, so a failure here never blocks a request or crashes a pipeline.
 *
 * Pipeline agent events are batched in-memory per jobId, then flushed as a
 * single insertMany() call when the pipeline finishes.
 */

import ActivityLog, {
  ACTIVITY_ACTIONS,
  CATEGORY_MAP,
  SEVERITY_MAP,
} from "../models/ActivityLog.js";

const ACTION_SET = new Set(Object.values(ACTIVITY_ACTIONS));

// ---------------------------------------------------------------------------
// Internal write helpers
// ---------------------------------------------------------------------------

async function _write(opts) {
  try {
    const {
      userId,
      actorName = "",
      actorEmail = "",
      action,
      projectId,
      projectName = "",
      resourceId = "",
      resourceType = "",
      metadata = {},
      req,         // optional Express request for ip/ua extraction
      ipAddress: ip,
      userAgent: ua,
    } = opts;

    if (!userId || !action) return;
    if (!ACTION_SET.has(action)) {
      console.warn(`[ActivityLog] Unknown action skipped: ${action}`);
      return;
    }

    const category = CATEGORY_MAP[action] ?? "system";
    const severity  = SEVERITY_MAP[action]  ?? "info";

    const ipAddress = ip ?? (req ? _extractIp(req) : "");
    const userAgent = ua ?? (req ? (req.headers?.["user-agent"] ?? "") : "");

    await ActivityLog.create({
      userId,
      actorName,
      actorEmail,
      action,
      category,
      severity,
      projectId:    projectId  || undefined,
      projectName:  projectName || "",
      resourceId:   resourceId  || "",
      resourceType: resourceType || "",
      metadata,
      ipAddress,
      userAgent,
    });
  } catch (err) {
    // Never propagate : logging must never disrupt business logic
    console.error("[ActivityLog] write error:", err?.message ?? err);
  }
}

async function _writeBatch(entries) {
  if (!entries?.length) return;
  try {
    await ActivityLog.insertMany(entries, { ordered: false });
  } catch (err) {
    console.error("[ActivityLog] batch write error:", err?.message ?? err);
  }
}

function _extractIp(req) {
  return (
    req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    ""
  );
}

// ---------------------------------------------------------------------------
// Agent-event batch buffer  (keyed by jobId)
// ---------------------------------------------------------------------------

const _agentBuffer = new Map(); // jobId → Array<ActivityLog doc>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log a single activity event. Always fire-and-forget.
 *
 * @param {object} opts
 * @param {string|ObjectId} opts.userId
 * @param {string} [opts.actorName]
 * @param {string} [opts.actorEmail]
 * @param {string} opts.action         - one of ACTIVITY_ACTIONS
 * @param {string|ObjectId} [opts.projectId]
 * @param {string} [opts.projectName]
 * @param {string} [opts.resourceId]
 * @param {string} [opts.resourceType]
 * @param {object} [opts.metadata]
 * @param {import('express').Request} [opts.req]
 * @param {string} [opts.ipAddress]    - override ip extraction
 * @param {string} [opts.userAgent]    - override ua extraction
 */
export function log(opts) {
  setImmediate(() => _write(opts));
}

/**
 * Buffer an agent-level event for batch insertion when the pipeline ends.
 * This avoids N individual DB writes during a pipeline run.
 *
 * @param {string} jobId
 * @param {object} entry  - same shape as log() opts, minus req (no request context available mid-pipeline)
 */
export function bufferAgentEvent(jobId, entry) {
  if (!jobId || !entry?.action) return;

  const action   = entry.action;
  const category = CATEGORY_MAP[action] ?? "pipeline";
  const severity  = SEVERITY_MAP[action]  ?? "info";

  const doc = {
    userId:       entry.userId,
    actorName:    entry.actorName  ?? "",
    actorEmail:   entry.actorEmail ?? "",
    action,
    category,
    severity,
    projectId:    entry.projectId    || undefined,
    projectName:  entry.projectName  ?? "",
    resourceId:   entry.resourceId   ?? "",
    resourceType: entry.resourceType ?? "",
    metadata:     entry.metadata     ?? {},
    ipAddress:    "",
    userAgent:    "",
    createdAt:    new Date(),
  };

  if (!_agentBuffer.has(jobId)) _agentBuffer.set(jobId, []);
  _agentBuffer.get(jobId).push(doc);
}

/**
 * Flush all buffered agent events for a jobId as a single insertMany.
 * Clears the buffer regardless of outcome.
 *
 * @param {string} jobId
 */
export function flushAgentBatch(jobId) {
  const entries = _agentBuffer.get(jobId);
  _agentBuffer.delete(jobId);
  if (entries?.length) {
    setImmediate(() => _writeBatch(entries));
  }
}

const ActivityLogService = { log, bufferAgentEvent, flushAgentBatch };
export default ActivityLogService;
