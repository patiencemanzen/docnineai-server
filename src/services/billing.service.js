
import crypto from "crypto";
import { Subscription } from "../models/Subscription.js";
import { Invoice } from "../models/Invoice.js";
import { PaymentMethod } from "../models/PaymentMethod.js";
import { PlanUsage } from "../models/PlanUsage.js";
import { User } from "../models/User.js";
import {
  getPlan,
  computeMonthlyPrice,
  computeAnnualTotal,
  isUpgrade,
  isDowngrade,
  TRIAL_DAYS,
} from "../config/plans.js";
import {
  initializePayment,
  verifyTransaction,
  chargeToken,
  refundTransaction,
  buildTxRef,
  centsToUsd,
  buildPaymentMethodSnapshot,
  extractChargeToken,
} from "./flutterwave.service.js";
import {
  sendSubscriptionActivatedEmail,
  sendPlanUpgradedEmail,
  sendPlanDowngradeScheduledEmail,
  sendCancellationConfirmEmail,
  sendPaymentReceiptEmail,
  sendTrialStartedEmail,
} from "../config/email.js";
import { NotificationService } from "./notification.service.js";




export async function getOrCreateSubscription(userId) {
  let sub = await Subscription.findOne({ userId });
  if (!sub) {
    sub = await Subscription.create({ userId, plan: "free", status: "free" });
  }
  return sub;
}




export function isTrialEligible(sub) {
  if (!sub) return true;
  if (sub.trialUsedAt) return false;
  if (["trialing", "active", "past_due", "paused"].includes(sub.status)) {
    return false;
  }
  return true;
}

