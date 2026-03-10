// =============================================================
// GitLab OAuth Controller
// =============================================================

import * as gitlabOAuthService from "./gitlab-oauth.service.js";
import * as gitlabService from "../../services/gitlab.service.js";
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

  if (oauthError) {
    const msg = encodeURIComponent(`GitLab denied access: ${oauthError}`);
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=error&msg=${msg}`,
    );
  }

  if (!code || !state) {
    const msg = encodeURIComponent("Missing code or state — please try again.");
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=error&msg=${msg}`,
    );
  }

  try {
    const { gitlabUsername } = await gitlabOAuthService.handleOAuthCallback({
      code,
      state,
    });
    const user = encodeURIComponent(gitlabUsername);
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=connected&user=${user}`,
    );
  } catch (err) {
    const msg = encodeURIComponent(err.message || "GitLab connection failed.");
    return res.redirect(
      `${frontendUrl}/gitlab/oauth/complete?gitlab=error&msg=${msg}`,
    );
  }
}

export async function listRepos(req, res) {
  try {
    const token = await gitlabOAuthService.decryptProvidersToken(
      req.user.gitlabTokenEncrypted,
    );
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(req.query.perPage || "30", 10)),
    );

    const result = await gitlabService.listUserRepos(token, page, perPage);
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
    const hasConnection = !!req.user.gitlabTokenEncrypted;
    return ok(res, {
      connected: hasConnection,
      gitlabUsername: req.user.gitlabUsername || null,
    });
  } catch (err) {
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
