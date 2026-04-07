// ===================================================================
// notification.scheduler.js
//
// Daily cron jobs that generate proactive notifications:
//   1. Subscription expiry reminders (7 / 3 / 1 days before)
//   2. Subscription expired today
//   3. Plan usage limit alerts (80% / 95% of project quota)
//
// Follows the same pattern as cron.service.js (startBillingCron).
// Called from app.js → initOnce().
// ===================================================================

import cron from "node-cron";
import { Subscription } from "../models/Subscription.js";
import { PlanUsage } from "../models/PlanUsage.js";
import { PLANS } from "../config/plans.js";
import { NotificationService } from "./notification.service.js";

let _started = false;

/**
 * Start all notification cron jobs.
 * Safe to call multiple times — only initialises once.
 */
export function startNotificationScheduler() {
  if (_started) return;
  _started = true;
  console.log("-- Notification scheduler starting…");

  // Daily at 09:00 UTC — friendly morning delivery
  cron.schedule("0 9 * * *", runNotificationJobs, { timezone: "UTC" });

  console.log("-- Notification scheduler registered (daily @ 09:00 UTC)");
}

// ── Job orchestrator ─────────────────────────────────────────────

async function runNotificationJobs() {
  console.log("[cron/notifications] Daily notification jobs starting");
  await Promise.allSettled([
    runSubscriptionExpiryReminders(),
    runPlanLimitAlerts(),
  ]);
  console.log("[cron/notifications] Daily notification jobs complete");
}

// ── Job: subscription expiry reminders ───────────────────────────

async function runSubscriptionExpiryReminders() {
  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setUTCHours(0, 0, 0, 0);

    const REMINDER_DAYS = [7, 3, 1];

    for (const days of REMINDER_DAYS) {
      const windowStart = new Date(startOfToday);
      windowStart.setUTCDate(windowStart.getUTCDate() + days);
      const windowEnd = new Date(windowStart);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

      const expiringSubs = await Subscription.find({
        status: { $in: ["active", "trialing"] },
        cancelAtPeriodEnd: true,
        currentPeriodEnd: { $gte: windowStart, $lt: windowEnd },
      }).select("userId plan").lean();

      for (const sub of expiringSubs) {
        const plan = PLANS[sub.plan];
        NotificationService.create({
          userId: sub.userId,
          type: "SUBSCRIPTION_PLAN_EXPIRING",
          actionUrl: "/settings/billing",
          metadata: {
            plan: plan?.name ?? sub.plan,
            days: String(days),
          },
        });
      }
    }

    // Plans that expired today (no renewal)
    const expiredStart = new Date(startOfToday);
    const expiredEnd = new Date(startOfToday);
    expiredEnd.setUTCDate(expiredEnd.getUTCDate() + 1);

    const expiredSubs = await Subscription.find({
      status: { $in: ["active", "trialing"] },
      cancelAtPeriodEnd: true,
      currentPeriodEnd: { $gte: expiredStart, $lt: expiredEnd },
    }).select("userId plan").lean();

    for (const sub of expiredSubs) {
      const plan = PLANS[sub.plan];
      NotificationService.create({
        userId: sub.userId,
        type: "SUBSCRIPTION_PLAN_EXPIRED",
        actionUrl: "/settings/billing",
        metadata: {
          plan: plan?.name ?? sub.plan,
        },
      });
    }
  } catch (err) {
    console.error("[cron/notifications] runSubscriptionExpiryReminders error:", err.message ?? err);
  }
}

// ── Job: plan limit alerts ────────────────────────────────────────

async function runPlanLimitAlerts() {
  try {
    // Only users on plans with a project limit
    const allUsage = await PlanUsage.find({}).select("userId projectCount").lean();
    if (!allUsage.length) return;

    const userIds = allUsage.map((u) => u.userId);

    const subscriptions = await Subscription.find({
      userId: { $in: userIds },
      status: { $in: ["active", "trialing"] },
    })
      .select("userId plan")
      .lean();

    // Index subscriptions by userId for O(1) lookup
    const subByUser = new Map();
    for (const sub of subscriptions) {
      subByUser.set(String(sub.userId), sub);
    }

    for (const usage of allUsage) {
      const sub = subByUser.get(String(usage.userId));
      if (!sub) continue;

      const plan = PLANS[sub.plan];
      if (!plan) continue;

      const limit = plan.limits?.projects;
      if (!limit || limit === null) continue; // unlimited plan — skip

      const percent = (usage.projectCount / limit) * 100;

      if (percent >= 100) {
        NotificationService.create({
          userId: usage.userId,
          type: "PLAN_LIMIT_REACHED",
          actionUrl: "/settings/billing",
          metadata: {
            resource: "projects",
            plan: plan.name,
          },
        });
      } else if (percent >= 95) {
        NotificationService.create({
          userId: usage.userId,
          type: "PLAN_LIMIT_APPROACHING",
          actionUrl: "/settings/billing",
          metadata: {
            resource: "projects",
            percent: "95",
            plan: plan.name,
          },
        });
      } else if (percent >= 80) {
        NotificationService.create({
          userId: usage.userId,
          type: "PLAN_LIMIT_APPROACHING",
          actionUrl: "/settings/billing",
          metadata: {
            resource: "projects",
            percent: "80",
            plan: plan.name,
          },
        });
      }
    }
  } catch (err) {
    console.error("[cron/notifications] runPlanLimitAlerts error:", err.message ?? err);
  }
}