export async function initiateCheckout({
  userId,
  planId,
  cycle,
  seats = 1,
  preferTrial = true,
}) {
  const plan = getPlan(planId);
  const user = await User.findById(userId).select("name email");
  if (!user) throw new Error("User not found");

  const sub = await getOrCreateSubscription(userId);


  if (preferTrial && isTrialEligible(sub)) {
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    sub.plan = planId;
    sub.billingCycle = cycle;
    sub.seats = seats;
    sub.status = "trialing";
    sub.trialEndsAt = trialEndsAt;
    sub.trialUsedAt = new Date();
    sub.currentPeriodStart = new Date();
    sub.currentPeriodEnd = trialEndsAt;
    sub.cancelAtPeriodEnd = false;
    sub.pendingPlan = null;
    await sub.save();


    if (
      plan.limits.aiChatsPerMonth > 0 ||
      plan.limits.aiChatsPerMonth === null
    ) {
      await PlanUsage.findOneAndUpdate(
        { userId },
        {
          aiChatsUsed: 0,
          aiChatsResetAt: endOfMonth(),
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }

    await sendTrialStartedEmail({
      to: user.email,
      name: user.name,
      planName: plan.name,
      trialEndsAt,
    });

    return { type: "trial", trial: true, subscription: sub };
  }


  const amountCents = computeCheckoutAmount({ planId, cycle, seats });
  const txRef = buildTxRef("checkout");


  const invoice = await Invoice.create({
    userId,
    subscriptionId: sub._id,
    amount: amountCents,
    currency: "USD",
    description: buildInvoiceDescription(planId, cycle, seats),
    status: "pending",
    flutterwaveRef: txRef,
    customerName: user.name,
    customerEmail: user.email,
    planId,
    billingCycle: cycle,
    seats,
    periodStart: new Date(),
    periodEnd: addPeriod(new Date(), cycle),
    lineItems: buildLineItems(planId, cycle, seats),
  });

  const { paymentLink } = await initializePayment({
    txRef,
    amount: centsToUsd(amountCents),
    currency: "USD",
    email: user.email,
    name: user.name,
    planId,
    redirectUrl: `${process.env.FRONTEND_URL}/billing?status=paid&ref=${txRef}`,
  });

  return { type: "payment", trial: false, paymentLink, invoiceId: invoice._id, txRef };
}




export async function activateFromPayment(fwTx) {
  const txRef = fwTx.tx_ref;
  const invoice = await Invoice.findOne({ flutterwaveRef: txRef });
  if (!invoice) {
    console.error(`[billing] No invoice found for tx_ref: ${txRef}`);
    return;
  }
  if (invoice.status === "paid") return;

  const sub = await Subscription.findById(invoice.subscriptionId);
  const user = await User.findById(invoice.userId).select("name email");


  const token = extractChargeToken(fwTx);
  if (token) {
    await upsertPaymentMethod({ userId: invoice.userId, fwTx, token });
  }


  const snapshot = buildPaymentMethodSnapshot(fwTx);
  invoice.status = "paid";
  invoice.paidAt = new Date();
  invoice.flutterwaveTxId = fwTx.id;
  invoice.paymentMethodSnapshot = snapshot;
  await invoice.save();


  if (sub) {
    if (invoice.seatDelta > 0 && !invoice.planId) {

      sub.extraSeats = (sub.extraSeats || 0) + invoice.seatDelta;
      sub.seats = (sub.seats || 1) + invoice.seatDelta;
      await sub.save();
    } else {

      const activatedPlan = invoice.planId || sub.pendingPlan || sub.plan;
      const activatedCycle =
        invoice.billingCycle ||
        sub.pendingBillingCycle ||
        sub.billingCycle ||
        "monthly";
      const activatedSeats = invoice.seats || sub.seats || 1;

      const periodStart = new Date();
      const periodEnd = addPeriod(periodStart, activatedCycle);

      sub.plan = activatedPlan;
      sub.billingCycle = activatedCycle;
      sub.seats = activatedSeats;
      sub.status = "active";
      sub.currentPeriodStart = periodStart;
      sub.currentPeriodEnd = periodEnd;
      sub.pendingPlan = null;
      sub.pendingBillingCycle = null;
      sub.dunningAttemptCount = 0;
      sub.dunningStartedAt = null;
      sub.cancelAtPeriodEnd = false;
      if (!sub.trialUsedAt) sub.trialUsedAt = new Date();
      await sub.save();
    }
  }


  await PlanUsage.findOneAndUpdate(
    { userId: invoice.userId },
    { aiChatsUsed: 0, aiChatsResetAt: endOfMonth() },
    { upsert: true, setDefaultsOnInsert: true },
  );

  await sendPaymentReceiptEmail({
    to: user.email,
    name: user.name,
    invoiceNumber: invoice.invoiceNumber,
    amount: centsToUsd(invoice.amount),
    description: invoice.description,
    paidAt: invoice.paidAt,
  });

  NotificationService.create({
    userId: invoice.userId,
    type: "SUBSCRIPTION_PAYMENT_SUCCESS",
    actionUrl: "/settings/billing",
    metadata: {
      plan: sub?.plan ?? "your plan",
      amount: `$${centsToUsd(invoice.amount)}`,
    },
  });
}




export async function changePlan({ userId, newPlanId, newCycle, seats }) {
  const sub = await getOrCreateSubscription(userId);
  const user = await User.findById(userId).select("name email");

  const currentPlan = sub.plan;
  const currentCycle = sub.billingCycle;

  const upgrading = isUpgrade(currentPlan, newPlanId);
  const downgrading = isDowngrade(currentPlan, newPlanId);
  const cycleChange = !upgrading && !downgrading && currentCycle !== newCycle;


  if (upgrading || (cycleChange && newCycle === "annual")) {
    const proratedCents = calculateProration(sub, newPlanId, newCycle, seats);


    if (proratedCents <= 0) {
      const periodEnd = addPeriod(new Date(), newCycle);
      sub.plan = newPlanId;
      sub.billingCycle = newCycle;
      sub.seats = seats;
      sub.status = "active";
      sub.currentPeriodStart = new Date();
      sub.currentPeriodEnd = periodEnd;
      sub.pendingPlan = null;
      sub.pendingBillingCycle = null;
      await sub.save();


      await Invoice.updateMany(
        {
          userId,
          subscriptionId: sub._id,
          status: "pending",
          planId: newPlanId,
        },
        { status: "void" },
      );


      await sendPlanUpgradedEmail({
        to: user.email,
        name: user.name,
        newPlanName: getPlan(newPlanId).name,
        nextRenewalDate: periodEnd,
      });

      NotificationService.create({
        userId,
        type: "SUBSCRIPTION_UPGRADED",
        actionUrl: "/settings/billing",
        metadata: { newPlan: getPlan(newPlanId).name },
      });

      return { type: "immediate_no_charge" };
    }


    const txRef = buildTxRef("upgrade");

    const invoice = await Invoice.create({
      userId,
      subscriptionId: sub._id,
      amount: proratedCents,
      currency: "USD",
      description: `Upgrade to ${getPlan(newPlanId).name} (prorated)`,
      status: "pending",
      flutterwaveRef: txRef,
      customerName: user.name,
      customerEmail: user.email,
      planId: newPlanId,
      billingCycle: newCycle,
      seats,
      lineItems: [
        {
          description: `Prorated upgrade: ${currentPlan} → ${newPlanId}`,
          amount: proratedCents,
        },
      ],
    });


    const savedMethod = await PaymentMethod.findOne({
      userId,
      isDefault: true,
      deletedAt: null,
    }).select("+flutterwaveToken");

    if (savedMethod?.flutterwaveToken) {
      try {
        const fwTx = await chargeToken({
          token: savedMethod.flutterwaveToken,
          txRef,
          amount: centsToUsd(proratedCents),
          currency: savedMethod.currency || "USD",
          email: user.email,
          narration: `Docnine upgrade to ${getPlan(newPlanId).name}`,
        });

        invoice.status = "paid";
        invoice.paidAt = new Date();
        invoice.flutterwaveTxId = fwTx.id;
        invoice.paymentMethodSnapshot = buildPaymentMethodSnapshot(fwTx);
        await invoice.save();


        const periodEnd = addPeriod(new Date(), newCycle);
        sub.plan = newPlanId;
        sub.billingCycle = newCycle;
        sub.seats = seats;
        sub.status = "active";
        sub.currentPeriodStart = new Date();
        sub.currentPeriodEnd = periodEnd;
        sub.pendingPlan = null;
        await sub.save();

        await sendPlanUpgradedEmail({
          to: user.email,
          name: user.name,
          newPlanName: getPlan(newPlanId).name,
          nextRenewalDate: periodEnd,
        });

        NotificationService.create({
          userId,
          type: "SUBSCRIPTION_UPGRADED",
          actionUrl: "/settings/billing",
          metadata: { newPlan: getPlan(newPlanId).name },
        });

        return { type: "upgrade", immediate: true };
      } catch (tokenErr) {

        console.warn(
          "[changePlan] Token charge failed, falling back to payment link:",
          tokenErr.message,
        );
        invoice.status = "void";
        await invoice.save();

        const newTxRef = buildTxRef("upgrade");
        await Invoice.create({
          userId,
          subscriptionId: sub._id,
          amount: proratedCents,
          currency: "USD",
          description: `Upgrade to ${getPlan(newPlanId).name} (prorated)`,
          status: "pending",
          flutterwaveRef: newTxRef,
          customerName: user.name,
          customerEmail: user.email,
          planId: newPlanId,
          billingCycle: newCycle,
          seats,
          lineItems: [
            {
              description: `Prorated upgrade: ${currentPlan} → ${newPlanId}`,
              amount: proratedCents,
            },
          ],
        });
        const { paymentLink } = await initializePayment({
          txRef: newTxRef,
          amount: centsToUsd(proratedCents),
          currency: "USD",
          email: user.email,
          name: user.name,
          planId: newPlanId,
          redirectUrl: `${process.env.FRONTEND_URL}/billing?status=upgraded&ref=${newTxRef}`,
        });
        sub.pendingPlan = newPlanId;
        sub.pendingBillingCycle = newCycle;
        await sub.save();
        return { type: "upgrade", immediate: false, paymentLink };
      }
    }


    const { paymentLink } = await initializePayment({
      txRef,
      amount: centsToUsd(proratedCents),
      currency: "USD",
      email: user.email,
      name: user.name,
      planId: newPlanId,
      redirectUrl: `${process.env.FRONTEND_URL}/billing?status=upgraded&ref=${txRef}`,
    });


    sub.pendingPlan = newPlanId;
    sub.pendingBillingCycle = newCycle;
    await sub.save();

    return { type: "upgrade", immediate: false, paymentLink };
  }


  if (downgrading || (cycleChange && newCycle === "monthly")) {
    sub.pendingPlan = newPlanId;
    sub.pendingBillingCycle = newCycle;
    sub.cancelAtPeriodEnd = false;
    await sub.save();

    await sendPlanDowngradeScheduledEmail({
      to: user.email,
      name: user.name,
      currentPlanName: getPlan(currentPlan).name,
      newPlanName: getPlan(newPlanId).name,
      effectiveAt: sub.currentPeriodEnd,
    });

    NotificationService.create({
      userId,
      type: "SUBSCRIPTION_DOWNGRADED",
      actionUrl: "/settings/billing",
      metadata: { newPlan: getPlan(newPlanId).name },
    });

    return { type: "downgrade", effectiveAt: sub.currentPeriodEnd };
  }


  return { type: "none" };
}




export async function addSeats(userId, additionalSeats) {
  const sub = await getOrCreateSubscription(userId);
  const user = await User.findById(userId).select("name email");
  const plan = getPlan(sub.plan);

  if (!["pro", "team"].includes(sub.plan)) {
    throw new Error("Seat management only available on Pro and Team plans");
  }

  const extraSeatPrice = plan.limits.extraSeatPriceMonthly;
  if (!extraSeatPrice)
    throw new Error("This plan does not support extra seats");


  const daysRemaining = daysUntil(sub.currentPeriodEnd);
  const totalDaysInPeriod = daysBetween(
    sub.currentPeriodStart,
    sub.currentPeriodEnd,
  );
  const proratedCents = Math.round(
    (daysRemaining / totalDaysInPeriod) * extraSeatPrice * additionalSeats,
  );

  const txRef = buildTxRef("seat");
  const invoice = await Invoice.create({
    userId,
    subscriptionId: sub._id,
    amount: proratedCents,
    currency: "USD",
    description: `${additionalSeats} extra seat(s) : prorated`,
    status: "pending",
    flutterwaveRef: txRef,
    customerName: user.name,
    customerEmail: user.email,
    seatDelta: additionalSeats,
    lineItems: [
      {
        description: `${additionalSeats} extra seat(s) prorated for ${daysRemaining} days`,
        amount: proratedCents,
      },
    ],
  });

  const savedMethod = await PaymentMethod.findOne({
    userId,
    isDefault: true,
    deletedAt: null,
  }).select("+flutterwaveToken");


  if (savedMethod?.flutterwaveToken && proratedCents > 0) {
    try {
      const fwTx = await chargeToken({
        token: savedMethod.flutterwaveToken,
        txRef,
        amount: centsToUsd(proratedCents),
        currency: savedMethod.currency || "USD",
        email: user.email,
        narration: `Docnine ${additionalSeats} extra seat(s)`,
      });


      invoice.status = "paid";
      invoice.paidAt = new Date();
      invoice.flutterwaveTxId = fwTx.id;
      invoice.paymentMethodSnapshot = buildPaymentMethodSnapshot(fwTx);
      await invoice.save();

      sub.extraSeats = (sub.extraSeats || 0) + additionalSeats;
      sub.seats = (sub.seats || 1) + additionalSeats;
      await sub.save();

      return {
        type: "immediate",
        extraSeats: sub.extraSeats,
        totalSeats: sub.seats,
      };
    } catch (tokenErr) {

      console.warn(
        "[addSeats] Token charge failed, falling back to payment link:",
        tokenErr.message,
      );
      invoice.status = "void";
      await invoice.save();
    }
  }


  const redirectTxRef = buildTxRef("seat");
  await Invoice.create({
    userId,
    subscriptionId: sub._id,
    amount: proratedCents,
    currency: "USD",
    description: `${additionalSeats} extra seat(s) : prorated`,
    status: "pending",
    flutterwaveRef: redirectTxRef,
    customerName: user.name,
    customerEmail: user.email,
    seatDelta: additionalSeats,
    lineItems: [
      {
        description: `${additionalSeats} extra seat(s) prorated for ${daysRemaining} days`,
        amount: proratedCents,
      },
    ],
  });

  const { paymentLink } = await initializePayment({
    txRef: redirectTxRef,
    amount: centsToUsd(proratedCents),
    currency: "USD",
    email: user.email,
    name: user.name,

    redirectUrl: `${process.env.FRONTEND_URL}/billing?intent=seats&ref=${redirectTxRef}`,
  });

  return { type: "payment_required", paymentLink };
}




export async function cancelSubscription(userId, reason) {
  const sub = await getOrCreateSubscription(userId);
  const user = await User.findById(userId).select("name email");

  if (sub.status === "free") {
    throw new Error("No active subscription to cancel");
  }

  sub.cancelAtPeriodEnd = true;
  sub.cancelledAt = new Date();
  sub.lastBillingNote = reason || "User requested cancellation";
  await sub.save();

  await sendCancellationConfirmEmail({
    to: user.email,
    name: user.name,
    planName: getPlan(sub.plan).name,
    accessUntil: sub.currentPeriodEnd,
  });

  return { cancelledAt: sub.cancelledAt, accessUntil: sub.currentPeriodEnd };
}


export async function pauseSubscription(userId, months = 1) {
  const sub = await getOrCreateSubscription(userId);
  if (sub.status !== "active") {
    throw new Error("Only active subscriptions can be paused");
  }
  const pauseEndsAt = addMonths(new Date(), Math.min(months, 2));
  sub.status = "paused";
  sub.pausedAt = new Date();
  sub.pauseEndsAt = pauseEndsAt;
  await sub.save();
  return { pauseEndsAt };
}




export async function renewSubscription(subscriptionId) {
  const sub = await Subscription.findById(subscriptionId);
  if (!sub) throw new Error("Subscription not found");

  const user = await User.findById(sub.userId).select("name email");
  const plan = getPlan(sub.plan);

  const amountCents = computeCheckoutAmount({
    planId: sub.plan,
    cycle: sub.billingCycle,
    seats: sub.seats,
  });

  const savedMethod = await PaymentMethod.findOne({
    userId: sub.userId,
    isDefault: true,
    deletedAt: null,
  }).select("+flutterwaveToken");

  if (!savedMethod?.flutterwaveToken) {

    await startDunning(sub);
    return { success: false, reason: "no_payment_method" };
  }

  const txRef = buildTxRef("renewal");
  const invoice = await Invoice.create({
    userId: sub.userId,
    subscriptionId: sub._id,
    amount: amountCents,
    currency: "USD",
    description: buildInvoiceDescription(sub.plan, sub.billingCycle, sub.seats),
    status: "pending",
    flutterwaveRef: txRef,
    customerName: user.name,
    customerEmail: user.email,
    periodStart: sub.currentPeriodEnd,
    periodEnd: addPeriod(sub.currentPeriodEnd, sub.billingCycle),
    lineItems: buildLineItems(sub.plan, sub.billingCycle, sub.seats),
  });

  try {
    const fwTx = await chargeToken({
      token: savedMethod.flutterwaveToken,
      txRef,
      amount: centsToUsd(amountCents),
      currency: savedMethod.currency || "USD",
      email: user.email,
      narration: `Docnine ${plan.name} renewal`,
    });

    invoice.status = "paid";
    invoice.paidAt = new Date();
    invoice.flutterwaveTxId = fwTx.id;
    invoice.paymentMethodSnapshot = buildPaymentMethodSnapshot(fwTx);
    await invoice.save();

    const newPeriodEnd = addPeriod(sub.currentPeriodEnd, sub.billingCycle);
    sub.currentPeriodStart = sub.currentPeriodEnd;
    sub.currentPeriodEnd = newPeriodEnd;
    sub.status = "active";
    sub.dunningAttemptCount = 0;
    sub.dunningStartedAt = null;
    await sub.save();

    await sendPaymentReceiptEmail({
      to: user.email,
      name: user.name,
      invoiceNumber: invoice.invoiceNumber,
      amount: centsToUsd(amountCents),
      description: invoice.description,
      paidAt: invoice.paidAt,
    });

    return { success: true };
  } catch {
    invoice.status = "failed";
    await invoice.save();
    await startDunning(sub);
    return { success: false, reason: "charge_failed" };
  }
}




export async function applyScheduledDowngrade(subscriptionId) {
  const sub = await Subscription.findById(subscriptionId);
  if (!sub) return;

  if (sub.cancelAtPeriodEnd) {

    sub.plan = "free";
    sub.billingCycle = null;
    sub.status = "free";
    sub.currentPeriodEnd = null;
    sub.cancelAtPeriodEnd = false;
    sub.cancelledAt = null;
  } else if (sub.pendingPlan) {

    sub.plan = sub.pendingPlan;
    sub.billingCycle = sub.pendingBillingCycle || sub.billingCycle;
    sub.pendingPlan = null;
    sub.pendingBillingCycle = null;

  }

  await sub.save();
}




export async function countTeamBillableSeats(userId) {
  const { Project } = await import("../models/Project.js");
  const { ProjectShare } = await import("../models/ProjectShare.js");


  const projects = await Project.find({ userId }).select("_id").lean();
  if (projects.length === 0) return 1;

  const projectIds = projects.map((p) => p._id);


  const shares = await ProjectShare.find(
    { projectId: { $in: projectIds }, status: "accepted" },
    "inviteeUserId",
  ).lean();


  const uniqueUserIds = new Set(
    shares.map((s) => s.inviteeUserId).filter(Boolean),
  );


  return 1 + uniqueUserIds.size;
}


export function computeTeamPlanCharge({
  currentSeats,
  newSeats,
  cycleStartDate,
  cycleEndDate,
  daysRemaining,
  include_proration = true,
}) {
  const TEAM_MONTHLY_RATE = 1200;
  const totalDaysInCycle = daysBetween(cycleStartDate, cycleEndDate);

  if (!include_proration) {

    const chargeCents = Math.round(newSeats * TEAM_MONTHLY_RATE);
    return {
      creditCents: 0,
      chargeCents,
      netChargeCents: chargeCents,
      explanation: {
        currentSeats,
        newSeats,
        daysRemaining,
        totalDaysInCycle,
        prorationType: "no_proration",
      },
    };
  }


  const dailyRatePerSeat = TEAM_MONTHLY_RATE / totalDaysInCycle;
  const creditCents = Math.round(
    currentSeats * dailyRatePerSeat * daysRemaining,
  );
  const chargeCents = Math.round(newSeats * dailyRatePerSeat * daysRemaining);
  const netChargeCents = chargeCents - creditCents;

  console.log(
    `[team-billing] Seat adjustment: ${currentSeats} → ${newSeats} seats ` +
      `| ${daysRemaining}/${totalDaysInCycle} days remaining ` +
      `| credit: ${creditCents}¢ ($${(creditCents / 100).toFixed(2)}) ` +
      `| charge: ${chargeCents}¢ ($${(chargeCents / 100).toFixed(2)}) ` +
      `| net: ${netChargeCents}¢ ($${(netChargeCents / 100).toFixed(2)})`,
  );

  return {
    creditCents,
    chargeCents,
    netChargeCents,
    explanation: {
      currentSeats,
      newSeats,
      seatDelta: newSeats - currentSeats,
      daysRemaining,
      totalDaysInCycle,
      dailyRatePerSeat,
      prorationType: "mid_cycle_team_seat",
    },
  };
}


export async function syncTeamSeatsAndBilling(projectId, projectOwnerId) {
  const sub = await getOrCreateSubscription(projectOwnerId);
  if (sub.plan !== "team") return null;

  const previousSeats = sub.seats || 1;
  const currentSeats = await countTeamBillableSeats(projectOwnerId);

  console.log(
    `[team-sync] Project ${projectId}: ${projectOwnerId} seats ${previousSeats} → ${currentSeats}`,
  );

  if (currentSeats === previousSeats) return null;


  const daysRemaining = daysUntil(sub.currentPeriodEnd);

  const proration = computeTeamPlanCharge({
    currentSeats: previousSeats,
    newSeats: currentSeats,
    cycleStartDate: sub.currentPeriodStart,
    cycleEndDate: sub.currentPeriodEnd,
    daysRemaining,
    include_proration: true,
  });


  sub.seats = currentSeats;
  await sub.save();

  console.log(`[team-sync] Updated subscription seats to ${currentSeats}`);


  if (proration.netChargeCents <= 0) {
    console.log(
      `[team-sync] No charge needed (net: ${proration.netChargeCents}¢)`,
    );
    return { previousSeats, currentSeats, proration, invoiceCreated: false };
  }


  const txRef = buildTxRef("team_seat");
  const user = await User.findById(projectOwnerId).select("name email");

  const invoice = await Invoice.create({
    userId: projectOwnerId,
    subscriptionId: sub._id,
    type: "team_seat_adjustment",
    planId: "team",
    amountCents: proration.netChargeCents,
    amount: proration.netChargeCents,
    currency: "USD",
    seatDelta: currentSeats - previousSeats,
    description: `Team plan: +${currentSeats - previousSeats} collaborator(s)`,
    status: "pending",
    flutterwaveRef: txRef,
    customerName: user.name,
    customerEmail: user.email,
    periodStart: new Date(),
    periodEnd: sub.currentPeriodEnd,
    lineItems: [
      {
        description: `Team plan seat adjustment: ${previousSeats} → ${currentSeats} seats (prorated ${daysRemaining} days)`,
        amount: proration.netChargeCents,
      },
    ],
    prorationType: "mid_cycle_team_seat",
    metadata: { proration: proration.explanation, projectId },
  });

  console.log(
    `[team-sync] Created invoice ${invoice._id} for ${proration.netChargeCents}¢`,
  );

  return {
    previousSeats,
    currentSeats,
    proration,
    invoiceCreated: true,
    invoiceId: invoice._id,
  };
}




export async function upsertPaymentMethod({ userId, fwTx, token }) {
  const card = fwTx?.card;
  const isCard = !!card?.last_4digits;
  const isMobileMoney = fwTx?.payment_type?.includes("mobile");

  const hasExisting = await PaymentMethod.countDocuments({
    userId,
    deletedAt: null,
  });

  const methodData = {
    userId,
    type: isCard ? "card" : isMobileMoney ? "mobile_money" : "bank_transfer",
    isDefault: hasExisting === 0,
    flutterwaveToken: token,
    currency: (fwTx?.currency || "USD").toUpperCase(),
  };

  if (isCard) {
    methodData.card = {
      last4: card.last_4digits,
      brand: card.type,
      expMonth: parseInt(card.expiry?.split("/")[0] || "12", 10),
      expYear: parseInt("20" + (card.expiry?.split("/")[1] || "99"), 10),
    };
  } else if (isMobileMoney) {
    const phone = fwTx?.customer?.phone_number;
    methodData.mobileMoney = {
      phone,
      network: fwTx?.payment_type?.toUpperCase(),
      country: detectCountry(phone),
    };
  }

  return PaymentMethod.findOneAndUpdate(
    {
      userId,
      "card.last4": methodData.card?.last4 || null,
      type: methodData.type,
    },
    { $set: methodData },
    { upsert: true, new: true },
  );
}




export async function getBillingHistory(userId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [invoices, total] = await Promise.all([
    Invoice.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Invoice.countDocuments({ userId }),
  ]);
  return { invoices, total, page, limit };
}




export async function generateInvoicePdf(invoiceId, requestingUserId) {
  const invoice = await Invoice.findOne({
    _id: invoiceId,
    userId: requestingUserId,
  });
  if (!invoice)
    throw Object.assign(new Error("Invoice not found"), { status: 404 });

  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);


    doc.fontSize(20).text("INVOICE", 50, 50);
    doc.fontSize(10).text(`Docnine`, 50, 80);
    doc.text(`Invoice #: ${invoice.invoiceNumber}`, 50, 95);
    doc.text(
      `Date: ${formatDate(invoice.paidAt || invoice.createdAt)}`,
      50,
      110,
    );


    const y = 160;
    doc.text(`Bill To:`, 50, y);
    if (invoice.companyName) doc.text(invoice.companyName, 50, y + 15);
    if (invoice.customerName) doc.text(invoice.customerName, 50, y + 30);
    if (invoice.customerEmail) doc.text(invoice.customerEmail, 50, y + 45);
    if (invoice.vatNumber) doc.text(`VAT: ${invoice.vatNumber}`, 50, y + 60);


    if (invoice.periodStart && invoice.periodEnd) {
      doc.text(
        `Period: ${formatDate(invoice.periodStart)} : ${formatDate(invoice.periodEnd)}`,
        50,
        y + 80,
      );
    }


    const tableTop = 280;
    doc.fontSize(10).text("Description", 50, tableTop, { bold: true });
    doc.text("Amount", 450, tableTop);
    doc
      .moveTo(50, tableTop + 15)
      .lineTo(550, tableTop + 15)
      .stroke();

    let row = tableTop + 25;
    for (const item of invoice.lineItems) {
      doc.text(item.description, 50, row);
      doc.text(`$${centsToUsd(item.amount).toFixed(2)}`, 450, row);
      row += 20;
    }


    doc
      .moveTo(50, row + 5)
      .lineTo(550, row + 5)
      .stroke();
    doc
      .fontSize(12)
      .text(
        `Total: $${centsToUsd(invoice.amount).toFixed(2)} USD`,
        400,
        row + 15,
      );


    doc
      .fontSize(10)
      .text(`Status: ${invoice.status.toUpperCase()}`, 50, row + 30);
    if (invoice.paymentMethodSnapshot) {
      doc.text(`Paid via: ${invoice.paymentMethodSnapshot}`, 50, row + 45);
    }

    doc.end();
  });
}



