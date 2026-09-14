// ===================================================================
// Admin controller : super-admin only endpoints.
// All routes protected by protect + requireRole('super-admin').
// ===================================================================

import mongoose from "mongoose";
import { User } from "../../../models/User.js";
import { Project } from "../../../models/Project.js";
import { Subscription } from "../../../models/Subscription.js";
import { APIToken } from "../../../models/APIToken.js";
import { Invoice } from "../../../models/Invoice.js";
import { PaymentMethod } from "../../../models/PaymentMethod.js";
import { GitHubToken } from "../../../models/GitHubToken.js";
import GoogleToken from "../../../models/GoogleToken.js";
import { PlanUsage } from "../../../models/PlanUsage.js";
import { ProjectShare } from "../../../models/ProjectShare.js";
import { Portal } from "../../../models/Portal.js";
import { Notification } from "../../../models/Notification.js";
import { Attachment } from "../../../models/Attachment.js";
import { DocumentVersion } from "../../../models/DocumentVersion.js";
import { ApiSpec } from "../../../models/ApiSpec.js";
import { CliSession } from "../../../models/CliSession.js";
import { NotionSettings } from "../../../models/NotionSettings.js";
import { SlackIntegration } from "../../../models/SlackIntegration.js";
import ActivityLog, { ACTIVITY_ACTIONS } from "../../../models/ActivityLog.js";
import ProjectChangeLog from "../../../models/ProjectChangeLog.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";
import {
  computeMonthlyPrice,
  PLAN_IDS,
  PLAN_LEVEL,
  TRIAL_DAYS,
} from "../../../config/plans.js";
import { getOrCreateSubscription } from "../../../services/billing.service.js";
import { SESSION_NOISE_ACTIONS } from "../../../services/activity-copy.js";
import ActivityLogService from "../../../services/activity-log.service.js";

const USER_LIST_FIELDS =
  "name email role provider isEmailVerified createdAt githubUsername gitlabUsername bitbucketUsername";
const SUB_STATUSES = [
  "free",
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "paused",
];
const PAID_STATUSES = ["trialing", "active", "past_due", "cancelled", "paused"];

function publicSubscription(s) {
  if (!s) {
    return { plan: "free", status: "free", billingCycle: null, seats: 1 };
  }
  return {
    _id: s._id,
    plan: s.plan,
    status: s.status,
    billingCycle: s.billingCycle ?? null,
    seats: s.seats ?? 1,
    currentPeriodEnd: s.currentPeriodEnd ?? null,
    trialEndsAt: s.trialEndsAt ?? null,
    lastBillingNote: s.lastBillingNote ?? null,
  };
}

