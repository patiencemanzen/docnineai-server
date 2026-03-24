import mongoose from "mongoose";
import ActivityLog from "../../../models/ActivityLog.js";
import { ok, fail, serverError, wrap } from "../../../utils/response.util.js";

// ---------------------------------------------------------------------------
// GET /activity-logs
// ---------------------------------------------------------------------------
export const listActivityLogs = wrap(async (req, res) => {
  const userId = req.user.userId;

  const {
    category,
    severity,
    projectId,
    from,
    to,
    page = "1",
    limit = "30",
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const skip     = (pageNum - 1) * limitNum;

  const filter = { userId: new mongoose.Types.ObjectId(userId) };

  if (category)  filter.category = category;
  if (severity)  filter.severity = severity;
  if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
    filter.projectId = new mongoose.Types.ObjectId(projectId);
  }

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  return ok(res, {
    logs,
    total,
    page: pageNum,
    limit: limitNum,
    hasMore: skip + logs.length < total,
  });
});

// ---------------------------------------------------------------------------
// GET /activity-logs/project/:projectId
// ---------------------------------------------------------------------------
export const listProjectActivityLogs = wrap(async (req, res) => {
  const userId    = req.user.userId;
  const { projectId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return fail(res, "INVALID_PROJECT_ID", "Invalid project ID.", 400);
  }

  const {
    category,
    severity,
    from,
    to,
    page = "1",
    limit = "30",
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const skip     = (pageNum - 1) * limitNum;

  const filter = {
    userId:    new mongoose.Types.ObjectId(userId),
    projectId: new mongoose.Types.ObjectId(projectId),
  };

  if (category) filter.category = category;
  if (severity) filter.severity = severity;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to);
  }

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  return ok(res, {
    logs,
    total,
    page: pageNum,
    limit: limitNum,
    hasMore: skip + logs.length < total,
  });
});
