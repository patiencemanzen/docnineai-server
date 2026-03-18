// =============================================================
// Bitbucket OAuth Controller
// =============================================================

import * as bitbucketOAuthService from "../../services/bitbucket/bitbucket-oauth.service.js";
import * as bitbucketService from "../../../services/bitbucket.service.js";
import { User } from "../../../models/User.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";

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
    const msg = `Bitbucket denied access: ${oauthError}`;
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bitbucket Connection Failed</title>
        <meta charset="utf-8" />
        <style>body { font-family: system-ui; text-align: center; padding: 2rem; }</style>
      </head>
      <body>
        <h2>Connection Failed</h2>
        <p>${msg}</p>
        <script>
          const result = { status: 'error', msg: '${msg.replace(/'/g, "\\'")}' };
          localStorage.setItem('__docnine_bitbucket_oauth_result', JSON.stringify(result));
          window.opener?.postMessage({
            type: 'bitbucket-oauth-complete',
            ...result
          }, '*');
          window.close();
        </script>
      </body>
      </html>
    `);
  }

  if (!code || !state) {
    console.error("[Bitbucket OAuth] Missing code or state");
    const msg = "Missing code or state — please try again.";
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bitbucket Connection Failed</title>
        <meta charset="utf-8" />
        <style>body { font-family: system-ui; text-align: center; padding: 2rem; }</style>
      </head>
      <body>
        <h2>Connection Failed</h2>
        <p>${msg}</p>
        <script>
          const result = { status: 'error', msg: '${msg}' };
          localStorage.setItem('__docnine_bitbucket_oauth_result', JSON.stringify(result));
          window.opener?.postMessage({
            type: 'bitbucket-oauth-complete',
            ...result
          }, '*');
          window.close();
        </script>
      </body>
      </html>
    `);
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

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bitbucket Connected</title>
        <meta charset="utf-8" />
        <style>body { font-family: system-ui; text-align: center; padding: 2rem; }</style>
      </head>
      <body>
        <h2>Successfully Connected</h2>
        <p>Bitbucket account connected as <strong>${result.bitbucketUsername}</strong></p>
        <script>
          const result = { status: 'success', user: '${result.bitbucketUsername}' };
          localStorage.setItem('__docnine_bitbucket_oauth_result', JSON.stringify(result));
          window.opener?.postMessage({
            type: 'bitbucket-oauth-complete',
            ...result
          }, '*');
          setTimeout(() => window.close(), 500);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("[Bitbucket OAuth] Callback failed", {
      code: err.code,
      message: err.message,
      status: err.status,
    });
    const msg = err.message || "Bitbucket connection failed.";
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bitbucket Connection Failed</title>
        <meta charset="utf-8" />
        <style>body { font-family: system-ui; text-align: center; padding: 2rem; }</style>
      </head>
      <body>
        <h2>Connection Failed</h2>
        <p>${msg}</p>
        <script>
          const result = { status: 'error', msg: '${msg.replace(/'/g, "\\'")}' };
          localStorage.setItem('__docnine_bitbucket_oauth_result', JSON.stringify(result));
          window.opener?.postMessage({
            type: 'bitbucket-oauth-complete',
            ...result
          }, '*');
          window.close();
        </script>
      </body>
      </html>
    `);
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
