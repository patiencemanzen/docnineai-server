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
    scope: "read_api read_repository",
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
  } catch {
    const err = new Error(
      "Invalid or expired OAuth state. Please start the OAuth flow again.",
    );
    err.code = "INVALID_OAUTH_STATE";
    err.status = 400;
    throw err;
  }

  const userId = statePayload.userId;

  // 2. Exchange code for access token
  const tokenRes = await axios.post(
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

  const { access_token, refresh_token, error } = tokenRes.data;
  if (error || !access_token) {
    const err = new Error(
      `GitLab OAuth error: ${error || "no access token returned"}`,
    );
    err.code = "OAUTH_EXCHANGE_FAILED";
    err.status = 400;
    throw err;
  }

  // 3. Fetch GitLab user profile using access token
  const glUser = await glService.getAuthenticatedUser(access_token);

  // 4. Update User record with GitLab identity
  await User.findByIdAndUpdate(userId, {
    gitlabId: String(glUser.id),
    gitlabUsername: glUser.username,
  });

  // 5. Store encrypted token on User document
  // (For GitLab, we store per-project tokens in Project.providerToken)
  // But we can also keep a default token on User for convenience
  await User.findByIdAndUpdate(
    userId,
    {
      gitlabTokenEncrypted: encrypt(access_token),
      gitlabRefreshTokenEncrypted: refresh_token
        ? encrypt(refresh_token)
        : null,
      gitlabConnectedAt: new Date(),
    },
    { new: true },
  );

  return { gitlabUsername: glUser.username };
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
