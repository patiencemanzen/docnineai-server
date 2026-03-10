// =============================================================
// Azure DevOps OAuth Controller
// =============================================================

import * as azureOAuthService from "./azure-oauth.service.js";
import * as azureService from "../../services/azure-devops.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

export async function oauthStart(req, res) {
  try {
    const url = azureOAuthService.buildOAuthUrl(req.user.userId);
    return ok(
      res,
      { url },
      "Redirect to this URL to authorise Azure DevOps access.",
    );
  } catch (err) {
    if (err.message?.includes("AZURE")) {
      return fail(res, "AZURE_NOT_CONFIGURED", err.message, 503);
    }
    return serverError(res, err, "oauthStart");
  }
}

export async function oauthCallback(req, res) {
  const frontendUrl = process.env.FRONTEND_URL || "";
  const { assertion, state, error: oauthError } = req.query;

  if (oauthError) {
    const msg = encodeURIComponent(`Azure DevOps denied access: ${oauthError}`);
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=error&msg=${msg}`,
    );
  }

  if (!assertion || !state) {
    const msg = encodeURIComponent(
      "Missing assertion or state — please try again.",
    );
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=error&msg=${msg}`,
    );
  }

  try {
    const { azureUsername } = await azureOAuthService.handleOAuthCallback({
      assertion,
      state,
    });
    const user = encodeURIComponent(azureUsername);
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=connected&user=${user}`,
    );
  } catch (err) {
    const msg = encodeURIComponent(
      err.message || "Azure DevOps connection failed.",
    );
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=error&msg=${msg}`,
    );
  }
}

export async function listRepos(req, res) {
  try {
    const token = await azureOAuthService.decryptProvidersToken(
      req.user.azureDevOpsTokenEncrypted,
    );
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(req.query.perPage || "30", 10)),
    );

    const result = await azureService.listUserRepos(token, page, perPage);
    return ok(res, {
      repos: result,
      page,
      perPage,
      hasNextPage: result.length === perPage,
    });
  } catch (err) {
    return serverError(res, err, "listRepos");
  }
}

export async function connectionStatus(req, res) {
  try {
    const hasConnection = !!req.user.azureDevOpsTokenEncrypted;
    return ok(res, {
      connected: hasConnection,
      azureUsername: req.user.azureDevOpsUsername || null,
    });
  } catch (err) {
    return serverError(res, err, "connectionStatus");
  }
}

export async function disconnect(req, res) {
  try {
    await azureOAuthService.disconnect(req.user.userId);
    return ok(res, {}, "Azure DevOps disconnected successfully.");
  } catch (err) {
    return serverError(res, err, "disconnect");
  }
}
