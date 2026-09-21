export const PLAN_IDS = ["free", "starter", "pro", "team"];

export const PLAN_LEVEL = { free: 0, starter: 1, pro: 2, team: 3 };
export const TRIAL_DAYS = 7;
export const DUNNING_MAX_DAYS = 10;
export const DUNNING_RETRY_DAYS = [0, 3, 7];
export const DUNNING_EMAIL_DAYS = [1, 5, 10];

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Solo devs exploring the platform",
    prices: {
      monthly: 0,
      annual: 0,
      annualTotal: 0,
      annualSavingsPct: 0,
    },
    limits: {
      projects: 2,
      seats: 1,
      extraSeatPriceMonthly: null,
      attachmentsPerProject: 3,
      maxFileSizeMb: 5,
      aiChatsPerMonth: 0,
      portals: 0,
      versionHistoryDays: 0,
      exportFormats: [],
    },
    features: {
      shareViewOnly: false,
      shareEdit: false,
      maxShares: 0,
      archiveRestore: false,
      customDomain: false,
      docApproval: false,
      progressTracker: false,
      openApiImporter: false,
      apiWebhookAccess: false,
      githubSync: false,
    },
  },

  starter: {
    id: "starter",
    name: "Starter",
    tagline: "Freelancers & solo developers",
    prices: {
      monthly: 600,
      annual: 486,
      annualTotal: 5832,
      annualSavingsPct: 19,
    },
    limits: {
      projects: null,
      seats: 1,
      extraSeatPriceMonthly: null,
      attachmentsPerProject: null,
      maxFileSizeMb: 20,
      aiChatsPerMonth: 0,
      portals: 1,
      versionHistoryDays: 30,
      exportFormats: ["pdf"],
    },
    features: {
      shareViewOnly: true,
      shareEdit: false,
      maxShares: 5,
      archiveRestore: true,
      customDomain: false,
      docApproval: false,
      progressTracker: true,
      openApiImporter: false,
      apiWebhookAccess: false,
      githubSync: false,
    },
  },

  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Small teams up to 5 seats",
    prices: {
      monthly: 1000,
      annual: 760,
      annualTotal: 9120,
      annualSavingsPct: 24,
    },
    limits: {
      projects: null,
      seats: 5,
      extraSeatPriceMonthly: 700,
      attachmentsPerProject: null,
      maxFileSizeMb: 50,
      aiChatsPerMonth: 50,
      portals: null,
      versionHistoryDays: null,
      exportFormats: ["pdf", "google_docs"],
    },
    features: {
      shareViewOnly: true,
      shareEdit: true,
      maxShares: null,
      archiveRestore: true,
      customDomain: true,
      docApproval: true,
      progressTracker: true,
      openApiImporter: true,
      apiWebhookAccess: true,
      githubSync: true,
    },
  },

  team: {
    id: "team",
    name: "Team",
    tagline: "Mid-size companies (6+ users)",
    prices: {
      monthly: 1200,
      annual: 1020,
      annualTotal: null,
      annualSavingsPct: 15,
    },
    limits: {
      projects: null,
      seats: null,
      extraSeatPriceMonthly: 1200,
      attachmentsPerProject: null,
      maxFileSizeMb: 100,
      aiChatsPerMonth: null,
      portals: null,
      versionHistoryDays: null,
      exportFormats: ["pdf", "google_docs", "notion"],
    },
    features: {
      shareViewOnly: true,
      shareEdit: true,
      maxShares: null,
      archiveRestore: true,
      customDomain: true,
      docApproval: true,
      progressTracker: true,
      openApiImporter: true,
      apiWebhookAccess: true,
      githubSync: true,
    },
  },
};

export function computeMonthlyPrice(planId, cycle, seats = 1) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  const perUnit = plan.prices[cycle];
  if (planId === "team") return perUnit * seats;
  return perUnit;
}

export function computeAnnualTotal(planId, seats = 1) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (planId === "team") return plan.prices.annual * 12 * seats;
  return plan.prices.annualTotal;
}

export function effectivePlanId(sub) {
  if (!sub) return "free";
  if (sub.status === "paused") return "free";
  if (sub.status === "trialing" || sub.status === "active" || sub.status === "past_due") {
    return sub.plan || "free";
  }
  return "free";
}

export function getPlan(planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan: "${planId}"`);
  return plan;
}

export function isUpgrade(currentPlanId, targetPlanId) {
  return (PLAN_LEVEL[targetPlanId] ?? 0) > (PLAN_LEVEL[currentPlanId] ?? 0);
}

export function isDowngrade(currentPlanId, targetPlanId) {
  return (PLAN_LEVEL[targetPlanId] ?? 0) < (PLAN_LEVEL[currentPlanId] ?? 0);
}