export async function startDunning(sub) {
  sub.status = "past_due";
  sub.dunningAttemptCount = 0;
  sub.dunningStartedAt = new Date();
  await sub.save();
}

export async function downgradeToFree(sub) {
  sub.plan = "free";
  sub.billingCycle = null;
  sub.status = "free";
  sub.currentPeriodEnd = null;
  sub.dunningAttemptCount = 0;
  sub.dunningStartedAt = null;
  await sub.save();
}



function computeCheckoutAmount({ planId, cycle, seats }) {
  const plan = getPlan(planId);
  if (cycle === "annual") return computeAnnualTotal(planId, seats);
  return computeMonthlyPrice(planId, "monthly", seats);
}

function buildInvoiceDescription(planId, cycle, seats) {
  const plan = getPlan(planId);
  const cycleLabel = cycle === "annual" ? "Annual" : "Monthly";
  if (planId === "team") {
    return `${plan.name} Plan : ${cycleLabel} (${seats} seat${seats > 1 ? "s" : ""})`;
  }
  return `${plan.name} Plan : ${cycleLabel}`;
}

function buildLineItems(planId, cycle, seats) {
  const plan = getPlan(planId);
  const items = [];
  const basePrice = plan.prices[cycle];

  if (planId === "team") {
    items.push({
      description: `${plan.name} Plan : ${seats} seat(s)`,
      amount: basePrice * seats * (cycle === "annual" ? 12 : 1),
    });
  } else {
    items.push({
      description: `${plan.name} Plan`,
      amount: cycle === "annual" ? plan.prices.annualTotal : basePrice,
    });
  }
  return items;
}

