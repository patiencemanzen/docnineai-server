
import * as authService from "../../services/auth/auth.service.js";
import * as cliAuthService from "../../services/auth/cli-auth.service.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";
import { getRefreshCookieOpts, denylistToken } from "../../../utils/jwt.util.js";


export async function signup(req, res) {
  const { name, email, password, agreeToTerms } = req.body;
  try {
    const { user } = await authService.signup({
      name,
      email,
      password,
      agreeToTerms,
    });
    return ok(
      res,
      { user },
      "Account created. Check your email to verify.",
      201,
    );
  } catch (err) {
    if (err.code === "EMAIL_TAKEN")
      return fail(res, err.code, err.message, err.status);
    if (err.code === "T_AND_C_REQUIRED")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "signup");
  }
}


export async function login(req, res) {
  const { email, password } = req.body;
  try {
    const { user, accessToken, refreshToken } = await authService.login({
      email,
      password,
    });
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return ok(res, { user, accessToken }, "Login successful");
  } catch (err) {
    if (err.code === "INVALID_CREDENTIALS")
      return fail(res, err.code, err.message, err.status);
    if (err.code === "EMAIL_NOT_VERIFIED" || err.code === "USE_OAUTH_PROVIDER")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "login");
  }
}


export async function logout(req, res) {
  try {
    await authService.logout(req.user.userId);

    res.clearCookie("refreshToken", { ...getRefreshCookieOpts(), maxAge: 0 });
    return ok(res, null, "Logged out successfully.");
  } catch (err) {
    return serverError(res, err, "logout");
  }
}


export async function cliLogout(req, res) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    if (token && !token.startsWith("docnine_")) {
      await denylistToken(token);
    }
    return ok(res, null, "Logged out successfully.");
  } catch (err) {

    return ok(res, null, "Logged out.");
  }
}


export async function refresh(req, res) {
  const token = req.cookies?.refreshToken;
  try {
    const { user, accessToken, refreshToken } =
      await authService.refreshSession(token);
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return ok(res, { user, accessToken }, "Token refreshed successfully.");
  } catch (err) {
    const KNOWN = [
      "NO_REFRESH_TOKEN",
      "INVALID_REFRESH_TOKEN",
      "REFRESH_TOKEN_REUSED",
    ];
    if (KNOWN.includes(err.code))
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "refresh");
  }
}


export async function verifyEmail(req, res) {
  const { token } = req.body;
  try {
    const user = await authService.verifyEmail(token);
    return ok(res, { email: user.email }, "Email verified successfully.");
  } catch (err) {
    if (err.code === "INVALID_VERIFICATION_TOKEN")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "verifyEmail");
  }
}


export async function forgotPassword(req, res) {
  const { email } = req.body;
  try {

    await authService.forgotPassword(email);
    return ok(
      res,
      null,
      "If that email is registered, a reset link has been sent.",
    );
  } catch (err) {
    return serverError(res, err, "forgotPassword");
  }
}


export async function resetPassword(req, res) {
  const { token, password } = req.body;
  try {
    await authService.resetPassword({ token, password });
    return ok(res, null, "Password reset successfully. Please log in again.");
  } catch (err) {
    if (err.code === "INVALID_RESET_TOKEN")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "resetPassword");
  }
}


export async function getMe(req, res) {
  try {
    const user = await authService.getMe(req.user.userId);
    return ok(res, { user });
  } catch (err) {
    if (err.code === "USER_NOT_FOUND")
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getMe");
  }
}


export async function updateProfile(req, res) {
  const { name, email } = req.body;
  try {
    const user = await authService.updateProfile(req.user.userId, {
      name,
      email,
    });
    return ok(res, { user }, "Profile updated successfully.");
  } catch (err) {
    if (["USER_NOT_FOUND", "EMAIL_TAKEN"].includes(err.code))
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "updateProfile");
  }
}


export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  try {
    await authService.changePassword(req.user.userId, {
      currentPassword,
      newPassword,
    });

    res.clearCookie("refreshToken", { ...getRefreshCookieOpts(), maxAge: 0 });
    return ok(res, null, "Password changed successfully. Please log in again.");
  } catch (err) {
    if (["USER_NOT_FOUND", "INVALID_CREDENTIALS"].includes(err.code))
      return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "changePassword");
  }
}


export function githubPopup(_req, res) {
  return res
    .status(410)
    .send("This popup entrypoint is gone. Open the OAuth URL from GET /github/oauth/start.");
}


