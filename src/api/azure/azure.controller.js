// =============================================================
// Azure DevOps OAuth Controller
// =============================================================

import * as azureOAuthService from "./azure-oauth.service.js";
import * as azureService from "../../services/azure-devops.service.js";
import { User } from "../../models/User.js";
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
  const { code, state, error: oauthError } = req.query;

  console.log("[Azure OAuth] Callback received", {
    hasCode: !!code,
    hasState: !!state,
    hasError: !!oauthError,
  });

  if (oauthError) {
    console.warn("[Azure OAuth] OAuth error from Azure", oauthError);
    const msg = encodeURIComponent(`Azure DevOps denied access: ${oauthError}`);
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=error&msg=${msg}`,
    );
  }

  if (!code || !state) {
    console.error("[Azure OAuth] Missing code or state");
    const msg = encodeURIComponent(
      "Missing code or state — please try again.",
    );
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=error&msg=${msg}`,
    );
  }

  try {
    console.log("[Azure OAuth] Exchanging code for token...");
    const result = await azureOAuthService.handleOAuthCallback({
      code,
      state,
    });
    console.log("[Azure OAuth] Successfully stored token", {
      azureUsername: result.azureUsername,
      userId: result.userId,
    });
    const user = encodeURIComponent(result.azureUsername);
    return res.redirect(
      `${frontendUrl}/azure/oauth/complete?azure=connected&user=${user}`,
    );
  } catch (err) {
    console.error("[Azure OAuth] Callback failed", {
      code: err.code,
      message: err.message,
      status: err.status,
    });
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
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(req.query.perPage || "30", 10)),
    );
    console.log("[Azure.controller] Fetching repos from service", {
      userId: req.user.userId,
      page,
      perPage,
    });

    // Query User to get the encrypted token (auth middleware only sets userId/email)
    const user = await User.findById(req.user.userId).select(
      "+azureDevOpsTokenEncrypted",
    );

    if (!user || !user.azureDevOpsTokenEncrypted) {
      console.warn("[Azure.controller] No Azure DevOps token found for user", {
        userId: req.user.userId,
        hasUser: !!user,
        hasToken: user ? !!user.azureDevOpsTokenEncrypted : false,
      });
      return ok(res, { repos: [], hasNextPage: false });
    }

    const token = await azureOAuthService.decryptProvidersToken(
      user.azureDevOpsTokenEncrypted,
    );

    const result = await azureService.listUserRepos(token, page, perPage);
    console.log("[Azure.controller] Successfully fetched repos", {
      count: result.length,
      page,
      perPage,
    });
    if (result.length > 0) {
      console.log("[Azure.controller] First repo sample", {
        id: result[0].id,
        name: result[0].name,
        webUrl: result[0].webUrl,
      });
    }
    return ok(res, {
      repos: result,
      page,
      perPage,
      hasNextPage: result.length === perPage,
    });
  } catch (err) {
    console.error("[Azure.controller] Failed to fetch repos", {
      userId: req.user.userId,
      errorCode: err.code,
      errorMessage: err.message,
      status: err.status,
    });
    return serverError(res, err, "listRepos");
  }
}

export async function connectionStatus(req, res) {
  try {
    console.log("[Azure Status] Checking connection for user", {
      userId: req.user.userId,
    });

    const user = await User.findById(req.user.userId).select(
      "+azureDevOpsTokenEncrypted",
    );
    if (!user) {
      console.error("[Azure Status] User not found", {
        userId: req.user.userId,
      });
      return ok(res, { connected: false, azureUsername: null });
    }

    console.log("[Azure Status] User found", {
      userId: user._id,
      hasTokenEncrypted: !!user.azureDevOpsTokenEncrypted,
      azureDevOpsUsername: user.azureDevOpsUsername,
    });

    const hasConnection = !!user.azureDevOpsTokenEncrypted;

    if (!hasConnection) {
      console.warn("[Azure Status] No token found for user", {
        userId: user._id,
      });
    }

    return ok(res, {
      connected: hasConnection,
      azureUsername: user.azureDevOpsUsername || null,
    });
  } catch (err) {
    console.error("[Azure Status] Error checking connection", {
      message: err.message,
      userId: req.user.userId,
    });
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
