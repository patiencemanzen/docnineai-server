import { verifyWebhookSignature } from "../../../services/flutterwave.service.js";
import { verifyTransaction } from "../../../services/flutterwave.service.js";
import {
  activateFromPayment,
  downgradeToFree,
  startDunning,
} from "../../../services/billing.service.js";
import { Subscription } from "../../../models/Subscription.js";
import { Invoice } from "../../../models/Invoice.js";
import { sendAccountDowngradedEmail } from "../../../config/email.js";
import { User } from "../../../models/User.js";

export async function handleFlutterwaveWebhook(req, res) {
  const headerHash = req.headers["verif-hash"];
  if (!verifyWebhookSignature(headerHash)) {
    console.warn("[fw-webhook] Invalid verif-hash : rejecting");
    return res.status(401).json({ error: "Unauthorized" });
  }

  let payload;
  try {
    const raw = req.body;
    const json = Buffer.isBuffer(raw) ? raw.toString("utf8") : JSON.stringify(raw);
    payload = JSON.parse(json);
  } catch {
    console.error("[fw-webhook] Failed to parse body");
    return res.status(400).json({ error: "Bad request" });
  }

  const event = payload.event;
  const data = payload.data;

  console.log(`[fw-webhook] Event: ${event}`);

  res.status(200).json({ received: true });

  try {
    switch (event) {
      case "charge.completed":
        await handleChargeCompleted(data);
        break;

      case "subscription.renewed":
        await handleSubscriptionRenewed(data);
        break;

      case "subscription.cancelled":
        await handleSubscriptionCancelled(data);
        break;

      case "payment.failed":
        await handlePaymentFailed(data);
        break;

      case "refund.completed":
        await handleRefundCompleted(data);
        break;

      case "subscription.expiry_reminder":
        console.log("[fw-webhook] subscription.expiry_reminder received (handled by cron)");
        break;

      default:
        console.log(`[fw-webhook] Unhandled event type: ${event}`);
    }
  } catch (err) {
    console.error(`[fw-webhook] PAYMENT PROCESSING ERROR : event: ${event}`, err);
  }
}

async function handleChargeCompleted(data) {
  if (data?.status !== "successful") {
    console.log(
      `[fw-webhook] charge.completed : status not successful (${data?.status}), ignoring`,
    );
    return;
  }

  const verified = await verifyTransaction(data.id);
  if (verified?.status !== "successful") {
    console.log(`[fw-webhook] Server-side verification failed for tx ${data.id}`);
    return;
  }

  await activateFromPayment(verified);
}

async function handleSubscriptionRenewed(data) {
  if (data?.status !== "successful") return;

  const txRef = data.tx_ref;
  if (!txRef) return;

  const invoice = await Invoice.findOne({ flutterwaveRef: txRef });
  if (!invoice || invoice.status === "paid") return;

  const verified = await verifyTransaction(data.id);
  if (verified?.status === "successful") {
    await activateFromPayment(verified);
  }
}

async function handleSubscriptionCancelled(data) {
  const customerId = data?.customer?.id;
  if (!customerId) return;

  const sub = await Subscription.findOne({ flutterwaveCustomerId: customerId });
  if (!sub) return;

  sub.cancelAtPeriodEnd = true;
  await sub.save();
}

async function handlePaymentFailed(data) {
  const txRef = data?.tx_ref || data?.txRef;
  if (!txRef) return;

  const invoice = await Invoice.findOne({ flutterwaveRef: txRef });
  if (!invoice) return;

  invoice.status = "failed";
  await invoice.save();

  const sub = await Subscription.findById(invoice.subscriptionId);
  if (sub && sub.status === "active") {
    await startDunning(sub);
    console.log(`[fw-webhook] Dunning started for sub ${sub._id}`);
  }
}

async function handleRefundCompleted(data) {
  const fwRefId = data?.id;
  if (!fwRefId) return;

  const invoice = await Invoice.findOne({
    flutterwaveTxId: data?.transaction_id,
  });
  if (!invoice) return;

  invoice.status = "refunded";
  invoice.refundedAt = new Date();
  await invoice.save();

  console.log(`[fw-webhook] Refund processed for invoice ${invoice.invoiceNumber}`);
}
