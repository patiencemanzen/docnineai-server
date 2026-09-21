import { serverError } from "../../../utils/response.util.js";

let _handleGlobalWebhook = null;
let _handleFlutterwaveWebhook = null;

export function registerWebhookHandlers(globalHook, flutterwaveHook) {
  if (globalHook) _handleGlobalWebhook = globalHook;
  if (flutterwaveHook) _handleFlutterwaveWebhook = flutterwaveHook;
}

export async function handleWebhook(req, res) {
  if (!_handleGlobalWebhook) {
    return res.status(503).json({
      error: "Webhook service unavailable",
      status: "offline",
    });
  }

  try {
    const payload = req.body;
    const rawSig = req.headers["x-hub-signature-256"];
    const signature = Array.isArray(rawSig) ? rawSig[0] : rawSig || "";

    const rawEvent = req.headers["x-github-event"];
    const githubEvent = Array.isArray(rawEvent) ? rawEvent[0] : rawEvent || "";

    const result = await _handleGlobalWebhook({
      payload,
      signature,
      githubEvent,
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error("[webhook] Unhandled error:", err.message, err.stack);
    return serverError(res, err, "handleWebhook", "Failed to process webhook");
  }
}

export async function handleFlutterwaveWebhook(req, res) {
  if (!_handleFlutterwaveWebhook) {
    return res.status(503).json({
      error: "Billing webhook service unavailable",
      status: "offline",
    });
  }

  try {
    await _handleFlutterwaveWebhook(req, res);
  } catch (err) {
    console.error("[webhook:flutterwave] Unhandled error:", err.message, err.stack);
    return serverError(res, err, "handleFlutterwaveWebhook", "Failed to process billing webhook");
  }
}