function periodEndForCycle(from, cycle) {
  const end = new Date(from);
  if (cycle === "annual") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

async function resolveAdminActor(req) {
  const admin = await User.findById(req.user.userId).select("name email").lean();
  return {
    actorName: admin?.name || "Admin",
    actorEmail: admin?.email || req.user.email || "",
  };
}

async function cascadeDeleteProjects(projectIds) {
  if (!projectIds.length) return;
  await Promise.all([
    Portal.deleteMany({ projectId: { $in: projectIds } }),
    ProjectShare.deleteMany({ projectId: { $in: projectIds } }),
    Attachment.deleteMany({ projectId: { $in: projectIds } }),
    DocumentVersion.deleteMany({ projectId: { $in: projectIds } }),
    ApiSpec.deleteMany({ projectId: { $in: projectIds } }),
    ProjectChangeLog.deleteMany({ projectId: { $in: projectIds } }),
    SlackIntegration.deleteMany({ projectId: { $in: projectIds } }),
    Project.deleteMany({ _id: { $in: projectIds } }),
  ]);
}

// ── GET /admin/stats ──────────────────────────────────────────
export async function getStats(req, res) {
  try {
    const [
      totalUsers,
      totalProjects,
      usersByPlan,
      recentUsers,
      recentProjects,
    ] = await Promise.all([
      User.countDocuments(),
      Project.countDocuments(),
      Subscription.aggregate([
        {
          $group: {
            _id: "$plan",
            count: { $sum: 1 },
          },
        },
      ]),
      User.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
      Project.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
    ]);

    // Build plan breakdown map
    const planBreakdown = { free: 0, starter: 0, pro: 0, team: 0 };
    for (const { _id, count } of usersByPlan) {
      if (_id in planBreakdown) planBreakdown[_id] = count;
    }

    // Estimate MRR: count active/trialing paid subscriptions * monthly price
    const paidSubs = await Subscription.find({
      plan: { $in: ["starter", "pro", "team"] },
      status: { $in: ["active", "trialing"] },
    }).select("plan billingCycle seats");

    let mrrCents = 0;
    for (const sub of paidSubs) {
      try {
        mrrCents += computeMonthlyPrice(
          sub.plan,
          sub.billingCycle || "monthly",
          sub.seats || 1,
        );
      } catch {
        /* unknown plan */
      }
    }

    return ok(res, {
      totalUsers,
      totalProjects,
      newUsersLast30Days: recentUsers,
      newProjectsLast30Days: recentProjects,
      planBreakdown,
      estimatedMRR: Math.round(mrrCents) / 100,
      paidSubscriptions: paidSubs.length,
    });
  } catch (err) {
    return serverError(res, err, "admin.getStats");
  }
}

// ── GET /admin/users ──────────────────────────────────────────
// Query params: page (default 1), limit (default 20), search (name/email)
export async function listUsers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();

    const filter = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      User.find(filter)
        .select(USER_LIST_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    // Attach subscription info
    const userIds = users.map((u) => u._id);
    const subs = await Subscription.find({ userId: { $in: userIds } })
      .select("userId plan status billingCycle seats currentPeriodEnd trialEndsAt")
      .lean();

    const subMap = Object.fromEntries(
      subs.map((s) => [s.userId.toString(), s]),
    );

    const enriched = users.map((u) => ({
      ...u,
      subscription: publicSubscription(subMap[u._id.toString()]),
    }));

    return ok(res, {
      users: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listUsers");
  }
}

// ── DELETE /admin/users/:id ───────────────────────────────────
export async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    // Super-admin cannot delete themselves
    if (id === req.user.userId) {
      return fail(
        res,
        "SELF_DELETE",
        "You cannot delete your own account.",
        400,
      );
    }

    const user = await User.findById(id);
    if (!user) return fail(res, "NOT_FOUND", "User not found.", 404);

    const projects = await Project.find({ userId: id }).select("_id").lean();
    const projectIds = projects.map((p) => p._id);

    await cascadeDeleteProjects(projectIds);
    await Promise.all([
      Subscription.deleteMany({ userId: id }),
      APIToken.deleteMany({ userId: id }),
      Invoice.deleteMany({ userId: id }),
      PaymentMethod.deleteMany({ userId: id }),
      GitHubToken.deleteMany({ userId: id }),
      GoogleToken.deleteMany({ userId: id }),
      PlanUsage.deleteMany({ userId: id }),
      ProjectShare.deleteMany({
        $or: [{ ownerId: id }, { inviteeUserId: id }],
      }),
      Notification.deleteMany({ userId: id }),
      ActivityLog.deleteMany({ userId: id }),
      CliSession.deleteMany({ userId: id }),
      NotionSettings.deleteMany({ userId: id }),
      SlackIntegration.deleteMany({ userId: id }),
      User.findByIdAndDelete(id),
    ]);

    return ok(res, null, "User and all associated data deleted.");
  } catch (err) {
    return serverError(res, err, "admin.deleteUser");
  }
}

