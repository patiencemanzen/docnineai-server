// =============================================================
// Bitbucket OAuth Controller
// =============================================================

import * as bitbucketOAuthService from "../../services/bitbucket/bitbucket-oauth.service.js";
import * as bitbucketService from "../../../services/bitbucket.service.js";
import { User } from "../../../models/User.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";
import { sendOAuthPopupResult } from "../../../utils/oauth-popup.util.js";

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
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return sendOAuthPopupResult(res, {
      provider: "bitbucket",
      status: "error",
      message: `Bitbucket denied access: ${oauthError}`,
    });
  }

  if (!code || !state) {
    return sendOAuthPopupResult(res, {
      provider: "bitbucket",
      status: "error",
      message: "Missing code or state : please try again.",
    });
  }

  try {
    const result = await bitbucketOAuthService.handleOAuthCallback({
      code,
      state,
    });
    return sendOAuthPopupResult(res, {
      provider: "bitbucket",
      status: "success",
      user: result.bitbucketUsername,
    });
  } catch (err) {
    return sendOAuthPopupResult(res, {
      provider: "bitbucket",
      status: "error",
      message: err.message || "Bitbucket connection failed.",
    });
  }
}

export async function listRepos(req, res) {
  try {
    // Query User to get the encrypted token (auth middleware only sets userId/email)
    const user = await User.findById(req.user.userId).select("+ bitbucketTokenEncrypted");
    if (!user || !user.bitbucketTokenEncrypted) {
      console.log("[bitbucket.controller] No Bitbucket token found for user", {
        userId: req.user.userId,
      });
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

    console.log("[bitbucket.controller] Fetching repos from Bitbucket service", {
      page,
      perPage,
      userId: req.user.userId,
    });

    const result = await bitbucketService.listUserRepos(token, page, perPage);

    console.log("[bitbucket.controller] Successfully fetched Bitbucket repos", {
      count: result.length,
      hasNextPage: result.length === perPage,
    });

    return ok(res, {
      repos: result,
      page,
      perPage,
      hasNextPage: result.length === perPage,
    });
  } catch (err) {
    console.error("[bitbucket.controller] Error in listRepos", {
      error_code: err.code,
      error_message: err.message,
      error_status: err.response?.status,
      user_id: req.user.userId,
    });
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
