
import cron from "node-cron";
import { Subscription } from "../models/Subscription.js";
import { PaymentMethod } from "../models/PaymentMethod.js";
import { PlanUsage } from "../models/PlanUsage.js";
import { User } from "../models/User.js";
import { processDunning } from "./dunning.service.js";
import {
  renewSubscription,
  applyScheduledDowngrade,
  downgradeToFree,
} from "./billing.service.js";
import {
  sendTrialExpiryReminderEmail,
  sendTrialExpiredEmail,
  sendCardExpiryWarningEmail,
} from "../config/email.js";

let _started = false;


export function startBillingCron() {
  if (_started) return;
  _started = true;
  console.log("-- Billing cron jobs starting…");


  const DAILY = "0 0 * * *";

  cron.schedule(DAILY, runCheckTrialExpiry, { timezone: "UTC" });
  cron.schedule(DAILY, runCheckSubscriptionRenewals, { timezone: "UTC" });
  cron.schedule(DAILY, runProcessDunning, { timezone: "UTC" });
  cron.schedule(DAILY, runProcessScheduledDowngrades, { timezone: "UTC" });
  cron.schedule(DAILY, runResetAiUsage, { timezone: "UTC" });
  cron.schedule(DAILY, runFlagExpiringCards, { timezone: "UTC" });

  console.log("-- Billing cron jobs registered (daily @ 00:00 UTC)");
}



async function runCheckTrialExpiry() {
  console.log("[cron] check_trial_expiry starting");
  try {
    const now = new Date();
    const tomorrow = addDays(now, 1);
    const threeDaysFromNow = addDays(now, 3);


    const remind3 = await Subscription.find({
      status: "trialing",
      trialEndsAt: {
        $gte: threeDaysFromNow,
        $lt: addDays(threeDaysFromNow, 1),
      },
    });
    for (const sub of remind3) {
      const user = await User.findById(sub.userId).select("name email");
      if (user) {
        await sendTrialExpiryReminderEmail({
          to: user.email,
          name: user.name,
          daysLeft: 3,
          trialEndsAt: sub.trialEndsAt,
          billingUrl: `${process.env.FRONTEND_URL}/billing`,
        });
      }
    }


    const remind1 = await Subscription.find({
      status: "trialing",
      trialEndsAt: { $gte: tomorrow, $lt: addDays(tomorrow, 1) },
    });
    for (const sub of remind1) {
      const user = await User.findById(sub.userId).select("name email");
      if (user) {
        await sendTrialExpiryReminderEmail({
          to: user.email,
          name: user.name,
          daysLeft: 1,
          trialEndsAt: sub.trialEndsAt,
          billingUrl: `${process.env.FRONTEND_URL}/billing`,
        });
      }
    }


    const expired = await Subscription.find({
      status: "trialing",
      trialEndsAt: { $lt: now },
    });
    for (const sub of expired) {
      const user = await User.findById(sub.userId).select("name email");
      await downgradeToFree(sub);
      if (user) {
        await sendTrialExpiredEmail({ to: user.email, name: user.name });
      }
    }

    console.log(
      `[cron] check_trial_expiry: remind3=${remind3.length}, remind1=${remind1.length}, expired=${expired.length}`,
    );
  } catch (err) {
    console.error("[cron] check_trial_expiry error:", err.message);
  }
}

async function runCheckSubscriptionRenewals() {
  console.log("[cron] check_subscription_renewals starting");
  try {
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);


    const due = await Subscription.find({
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: { $lte: endOfToday },
      plan: { $ne: "free" },
    });

    console.log(
      `[cron] check_subscription_renewals: ${due.length} renewals due`,
    );

    for (const sub of due) {
      try {
        await renewSubscription(sub._id.toString());
      } catch (err) {
        console.error(
          `[cron] renewal failed for sub ${sub._id}: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error("[cron] check_subscription_renewals error:", err.message);
  }
}

async function runProcessDunning() {
  console.log("[cron] process_dunning starting");
  try {
    await processDunning();
  } catch (err) {
    console.error("[cron] process_dunning error:", err.message);
  }
}

async function runProcessScheduledDowngrades() {
  console.log("[cron] process_scheduled_downgrades starting");
  try {
    const now = new Date();


    const cancellations = await Subscription.find({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: { $lte: now },
    });


    const pendingDowngrades = await Subscription.find({
      pendingPlan: { $ne: null },
      currentPeriodEnd: { $lte: now },
    });

    const all = [...cancellations, ...pendingDowngrades];

    const unique = [...new Map(all.map((s) => [s._id.toString(), s])).values()];

    console.log(
      `[cron] process_scheduled_downgrades: ${unique.length} to process`,
    );
    for (const sub of unique) {
      try {
        await applyScheduledDowngrade(sub._id.toString());
      } catch (err) {
        console.error(
          `[cron] downgrade failed for sub ${sub._id}: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error("[cron] process_scheduled_downgrades error:", err.message);
  }
}

async function runResetAiUsage() {
  console.log("[cron] reset_ai_usage starting");
  try {
    const now = new Date();
    const result = await PlanUsage.updateMany(
      { aiChatsResetAt: { $lte: now } },
      {
        $set: {
          aiChatsUsed: 0,
          aiChatsResetAt: addDays(now, 30),
        },
      },
    );
    console.log(`[cron] reset_ai_usage: reset ${result.modifiedCount} users`);
  } catch (err) {
    console.error("[cron] reset_ai_usage error:", err.message);
  }
}

async function runFlagExpiringCards() {
  console.log("[cron] flag_expiring_cards starting");
  try {
    const now = new Date();
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthNum = nextMonth.getMonth() + 1;
    const nextMonthYear = nextMonth.getFullYear();

    const expiring = await PaymentMethod.find({
      type: "card",
      deletedAt: null,
      "card.expMonth": nextMonthNum,
      "card.expYear": nextMonthYear,
    });

    console.log(
      `[cron] flag_expiring_cards: ${expiring.length} cards expiring next month`,
    );

    for (const pm of expiring) {
      const user = await User.findById(pm.userId).select("name email");
      if (user) {
        await sendCardExpiryWarningEmail({
          to: user.email,
          name: user.name,
          cardLabel: `${pm.card.brand} ****${pm.card.last4}`,
          expMonth: pm.card.expMonth,
          expYear: pm.card.expYear,
          billingUrl: `${process.env.FRONTEND_URL}/billing`,
        });
      }
    }
  } catch (err) {
    console.error("[cron] flag_expiring_cards error:", err.message);
  }
}



function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
