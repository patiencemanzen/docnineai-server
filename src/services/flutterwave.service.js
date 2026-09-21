
import axios from "axios";
import crypto from "crypto";

const FLW_BASE = "https://api.flutterwave.com/v3";

function getSecretKey() {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY is not configured");
  return key;
}

function flwClient() {
  return axios.create({
    baseURL: FLW_BASE,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
    },
    timeout: 15_000,
  });
}



function handleFLWError(err, context) {
  const status = err.response?.status;
  const msg =
    err.response?.data?.message ||
    err.response?.data?.error ||
    err.message ||
    "Flutterwave error";
  console.error(`[FLW:${context}] ${status || ""} ${msg}`);
  const error = new Error(msg);
  error.flwStatus = status;
  throw error;
}




export async function initializePayment({
  txRef,
  amount,
  currency = "USD",
  email,
  name,
  phone,
  planId,
  redirectUrl,
}) {
  const client = flwClient();
  try {
    const isRWF = currency === "RWF";


    const payment_options = isRWF ? "card, mobilemoneyrwanda" : "card";

    const { data } = await client.post("/payments", {
      tx_ref: txRef,
      amount,
      currency,
      redirect_url:
        redirectUrl || `${process.env.FRONTEND_URL}/billing?status=paid`,
      payment_options,
      customer: { email, name, phonenumber: phone || undefined },
      customizations: {
        title: "Docnine",
        description: `Subscribe to ${planId} plan`,
        logo: `${process.env.FRONTEND_URL}/logo-light.png`,
      },
      meta: { plan: planId },
    });
    return { paymentLink: data.data.link };
  } catch (err) {
    handleFLWError(err, "initializePayment");
  }
}




export async function verifyTransaction(transactionId) {
  const client = flwClient();
  try {
    const { data } = await client.get(`/transactions/${transactionId}/verify`);
    return data.data;
  } catch (err) {
    handleFLWError(err, "verifyTransaction");
  }
}


export async function verifyByRef(txRef) {
  const client = flwClient();
  try {
    const { data } = await client.get("/transactions", {
      params: { tx_ref: txRef },
    });
    const transactions = data.data;
    if (!transactions || transactions.length === 0) {
      throw new Error(`No transaction found for tx_ref: ${txRef}`);
    }
    return transactions[0];
  } catch (err) {
    handleFLWError(err, "verifyByRef");
  }
}




export async function chargeToken({
  token,
  txRef,
  amount,
  currency = "USD",
  email,
  narration,
}) {
  const client = flwClient();
  try {
    const { data } = await client.post("/charges?type=tokenized", {
      token,
      tx_ref: txRef,
      amount,
      currency,
      email,
      narration,
    });
    if (data.data?.status === "successful") {
      return data.data;
    }
    const error = new Error(
      data.data?.processor_response || data.message || "Charge failed",
    );
    error.flwStatus = 400;
    throw error;
  } catch (err) {
    if (err.flwStatus) throw err;
    handleFLWError(err, "chargeToken");
  }
}




export async function refundTransaction(transactionId, amount) {
  const client = flwClient();
  try {
    const body = {};
    if (amount !== undefined) body.amount = amount;
    const { data } = await client.post(
      `/transactions/${transactionId}/refund`,
      body,
    );
    return data.data;
  } catch (err) {
    handleFLWError(err, "refundTransaction");
  }
}



let _loggedMissingFlwHash = false;

function isConfiguredWebhookHash(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "...") return false;
  return true;
}


export function verifyWebhookSignature(headerHash) {
  const expected = process.env.FLW_WEBHOOK_HASH;
  if (!isConfiguredWebhookHash(expected)) {
    if (!_loggedMissingFlwHash) {
      console.error(
        "[FLW] FLW_WEBHOOK_HASH is missing or a placeholder. " +
          "Rejecting all billing webhooks until a real secret is set.",
      );
      _loggedMissingFlwHash = true;
    }
    return false;
  }
  if (!headerHash || typeof headerHash !== "string") return false;

  const a = Buffer.from(headerHash);
  const b = Buffer.from(expected.trim());
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}




export function centsToUsd(cents) {
  return parseFloat((cents / 100).toFixed(2));
}


export function buildTxRef(prefix = "sub") {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}


export function extractChargeToken(fwTransaction) {
  return fwTransaction?.card?.token || fwTransaction?.account_token || null;
}


export function buildPaymentMethodSnapshot(fwTransaction) {
  const card = fwTransaction?.card;
  if (card?.last_4digits) {
    return `${card.type || "Card"} ****${card.last_4digits}`;
  }
  const phone = fwTransaction?.customer?.phone_number;
  const network = fwTransaction?.payment_type;
  if (phone) {
    return `${network || "Mobile Money"} ${phone}`;
  }
  return fwTransaction?.payment_type || "Bank Transfer";
}
