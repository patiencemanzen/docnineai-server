// =============================================================
// Bitbucket OAuth Controller
// =============================================================

import * as bitbucketOAuthService from "./bitbucket-oauth.service.js";
import * as bitbucketService from "../../services/bitbucket.service.js";
import { User } from "../../models/User.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

export async function oauthStart(req, res) {
  try {
    const url = bitbucketOAuthService.buildOAuthUrl(req.user.userId);
    return ok(
      res,
      { url },
      "Redirect to this URL to authorise Bitbucket access.",
    );
  } catch (err) {
    if (err.message?.includes("BITBUCKET")) {
      return fail(res, "BITBUCKET_NOT_CONFIGURED", err.message, 503);
    }
    return serverError(res, err, "oauthStart");
  }
}

export async function oauthCallback(req, res) {
  const frontendUrl = process.env.FRONTEND_URL || "";
  const { code, state, error: oauthError } = req.query;

  console.log("[Bitbucket OAuth] Callback received", {
    hasCode: !!code,
    hasState: !!state,
    hasError: !!oauthError,
  });

  if (oauthError) {
    console.warn("[Bitbucket OAuth] OAuth error from Bitbucket", oauthError);
    const msg = encodeURIComponent(`Bitbucket denied access: ${oauthError}`);
    return res.redirect(
      `${frontendUrl}/bitbucket/oauth/complete?bitbucket=error&msg=${msg}`,
    );
  }

  if (!code || !state) {
    console.error("[Bitbucket OAuth] Missing code or state");
    const msg = encodeURIComponent("Missing code or state — please try again.");
    return res.redirect(
      `${frontendUrl}/bitbucket/oauth/complete?bitbucket=error&msg=${msg}`,
    );
  }

  try {
    console.log("[Bitbucket OAuth] Exchanging code for token...");
    const result = await bitbucketOAuthService.handleOAuthCallback({
      code,
      state,
    });
    console.log("[Bitbucket OAuth] Successfully stored token", {
      bitbucketUsername: result.bitbucketUsername,
      userId: result.userId,
    });
    const user = encodeURIComponent(result.bitbucketUsername);
    return res.redirect(
      `${frontendUrl}/bitbucket/oauth/complete?bitbucket=connected&user=${user}`,
    );
  } catch (err) {
    console.error("[Bitbucket OAuth] Callback failed", {
      code: err.code,
      message: err.message,
      status: err.status,
    });
    const msg = encodeURIComponent(
      err.message || "Bitbucket connection failed.",
    );
    return res.redirect(
      `${frontendUrl}/bitbucket/oauth/complete?bitbucket=error&msg=${msg}`,
    );
  }
}

export async function listRepos(req, res) {
  try {
    // Query User to get the encrypted token (auth middleware only sets userId/email)
    const user = await User.findById(req.user.userId).select("+bitbucketTokenEncrypted");
    if (!user || !user.bitbucketTokenEncrypted) {
      return ok(res, { repos: [], hasNextPage: false });
    }

    const token = await bitbucketOAuthService.decryptProvidersToken(
      user.bitbucketTokenEncrypted,
    );
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(req.query.perPage || "30", 10)),
    );

    const result = await bitbucketService.listUserRepos(token, page, perPage);
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
    console.log("[Bitbucket Status] Checking connection for user", {
      userId: req.user.userId,
    });

    const user = await User.findById(req.user.userId).select("+bitbucketTokenEncrypted");
    if (!user) {
      console.error("[Bitbucket Status] User not found", { userId: req.user.userId });
      return ok(res, { connected: false, bitbucketUsername: null });
    }

    console.log("[Bitbucket Status] User found", {
      userId: user._id,
      hasTokenEncrypted: !!user.bitbucketTokenEncrypted,
      bitbucketUsername: user.bitbucketUsername,
    });

    const hasConnection = !!user.bitbucketTokenEncrypted;
    
    if (!hasConnection) {
      console.warn("[Bitbucket Status] No token found for user", {
        userId: user._id,
      });
    }

    return ok(res, {
      connected: hasConnection,
      bitbucketUsername: user.bitbucketUsername || null,
    });
  } catch (err) {
    console.error("[Bitbucket Status] Error checking connection", {
      message: err.message,
      userId: req.user.userId,
    });
    return serverError(res, err, "connectionStatus");
  }
}

export async function disconnect(req, res) {
  try {
    await bitbucketOAuthService.disconnect(req.user.userId);
    return ok(res, {}, "Bitbucket disconnected successfully.");
  } catch (err) {
    return serverError(res, err, "disconnect");
  }
}
