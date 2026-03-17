// =============================================================
// GitLab OAuth Controller
// =============================================================

import * as gitlabOAuthService from "./gitlab-oauth.service.js";
import * as gitlabService from "../../services/gitlab.service.js";
import { User } from "../../models/User.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

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
  const frontendUrl = process.env.FRONTEND_URL || "";
  const { code, state, error: oauthError } = req.query;

  console.log("[GitLab OAuth] Callback received", {
    hasCode: !!code,
    hasState: !!state,
    hasError: !!oauthError,
  });

  if (oauthError) {
    console.warn("[GitLab OAuth] OAuth error from GitLab", oauthError);
    const msg = encodeURIComponent(`GitLab denied access: ${oauthError}`);
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=error&msg=${msg}`,
    );
  }

  if (!code || !state) {
    console.error("[GitLab OAuth] Missing code or state");
    const msg = encodeURIComponent("Missing code or state — please try again.");
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=error&msg=${msg}`,
    );
  }

  try {
    console.log("[GitLab OAuth] Exchanging code for token...");
    const result = await gitlabOAuthService.handleOAuthCallback({
      code,
      state,
    });
    console.log("[GitLab OAuth] Successfully stored token", {
      gitlabUsername: result.gitlabUsername,
      userId: result.userId,
    });

    const user = encodeURIComponent(result.gitlabUsername);
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=connected&user=${user}`,
    );
  } catch (err) {
    console.error("[GitLab OAuth] Callback failed", {
      code: err.code,
      message: err.message,
      status: err.status,
    });
    const msg = encodeURIComponent(err.message || "GitLab connection failed.");
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=error&msg=${msg}`,
    );
  }
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

    const token = await gitlabOAuthService.decryptProvidersToken(
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

    const result = await gitlabService.listUserRepos(token, page, perPage);
    
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