export function githubLoginStart(req, res) {
  try {
    const url = authService.getGithubLoginUrl();
    return res.redirect(url);
  } catch (err) {
    if (err.code === "GITHUB_LOGIN_NOT_CONFIGURED")
      return fail(res, err.code, err.message, 503);
    return serverError(res, err, "githubLoginStart");
  }
}


export async function githubLoginCallback(req, res) {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "";

  if (error || !code) {
    return res.redirect(`${frontendUrl}/auth/callback?error=access_denied`);
  }

  try {
    const { refreshToken } =
      await authService.githubSocialLogin(code);
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return res.redirect(`${frontendUrl}/auth/callback`);
  } catch (err) {
    const knownCodes = [
      "GITHUB_CODE_INVALID",
      "GITHUB_NO_EMAIL",
      "GITHUB_LOGIN_NOT_CONFIGURED",
      "OAUTH_UNVERIFIED_ACCOUNT",
      "OAUTH_EMAIL_CONFLICT",
    ];
    const code_ = knownCodes.includes(err.code) ? err.code : "OAUTH_ERROR";
    return res.redirect(`${frontendUrl}/auth/callback?error=${code_}`);
  }
}


export function gitlabPopup(_req, res) {
  return res
    .status(410)
    .send("This popup entrypoint is gone. Open the OAuth URL from GET /gitlab/oauth/start.");
}


export function bitbucketPopup(_req, res) {
  return res
    .status(410)
    .send("This popup entrypoint is gone. Open the OAuth URL from GET /bitbucket/oauth/start.");
}


export function azurePopup(_req, res) {
  return res
    .status(410)
    .send("This popup entrypoint is gone. Open the OAuth URL from GET /azure/oauth/start.");
}


export function googleLoginStart(req, res) {
  try {
    const url = authService.getGoogleLoginUrl();
    return res.redirect(url);
  } catch (err) {
    if (err.code === "GOOGLE_LOGIN_NOT_CONFIGURED")
      return fail(res, err.code, err.message, 503);
    return serverError(res, err, "googleLoginStart");
  }
}


export async function googleLoginCallback(req, res) {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error || !code) {
    return res.redirect(`${frontendUrl}/auth/callback?error=access_denied`);
  }

  try {
    const { refreshToken } =
      await authService.googleSocialLogin(code);
    res.cookie("refreshToken", refreshToken, getRefreshCookieOpts());
    return res.redirect(`${frontendUrl}/auth/callback`);
  } catch (err) {
    const knownCodes = [
      "GOOGLE_CODE_INVALID",
      "GOOGLE_NO_EMAIL",
      "GOOGLE_LOGIN_NOT_CONFIGURED",
      "OAUTH_UNVERIFIED_ACCOUNT",
      "OAUTH_EMAIL_CONFLICT",
    ];
    const code_ = knownCodes.includes(err.code) ? err.code : "OAUTH_ERROR";
    return res.redirect(`${frontendUrl}/auth/callback?error=${code_}`);
  }
}


export async function googleDocsCallback(req, res) {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error || !code || !state) {
    return res.redirect(`${frontendUrl}/settings?googleDocs=error`);
  }

  try {
    const { handleGoogleDocsCallback, verifySignedState } =
      await import("../../../services/googleDocs.service.js");


    const userId = verifySignedState(state);
    if (!userId) {
      return res.redirect(`${frontendUrl}/settings?googleDocs=error`);
    }

    await handleGoogleDocsCallback(code, userId);
    return res.redirect(`${frontendUrl}/settings?googleDocs=connected`);
  } catch (err) {
    console.error("Google Docs callback error:", err.message);
    return res.redirect(`${frontendUrl}/settings?googleDocs=error`);
  }
}


export async function googleDocsStatusForUser(req, res) {
  try {
    const { getGoogleDocsConnectionStatus } =
      await import("../../../services/googleDocs.service.js");
    const status = await getGoogleDocsConnectionStatus(req.user.userId);
    return ok(res, status);
  } catch (err) {
    return serverError(res, err, "googleDocsStatusForUser");
  }
}


export async function googleDocsStart(req, res) {
  try {
    const { getGoogleDocsOAuthUrl } =
      await import("../../../services/googleDocs.service.js");
    const url = getGoogleDocsOAuthUrl(req.user.userId);
    return ok(res, { url }, "Redirect to Google to grant Drive/Docs access.");
  } catch (err) {
    if (err.message?.includes("GOOGLE_DOCS_CLIENT_ID"))
      return fail(res, "GOOGLE_DOCS_NOT_CONFIGURED", err.message, 503);
    return serverError(res, err, "googleDocsStart");
  }
}


