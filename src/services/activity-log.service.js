import ActivityLog, {
  ACTIVITY_ACTIONS,
  CATEGORY_MAP,
  SEVERITY_MAP,
} from "../models/ActivityLog.js";
import { User } from "../models/User.js";
import { Project } from "../models/Project.js";
import { formatActivitySummary, SESSION_NOISE_ACTIONS } from "./activity-copy.js";

const ACTION_SET = new Set(Object.values(ACTIVITY_ACTIONS));
const NOISE_SET = new Set(SESSION_NOISE_ACTIONS);

async function _write(opts) {
  try {
    const {
      userId,
      action,
      projectId,
      resourceId = "",
      resourceType = "",
      metadata = {},
      req,
      ipAddress: ip,
      userAgent: ua,
    } = opts;

    if (!userId || !action) return;
    if (NOISE_SET.has(action)) return;
    if (!ACTION_SET.has(action)) {
      console.warn(`[ActivityLog] Unknown action skipped: ${action}`);
      return;
    }

    let actorName = opts.actorName || "";
    let actorEmail = opts.actorEmail || "";
    if (!actorName || !actorEmail) {
      const user = await User.findById(userId).select("name email").lean();
      actorName = actorName || user?.name || "";
      actorEmail = actorEmail || user?.email || "";
    }

    let projectName = opts.projectName || "";
    if (projectId && !projectName) {
      const project = await Project.findById(projectId)
        .select("repoOwner repoName meta.name")
        .lean();
      if (project) {
        projectName =
          project.meta?.name ||
          [project.repoOwner, project.repoName].filter(Boolean).join("/") ||
          "";
      }
    }

    const category = CATEGORY_MAP[action] ?? "system";
    const severity = SEVERITY_MAP[action] ?? "info";

    const ipAddress = ip ?? (req ? _extractIp(req) : "");
    const userAgent = ua ?? (req ? (req.headers?.["user-agent"] ?? "") : "");

    const summary = formatActivitySummary({
      action,
      actorName,
      actorEmail,
      projectName,
      metadata,
    });

    await ActivityLog.create({
      userId,
      actorName,
      actorEmail,
      action,
      category,
      severity,
      projectId: projectId || undefined,
      projectName,
      resourceId: resourceId || "",
      resourceType: resourceType || "",
      metadata,
      summary,
      ipAddress,
      userAgent,
    });
  } catch (err) {
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
  return req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "";
}

const _agentBuffer = new Map();

export function log(opts) {
  setImmediate(() => _write(opts));
}

export function bufferAgentEvent(jobId, entry) {
  if (!jobId || !entry?.action) return;

  const action = entry.action;
  const category = CATEGORY_MAP[action] ?? "pipeline";
  const severity = SEVERITY_MAP[action] ?? "info";

  const doc = {
    userId: entry.userId,
    actorName: entry.actorName ?? "",
    actorEmail: entry.actorEmail ?? "",
    action,
    category,
    severity,
    projectId: entry.projectId || undefined,
    projectName: entry.projectName ?? "",
    resourceId: entry.resourceId ?? "",
    resourceType: entry.resourceType ?? "",
    metadata: entry.metadata ?? {},
    ipAddress: "",
    userAgent: "",
    createdAt: new Date(),
  };

  if (!_agentBuffer.has(jobId)) _agentBuffer.set(jobId, []);
  _agentBuffer.get(jobId).push(doc);
}

export function flushAgentBatch(jobId) {
  const entries = _agentBuffer.get(jobId);
  _agentBuffer.delete(jobId);
  if (entries?.length) {
    setImmediate(() => _writeBatch(entries));
  }
}

const ActivityLogService = { log, bufferAgentEvent, flushAgentBatch };
export default ActivityLogService;
