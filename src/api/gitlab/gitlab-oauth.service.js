// =============================================================
// GitLab OAuth flow and token management.
//
// Similar to github.service.js but uses GitLab OAuth and
// stores tokens in a similar pattern.
// =============================================================

import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../../models/User.js";
import { encrypt, decrypt } from "../../utils/crypto.util.js";
import * as glService from "../../services/gitlab.service.js";

// ── Internal helpers ──────────────────────────────────────────

function getOAuthConfig() {
  const CLIENT_ID = process.env.GITLAB_CLIENT_ID;
  const CLIENT_SECRET = process.env.GITLAB_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GITLAB_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("[GitLab OAuth] Missing OAuth config", {
      hasClientId: !!CLIENT_ID,
      hasClientSecret: !!CLIENT_SECRET,
      hasRedirectUri: !!REDIRECT_URI,
      clientIdValue: CLIENT_ID ? "***" : undefined,
    });
    throw new Error(
      "GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET must be set in .env\n" +
        "Create an OAuth App at: https://gitlab.com/oauth/applications",
    );
  }

  return { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI };
}

function getStateSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET must be set in .env");
  return secret;
}

// ── OAuth Step 1: Build authorisation URL ─────────────────────

/**
 * Generate the GitLab OAuth authorisation URL.
 * @param {string} userId
 * @returns {string} redirect URL
 */
export function buildOAuthUrl(userId) {
  const { CLIENT_ID, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  const state = jwt.sign({ userId }, stateSecret, { expiresIn: "10m" });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
    scope: "api read_repository",
  });

  return `https://gitlab.com/oauth/authorize?${params.toString()}`;
}

// ── OAuth Step 2: Exchange code → token ───────────────────────

/**
 * Complete the GitLab OAuth flow: exchange code, fetch profile,
 * encrypt and persist the token.
 *
 * @param {{ code: string, state: string }}
 * @returns {{ gitlabUsername: string }}
 */
export async function handleOAuthCallback({ code, state }) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  // 1. Verify state JWT (CSRF check)
  let statePayload;
  try {
    statePayload = jwt.verify(state, stateSecret);
    console.log("[GitLab OAuth Service] State verified", {
      userId: statePayload.userId,
    });
  } catch (err) {
    console.error("[GitLab OAuth Service] State verification failed", {
      message: err.message,
    });
    const e = new Error(
      "Invalid or expired OAuth state. Please start the OAuth flow again.",
    );
    e.code = "INVALID_OAUTH_STATE";
    e.status = 400;
    throw e;
  }

  const userId = statePayload.userId;

  // 2. Exchange code for access token
  console.log("[GitLab OAuth Service] Exchanging code for token...");
  let tokenRes;
  try {
    tokenRes = await axios.post(
      "https://gitlab.com/oauth/token",
      {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      },
      { headers: { Accept: "application/json" } },
    );
  } catch (err) {
    console.error("[GitLab OAuth Service] Token exchange failed", {
      status: err.response?.status,
      data: err.response?.data,
    });
    const e = new Error(`GitLab token exchange failed: ${err.message}`);
    e.code = "TOKEN_EXCHANGE_FAILED";
    e.status = 400;
    throw e;
  }

  const { access_token, refresh_token, error } = tokenRes.data;
  if (error || !access_token) {
    console.error("[GitLab OAuth Service] No access token in response", {
      error,
      hasToken: !!access_token,
    });
    const e = new Error(
      `GitLab OAuth error: ${error || "no access token returned"}`,
    );
    e.code = "OAUTH_EXCHANGE_FAILED";
    e.status = 400;
    throw e;
  }

  console.log("[GitLab OAuth Service] Got access token, fetching user profile...");

  // 3. Fetch GitLab user profile using access token
  let glUser;
  try {
    glUser = await glService.getAuthenticatedUser(access_token);
  } catch (err) {
    console.error("[GitLab OAuth Service] Failed to fetch user profile", {
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message,
    });
    throw err;
  }

  console.log("[GitLab OAuth Service] Got GitLab user", {
    gitlabId: glUser.id,
    gitlabUsername: glUser.username,
  });

  // 4. Update User record with GitLab identity
  console.log("[GitLab OAuth Service] Updating user with GitLab identity...");
  const updated1 = await User.findByIdAndUpdate(userId, {
    gitlabId: String(glUser.id),
    gitlabUsername: glUser.username,
  });

  if (!updated1) {
    console.error("[GitLab OAuth Service] User not found when updating identity", {
      userId,
    });
    throw new Error(
      "User not found in database. Please log in again and try.",
    );
  }

  // 5. Store encrypted token on User document
  console.log("[GitLab OAuth Service] Encrypting and storing token...");
  const encryptedToken = encrypt(access_token);
  const encryptedRefresh = refresh_token ? encrypt(refresh_token) : null;

  const updated2 = await User.findByIdAndUpdate(
    userId,
    {
      gitlabTokenEncrypted: encryptedToken,
      gitlabRefreshTokenEncrypted: encryptedRefresh,
      gitlabConnectedAt: new Date(),
    },
    { new: true },
  );

  if (!updated2) {
    console.error("[GitLab OAuth Service] User not found when storing token", {
      userId,
    });
    throw new Error("Failed to store GitLab token. Please try again.");
  }

  console.log("[GitLab OAuth Service] Successfully stored token", {
    userId,
    hasTokenEncrypted: !!updated2.gitlabTokenEncrypted,
    gitlabUsername: updated2.gitlabUsername,
  });

  return { gitlabUsername: glUser.username, userId };
}

// ── Store provider-specific token on project ──────────────────

/**
 * Store an encrypted GitLab access token on a Project document.
 * Called when creating a project that will use this token.
 */
export function encryptProvidersToken(token) {
  return encrypt(token);
}

export function decryptProvidersToken(encrypted) {
  return decrypt(encrypted);
}

// ── Disconnect / revoke ───────────────────────────────────────

/**
 * Disconnect GitLab OAuth.
 * In practice, we'd also revoke the token on GitLab's side.
 */
export async function disconnect(userId) {
  await User.findByIdAndUpdate(userId, {
    gitlabId: null,
    gitlabUsername: null,
    gitlabTokenEncrypted: null,
    gitlabRefreshTokenEncrypted: null,
    gitlabConnectedAt: null,
  });
}