export async function googleDocsDisconnectForUser(req, res) {
  try {
    const { disconnectGoogleDocs } =
      await import("../../../services/googleDocs.service.js");
    await disconnectGoogleDocs(req.user.userId);
    return ok(res, null, "Google Drive disconnected.");
  } catch (err) {
    return serverError(res, err, "googleDocsDisconnectForUser");
  }
}


export async function notionConnect(req, res) {
  const { apiKey, parentPageId, workspaceName } = req.body;
  if (!apiKey || !parentPageId) {
    return fail(
      res,
      "VALIDATION_ERROR",
      "apiKey and parentPageId are required.",
      400,
    );
  }
  try {
    const { saveNotionSettings } =
      await import("../../../services/notion.service.js");
    const status = await saveNotionSettings({
      userId: req.user.userId,
      apiKey,
      parentPageId,
      workspaceName,
    });
    return ok(res, status, "Notion connected successfully.");
  } catch (err) {
    return serverError(res, err, "notionConnect");
  }
}


export async function notionStatus(req, res) {
  try {
    const { getNotionStatus } =
      await import("../../../services/notion.service.js");
    const status = await getNotionStatus(req.user.userId);
    return ok(res, status);
  } catch (err) {
    return serverError(res, err, "notionStatus");
  }
}


export async function notionDisconnect(req, res) {
  try {
    const { disconnectNotion } =
      await import("../../../services/notion.service.js");
    await disconnectNotion(req.user.userId);
    return ok(res, null, "Notion disconnected.");
  } catch (err) {
    return serverError(res, err, "notionDisconnect");
  }
}


function getApiBaseUrl(req) {
  return (
    req.headers["x-api-base-url"] ||
    process.env.APP_URL ||
    `${req.protocol}://${req.get("host")}`
  );
}

export async function webhookStatus(req, res) {
  try {
    const status = await authService.getWebhookStatus(req.user.userId);
    return ok(res, status);
  } catch (err) {
    return serverError(res, err, "webhookStatus");
  }
}


export async function initWebhook(req, res) {
  try {
    const settings = await authService.getOrInitializeWebhook(
      req.user.userId,
      getApiBaseUrl(req),
    );
    return ok(res, settings, "Webhook initialized successfully.");
  } catch (err) {
    return serverError(res, err, "initWebhook");
  }
}


export async function rotateWebhookSecret(req, res) {
  try {
    const settings = await authService.rotateWebhookSecret(
      req.user.userId,
      getApiBaseUrl(req),
    );
    return ok(res, settings, "Webhook secret rotated successfully.");
  } catch (err) {
    return serverError(res, err, "rotateWebhookSecret");
  }
}


export async function updateWebhookSettings(req, res) {
  const { webhookEnabled } = req.body;
  if (typeof webhookEnabled !== "boolean") {
    return fail(res, "VALIDATION_ERROR", "webhookEnabled must be a boolean.", 400);
  }
  try {
    const settings = await authService.updateWebhookSettings(
      req.user.userId,
      webhookEnabled,
      getApiBaseUrl(req),
    );
    return ok(res, settings, "Webhook settings updated.");
  } catch (err) {
    return serverError(res, err, "updateWebhookSettings");
  }
}


export async function cliInit(req, res) {
  try {
    const out = await cliAuthService.initCliSession({
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
      frontendBaseUrl: process.env.CLI_AUTH_FRONTEND_URL || "https://docnineai.com",
    });
    return res.status(201).json(out);
  } catch (err) {
    return serverError(res, err, "cliInit");
  }
}


export async function cliPoll(req, res) {
  try {
    const result = await cliAuthService.pollCliSession(req.params.sessionId);
    return res.json(result);
  } catch (err) {
    return serverError(res, err, "cliPoll");
  }
}


export async function cliApprove(req, res) {
  const { sessionId } = req.body || {};
  const refreshToken = req.cookies?.refreshToken;

  try {
    const user = await cliAuthService.authenticateCliApprover(refreshToken);
    await cliAuthService.approveCliSession({
      sessionId,
      userId: user._id,
    });
    return res.json({ success: true });
  } catch (err) {
    if (err.code && err.status) {
      return fail(res, err.code, err.message, err.status);
    }
    return serverError(res, err, "cliApprove");
  }
}


export async function cliCancel(req, res) {
  const { sessionId } = req.body || {};
  try {
    await cliAuthService.cancelCliSession(sessionId);
    return res.json({ success: true });
  } catch (err) {
    return serverError(res, err, "cliCancel");
  }
}