// ── GET /admin/projects ───────────────────────────────────────
// Query params: page, limit, search (name), userId (filter by owner)
export async function listProjects(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();
    const userId = req.query.userId;

    const filter = {};
    if (userId) filter.userId = userId;
    if (search) filter.name = { $regex: search, $options: "i" };

    const [projects, total] = await Promise.all([
      Project.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email")
        .lean(),
      Project.countDocuments(filter),
    ]);

    return ok(res, {
      projects,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listProjects");
  }
}

// ── DELETE /admin/projects/:id ────────────────────────────────
export async function deleteProject(req, res) {
  try {
    const { id } = req.params;
    const project = await Project.findById(id).select("_id");
    if (!project) return fail(res, "NOT_FOUND", "Project not found.", 404);
    await cascadeDeleteProjects([project._id]);
    return ok(res, null, "Project deleted.");
  } catch (err) {
    return serverError(res, err, "admin.deleteProject");
  }
}

// ── GET /admin/subscriptions ──────────────────────────────────
// Overview of all paid subscriptions
export async function listSubscriptions(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const plan = req.query.plan;
    const status = req.query.status;

    const filter = {};
    if (plan) filter.plan = plan;
    if (status) filter.status = status;

    const [subs, total] = await Promise.all([
      Subscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "name email")
        .lean(),
      Subscription.countDocuments(filter),
    ]);

    return ok(res, {
      subscriptions: subs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listSubscriptions");
  }
}

// ── PATCH /admin/users/:id ────────────────────────────────────
// Body: { role?, isEmailVerified?, revokeSessions? }
export async function updateUser(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, "INVALID_ID", "Invalid user id.", 400);
    }

    const { role, isEmailVerified, revokeSessions } = req.body || {};
    const changingRole = role !== undefined;
    const changingVerify = typeof isEmailVerified === "boolean";
    const signingOut = revokeSessions === true;

    if (!changingRole && !changingVerify && !signingOut) {
      return fail(res, "NO_CHANGES", "Nothing to update.", 400);
    }

    if (changingRole && !["user", "super-admin"].includes(role)) {
      return fail(res, "INVALID_ROLE", "Role must be user or super-admin.", 400);
    }

    if (changingRole && id === req.user.userId && role !== "super-admin") {
      return fail(res, "SELF_DEMOTE", "You cannot change your own role.", 400);
    }

    const user = await User.findById(id);
    if (!user) return fail(res, "NOT_FOUND", "User not found.", 404);

    if (changingRole && user.role === "super-admin" && role !== "super-admin") {
      const otherAdmins = await User.countDocuments({
        role: "super-admin",
        _id: { $ne: id },
      });
      if (otherAdmins === 0) {
        return fail(
          res,
          "LAST_ADMIN",
          "Cannot demote the last super-admin.",
          400,
        );
      }
    }

    if (changingRole) user.role = role;
    if (changingVerify) {
      user.isEmailVerified = isEmailVerified;
      if (isEmailVerified) {
        user.emailVerificationToken = undefined;
        user.emailVerificationExpires = undefined;
      }
    }
    if (signingOut) user.refreshTokenHash = null;

    await user.save();

    const actor = await resolveAdminActor(req);
    ActivityLogService.log({
      userId: id,
      actorName: actor.actorName,
      actorEmail: actor.actorEmail,
      action: ACTIVITY_ACTIONS.ADMIN_USER_UPDATED,
      metadata: {
        role: changingRole ? role : undefined,
        isEmailVerified: changingVerify ? isEmailVerified : undefined,
        revokeSessions: signingOut || undefined,
        updatedBy: req.user.userId,
      },
      req,
    });

    return ok(
      res,
      {
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          provider: user.provider,
          isEmailVerified: user.isEmailVerified,
          createdAt: user.createdAt,
        },
      },
      "User updated.",
    );
  } catch (err) {
    return serverError(res, err, "admin.updateUser");
  }
}

