import mongoose from "mongoose";
import ActivityLog from "../../../models/ActivityLog.js";
import { SESSION_NOISE_ACTIONS } from "../../../services/activity-copy.js";
import { getShareRole } from "../../services/projects/share.service.js";
import { ok, fail, wrap } from "../../../utils/response.util.js";

function applyCommonFilters(filter, query) {
  const { category, severity, from, to } = query;
  if (category) filter.category = category;
  if (severity) filter.severity = severity;
  filter.action = { $nin: SESSION_NOISE_ACTIONS };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  return filter;
}

function serializeLogs(logs) {
  return logs.map((log) => ({
    ...log,
    userId: log.userId?.toString?.() ?? log.userId,
    projectId: log.projectId?.toString?.() ?? log.projectId,
  }));
}

// ---------------------------------------------------------------------------
// GET /activity-logs  (account: what this user did)
// ---------------------------------------------------------------------------
export const listActivityLogs = wrap(async (req, res) => {
  const userId = req.user.userId;

  const { projectId, page = "1", limit = "30" } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const skip = (pageNum - 1) * limitNum;

  const filter = { userId: new mongoose.Types.ObjectId(userId) };
  applyCommonFilters(filter, req.query);
  if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
    filter.projectId = new mongoose.Types.ObjectId(projectId);
  }

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .select("-ipAddress -userAgent")
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  return ok(res, {
    logs: serializeLogs(logs),
    total,
    page: pageNum,
    limit: limitNum,
    hasMore: skip + logs.length < total,
  });
});

// ---------------------------------------------------------------------------
// GET /activity-logs/project/:projectId  (anyone with project access)
// ---------------------------------------------------------------------------
export const listProjectActivityLogs = wrap(async (req, res) => {
  const userId = req.user.userId;
  const { projectId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return fail(res, "INVALID_PROJECT_ID", "Invalid project ID.", 400);
  }

  const role = await getShareRole(projectId, userId);
  if (!role) {
    return fail(res, "PROJECT_NOT_FOUND", "Project not found.", 404);
  }

  const { page = "1", limit = "30" } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const skip = (pageNum - 1) * limitNum;

  const filter = {
    projectId: new mongoose.Types.ObjectId(projectId),
  };
  applyCommonFilters(filter, req.query);

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .select("-ipAddress -userAgent")
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  return ok(res, {
    logs: serializeLogs(logs),
    total,
    page: pageNum,
    limit: limitNum,
    hasMore: skip + logs.length < total,
  });
});