function calculateProration(sub, newPlanId, newCycle, seats) {
  if (!sub.currentPeriodEnd) {
    return computeCheckoutAmount({ planId: newPlanId, cycle: newCycle, seats });
  }

  const daysRemaining = daysUntil(sub.currentPeriodEnd);
  const totalDays = daysBetween(sub.currentPeriodStart, sub.currentPeriodEnd);


  const oldDailyRate =
    computeMonthlyPrice(sub.plan, sub.billingCycle || "monthly", sub.seats) /
    totalDays;
  const newDailyRate =
    computeMonthlyPrice(newPlanId, newCycle, seats) / totalDays;

  const credit = Math.round(oldDailyRate * daysRemaining);
  const newCharge = Math.round(newDailyRate * daysRemaining);
  const prorated = newCharge - credit;


  console.log(
    `[proration] ${sub.plan}(${sub.billingCycle || "monthly"}) → ${newPlanId}(${newCycle}) | ` +
      `oldRate: ${oldDailyRate}/day, newRate: ${newDailyRate}/day, ` +
      `daysRemaining: ${daysRemaining}, credit: ${credit}¢, newCharge: ${newCharge}¢, prorated: ${prorated}¢`,
  );

  return prorated;
}

function addPeriod(date, cycle) {
  const d = new Date(date);
  if (cycle === "annual") {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setMonth(d.getMonth() + 1);
  }
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function endOfMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(date) {
  const ms = new Date(date) - new Date();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function daysBetween(a, b) {
  const ms = Math.abs(new Date(b) - new Date(a));
  return Math.ceil(ms / (1000 * 60 * 60 * 24)) || 30;
}

function formatDate(date) {
  if (!date) return ":";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function detectCountry(phone) {
  if (!phone) return null;
  if (phone.startsWith("+250")) return "RW";
  if (phone.startsWith("+256")) return "UG";
  if (phone.startsWith("+233")) return "GH";
  if (phone.startsWith("+254")) return "KE";
  if (phone.startsWith("+255")) return "TZ";
  if (phone.startsWith("+234")) return "NG";
  return null;
}