// ── PATCH /admin/users/:id/subscription ───────────────────────
// Comping a plan: writes Subscription directly, no Flutterwave checkout.
// Body: { plan, status?, billingCycle?, seats?, note? }
export async function updateUserSubscription(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, "INVALID_ID", "Invalid user id.", 400);
    }

    const { plan, status, billingCycle, seats, note } = req.body || {};
    if (!PLAN_IDS.includes(plan)) {
      return fail(res, "INVALID_PLAN", "Unknown plan.", 400);
    }
    if (status !== undefined && !SUB_STATUSES.includes(status)) {
      return fail(res, "INVALID_STATUS", "Unknown subscription status.", 400);
    }
    if (
      billingCycle !== undefined &&
      billingCycle !== null &&
      billingCycle !== "monthly" &&
      billingCycle !== "annual"
    ) {
      return fail(
        res,
        "INVALID_CYCLE",
        "Billing cycle must be monthly or annual.",
        400,
      );
    }

    const user = await User.findById(id).select("_id").lean();
    if (!user) return fail(res, "NOT_FOUND", "User not found.", 404);

    const sub = await getOrCreateSubscription(id);
    const previousPlan = sub.plan;
    const previousStatus = sub.status;
    const now = new Date();

    sub.plan = plan;

    if (plan === "free") {
      sub.status = "free";
      sub.billingCycle = null;
      sub.pendingPlan = null;
      sub.pendingBillingCycle = null;
      sub.cancelAtPeriodEnd = false;
      sub.cancelledAt = previousStatus !== "free" ? now : sub.cancelledAt;
      sub.pausedAt = null;
      sub.pauseEndsAt = null;
      sub.dunningAttemptCount = 0;
      sub.dunningStartedAt = null;
    } else {
      let nextStatus =
        status && PAID_STATUSES.includes(status) ? status : "active";
      if (nextStatus === "free") nextStatus = "active";
      sub.status = nextStatus;
      sub.billingCycle =
        billingCycle === "annual" || billingCycle === "monthly"
          ? billingCycle
          : sub.billingCycle || "monthly";

      if (!sub.currentPeriodStart) sub.currentPeriodStart = now;
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd < now) {
        sub.currentPeriodEnd = periodEndForCycle(now, sub.billingCycle);
      }

      if (nextStatus === "trialing") {
        if (!sub.trialEndsAt || sub.trialEndsAt < now) {
          const trialEnd = new Date(now);
          trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
          sub.trialEndsAt = trialEnd;
        }
        if (!sub.trialUsedAt) sub.trialUsedAt = now;
      }

      if (nextStatus === "active") {
        sub.cancelAtPeriodEnd = false;
        sub.cancelledAt = null;
        sub.pausedAt = null;
        sub.pauseEndsAt = null;
        sub.pendingPlan = null;
        sub.pendingBillingCycle = null;
        sub.dunningAttemptCount = 0;
        sub.dunningStartedAt = null;
      }

      if (nextStatus === "cancelled") {
        sub.cancelAtPeriodEnd = true;
        sub.cancelledAt = sub.cancelledAt || now;
      }

      if (nextStatus === "paused") {
        sub.pausedAt = sub.pausedAt || now;
      }
    }

    if (seats !== undefined && seats !== null && seats !== "") {
      const n = Number.parseInt(seats, 10);
      if (!Number.isFinite(n) || n < 1) {
        return fail(res, "INVALID_SEATS", "Seats must be at least 1.", 400);
      }
      sub.seats = n;
    } else if (plan === "team" && (!sub.seats || sub.seats < 1)) {
      sub.seats = 1;
    }

    const adminNote = typeof note === "string" ? note.trim().slice(0, 500) : "";
    sub.lastBillingNote = adminNote
      ? `Admin grant: ${adminNote}`
      : `Admin grant by ${req.user.userId}`;

    await sub.save();

    let action = ACTIVITY_ACTIONS.SUBSCRIPTION_UPGRADED;
    if (sub.status === "cancelled") {
      action = ACTIVITY_ACTIONS.SUBSCRIPTION_CANCELLED;
    } else if ((PLAN_LEVEL[plan] ?? 0) < (PLAN_LEVEL[previousPlan] ?? 0)) {
      action = ACTIVITY_ACTIONS.SUBSCRIPTION_DOWNGRADED;
    }

    const actor = await resolveAdminActor(req);
    ActivityLogService.log({
      userId: id,
      actorName: actor.actorName,
      actorEmail: actor.actorEmail,
      action,
      metadata: {
        plan,
        previousPlan,
        previousStatus,
        status: sub.status,
        billingCycle: sub.billingCycle,
        seats: sub.seats,
        adminGrant: true,
        grantedBy: req.user.userId,
        note: adminNote || undefined,
      },
      req,
    });

    return ok(
      res,
      { subscription: publicSubscription(sub.toObject()) },
      "Subscription updated.",
    );
  } catch (err) {
    return serverError(res, err, "admin.updateUserSubscription");
  }
}

// ── GET /admin/activity ───────────────────────────────────────
export async function listActivity(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();
    const category = req.query.category;
    const userId = req.query.userId;

    const filter = { action: { $nin: SESSION_NOISE_ACTIONS } };
    if (category) filter.category = category;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      filter.userId = userId;
    }
    if (search) {
      filter.$or = [
        { actorName: { $regex: search, $options: "i" } },
        { actorEmail: { $regex: search, $options: "i" } },
        { summary: { $regex: search, $options: "i" } },
        { projectName: { $regex: search, $options: "i" } },
      ];
    }

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-userAgent")
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    return ok(res, {
      logs: logs.map((log) => ({
        ...log,
        userId: log.userId?.toString?.() ?? log.userId,
        projectId: log.projectId?.toString?.() ?? log.projectId,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return serverError(res, err, "admin.listActivity");
  }
}
