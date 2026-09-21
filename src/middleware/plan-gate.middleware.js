
import { Subscription } from "../models/Subscription.js";
import { PlanUsage } from "../models/PlanUsage.js";
import { getPlan, PLAN_LEVEL, PLANS, effectivePlanId } from "../config/plans.js";
import { fail } from "../utils/response.util.js";
import { Project } from "../models/Project.js";
import { Portal } from "../models/Portal.js";



async function loadSubscription(req) {
  if (req.subscription) return req.subscription;
  const sub = await Subscription.findOne({ userId: req.user.userId }).lean();
  if (!sub) {

    req.subscription = { plan: "free", status: "free", seats: 1 };
    return req.subscription;
  }
  req.subscription = sub;
  return sub;
}

function effectivePlan(sub) {
  return effectivePlanId(sub);
}




export function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      if (PLAN_LEVEL[plan] >= PLAN_LEVEL[minPlan]) return next();
      return fail(
        res,
        "PLAN_GATE",
        `This feature requires the ${getPlan(minPlan).name} plan or higher.`,
        403,
        { requiredPlan: minPlan },
      );
    } catch (err) {
      next(err);
    }
  };
}


export function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      const planConfig = getPlan(plan);
      if (planConfig.features[featureKey]) return next();


      const requiredPlan = findMinPlanForFeature(featureKey);
      return fail(
        res,
        "PLAN_GATE",
        `This feature is not available on your current plan.`,
        403,
        { requiredPlan, featureKey },
      );
    } catch (err) {
      next(err);
    }
  };
}


export async function checkProjectLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const maxProjects = planConfig.limits.projects;

    if (maxProjects === null) return next();


    if (maxProjects === 0) {
      return fail(
        res,
        "PROJECT_LIMIT_REACHED",
        `You've reached the ${maxProjects}-project limit on the ${planConfig.name} plan.`,
        403,
        { requiredPlan: "starter", limit: maxProjects },
      );
    }


    let reserved = null;
    try {
      reserved = await PlanUsage.findOneAndUpdate(
        { userId: req.user.userId, projectCount: { $lt: maxProjects } },
        { $inc: { projectCount: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (upsertErr) {
      if (upsertErr.code !== 11000) throw upsertErr;

      reserved = await PlanUsage.findOneAndUpdate(
        { userId: req.user.userId, projectCount: { $lt: maxProjects } },
        { $inc: { projectCount: 1 } },
        { upsert: false, new: true },
      );
    }

    if (!reserved) {
      return fail(
        res,
        "PROJECT_LIMIT_REACHED",
        `You've reached the ${maxProjects}-project limit on the ${planConfig.name} plan.`,
        403,
        { requiredPlan: "starter", limit: maxProjects },
      );
    }


    req._projectSlotReserved = true;
    return next();
  } catch (err) {
    next(err);
  }
}


export async function checkPortalPublishLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const maxPortals = planConfig.limits.portals;

    if (maxPortals === null) return next();


    const currentPortal = await Portal.findOne({ projectId: req.params.id })
      .select("isPublished")
      .lean();
    if (currentPortal?.isPublished) return next();


    if (maxPortals === 0) {
      return fail(
        res,
        "PLAN_GATE",
        `Publishing portals requires the Starter plan or higher.`,
        403,
        { requiredPlan: "starter" },
      );
    }


    const userProjectIds = await Project.find({ userId: req.user.userId })
      .select("_id")
      .lean();
    const projectIds = userProjectIds.map((p) => p._id);
    const publishedCount = await Portal.countDocuments({
      projectId: { $in: projectIds },
      isPublished: true,
    });

    if (publishedCount < maxPortals) return next();

    return fail(
      res,
      "PLAN_GATE",
      `You've reached the ${maxPortals}-portal limit on the ${planConfig.name} plan.`,
      403,
      { requiredPlan: "pro", limit: maxPortals },
    );
  } catch (err) {
    next(err);
  }
}


export function checkFileSizeLimit(fileSizeBytes) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      const maxMb = getPlan(plan).limits.maxFileSizeMb;
      const maxBytes = maxMb * 1024 * 1024;

      const size =
        fileSizeBytes || req.headers["content-length"] || req.file?.size || 0;

      if (size <= maxBytes) return next();

      return fail(
        res,
        "FILE_TOO_LARGE",
        `Files are limited to ${maxMb}MB on your current plan.`,
        413,
        { maxMb },
      );
    } catch (err) {
      next(err);
    }
  };
}


export const requireApiImporter = requireFeature("openApiImporter");


export const requireGithubSync = requireFeature("githubSync");


export const requireCustomDomain = requireFeature("customDomain");


export function requireExportFormat(format) {
  return async (req, res, next) => {
    try {
      const sub = await loadSubscription(req);
      const plan = effectivePlan(sub);
      const formats = getPlan(plan).limits.exportFormats;
      if (formats.includes(format)) return next();

      const requiredPlan = findMinPlanForExport(format);
      return fail(
        res,
        "PLAN_GATE",
        `${format.toUpperCase()} export requires ${getPlan(requiredPlan).name} plan or higher.`,
        403,
        { requiredPlan, format },
      );
    } catch (err) {
      next(err);
    }
  };
}


export async function checkAiChatLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const limit = planConfig.limits.aiChatsPerMonth;

    if (limit === null) return next();
    if (limit === 0) {
      return fail(
        res,
        "PLAN_GATE",
        "Chat with codebase is not available on your current plan.",
        403,
        { requiredPlan: "pro" },
      );
    }

    const usage = await PlanUsage.findOne({ userId: req.user.userId });
    const used = usage?.aiChatsUsed ?? 0;

    if (used < limit) {

      req.aiChatAllowed = true;
      return next();
    }

    return fail(
      res,
      "AI_CHAT_LIMIT_REACHED",
      `You've used all ${limit} AI chats for this month.`,
      403,
      { used, limit, resetAt: usage?.aiChatsResetAt },
    );
  } catch (err) {
    next(err);
  }
}


export async function checkPortalLimit(req, res, next) {
  try {
    const sub = await loadSubscription(req);
    const plan = effectivePlan(sub);
    const planConfig = getPlan(plan);
    const limit = planConfig.limits.portals;

    if (limit === null) return next();
    if (limit === 0) {
      return fail(
        res,
        "PLAN_GATE",
        "Public documentation portals are not available on your current plan.",
        403,
        { requiredPlan: "starter" },
      );
    }

    const usage = await PlanUsage.findOne({ userId: req.user.userId });
    const count = usage?.portalCount ?? 0;

    if (count < limit) return next();

    return fail(
      res,
      "PORTAL_LIMIT_REACHED",
      `You've reached the ${limit} portal limit on your current plan.`,
      403,
      { requiredPlan: "pro", limit },
    );
  } catch (err) {
    next(err);
  }
}



function findMinPlanForFeature(featureKey) {
  for (const planId of ["free", "starter", "pro", "team"]) {
    if (PLANS[planId].features[featureKey]) return planId;
  }
  return "team";
}

function findMinPlanForExport(format) {
  for (const planId of ["free", "starter", "pro", "team"]) {
    if (PLANS[planId].limits.exportFormats.includes(format)) return planId;
  }
  return "team";
}
