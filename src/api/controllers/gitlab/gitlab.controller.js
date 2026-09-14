// =============================================================
// GitLab OAuth Controller
// =============================================================

import * as gitlabOAuthService from "../../services/gitlab/gitlab-oauth.service.js";
import * as gitlabService from "../../../services/gitlab.service.js";
import { User } from "../../../models/User.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";
import { sendOAuthPopupResult } from "../../../utils/oauth-popup.util.js";

export async function oauthStart(req, res) {
  try {
    const url = gitlabOAuthService.buildOAuthUrl(req.user.userId);
    return ok(res, { url }, "Redirect to this URL to authorise GitLab access.");
  } catch (err) {
    if (err.message?.includes("GITLAB")) {
      return fail(res, "GITLAB_NOT_CONFIGURED", err.message, 503);
    }
    return serverError(res, err, "oauthStart");
  }
}

export async function oauthCallback(req, res) {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return sendOAuthPopupResult(res, {
      provider: "gitlab",
      status: "error",
      message: `GitLab denied access: ${oauthError}`,
    });
  }

  if (!code || !state) {
    return sendOAuthPopupResult(res, {
      provider: "gitlab",
      status: "error",
      message: "Missing code or state : please try again.",
    });
  }

  try {
    const result = await gitlabOAuthService.handleOAuthCallback({
      code,
      state,
    });
    return sendOAuthPopupResult(res, {
      provider: "gitlab",
      status: "success",
      user: result.gitlabUsername,
    });
  } catch (err) {
    return sendOAuthPopupResult(res, {
      provider: "gitlab",
      status: "error",
      message: err.message || "GitLab connection failed.",
    });
  }
}

function isExpiredTokenError(err) {
  return (
    err.response?.status === 401 &&
    (err.response?.data?.error === "invalid_token" ||
      err.response?.data?.error_description?.toLowerCase().includes("expired"))
  );
}

export async function listRepos(req, res) {
  try {
    // Query User to get the encrypted token (auth middleware only sets userId/email)
    const user = await User.findById(req.user.userId).select("+gitlabTokenEncrypted");
    if (!user || !user.gitlabTokenEncrypted) {
      console.log("[gitlab.controller] No GitLab token found for user", { 
        userId: req.user.userId 
      });
      return ok(res, { repos: [], hasNextPage: false });
    }

    let token = gitlabOAuthService.decryptProvidersToken(
      user.gitlabTokenEncrypted,
    );
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(req.query.perPage || "30", 10)),
    );

    console.log("[gitlab.controller] Fetching repos from GitLab service", {
      page,
      perPage,
      userId: req.user.userId,
    });

    let result;
    try {
      result = await gitlabService.listUserRepos(token, page, perPage);
    } catch (apiErr) {
      if (!isExpiredTokenError(apiErr)) throw apiErr;

      console.log("[gitlab.controller] Token expired : attempting refresh", {
        userId: req.user.userId,
      });
      try {
        token = await gitlabOAuthService.refreshAndStoreToken(req.user.userId);
      } catch (refreshErr) {
        return fail(res, refreshErr.code || "TOKEN_EXPIRED", refreshErr.message, 401);
      }
      result = await gitlabService.listUserRepos(token, page, perPage);
    }
    
    console.log("[gitlab.controller] Successfully fetched GitLab repos", {
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
    console.error("[gitlab.controller] Error in listRepos", {
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
    console.log("[GitLab Status] Checking connection for user", {
      userId: req.user.userId,
    });

    const user = await User.findById(req.user.userId).select("+gitlabTokenEncrypted");
    if (!user) {
      console.error("[GitLab Status] User not found", { userId: req.user.userId });
      return ok(res, { connected: false, gitlabUsername: null });
    }

    console.log("[GitLab Status] User found", {
      userId: user._id,
      hasTokenEncrypted: !!user.gitlabTokenEncrypted,
      gitlabUsername: user.gitlabUsername,
    });

    const hasConnection = !!user.gitlabTokenEncrypted;
    
    if (!hasConnection) {
      console.warn("[GitLab Status] No token found for user", {
        userId: user._id,
      });
    }

    return ok(res, {
      connected: hasConnection,
      gitlabUsername: user.gitlabUsername || null,
    });
  } catch (err) {
    console.error("[GitLab Status] Error checking connection", {
      message: err.message,
      userId: req.user.userId,
    });
    return serverError(res, err, "connectionStatus");
  }
}

export async function disconnect(req, res) {
  try {
    await gitlabOAuthService.disconnect(req.user.userId);
    return ok(res, {}, "GitLab disconnected successfully.");
  } catch (err) {
    return serverError(res, err, "disconnect");
  }
}
