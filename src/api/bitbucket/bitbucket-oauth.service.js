// =============================================================
// Bitbucket OAuth flow and token management.
// =============================================================

import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../../models/User.js";
import { encrypt, decrypt } from "../../utils/crypto.util.js";
import * as bbService from "../../services/bitbucket.service.js";

// ── Internal helpers ──────────────────────────────────────────

function getOAuthConfig() {
  const CLIENT_ID = process.env.BITBUCKET_CLIENT_ID;
  const CLIENT_SECRET = process.env.BITBUCKET_CLIENT_SECRET;
  const REDIRECT_URI = process.env.BITBUCKET_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "BITBUCKET_CLIENT_ID and BITBUCKET_CLIENT_SECRET must be set in .env\n" +
        "Create an OAuth App at: https://bitbucket.org/account/settings/apps/",
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
 * Generate the Bitbucket OAuth authorisation URL.
 * @param {string} userId
 * @returns {string} redirect URL
 */
export function buildOAuthUrl(userId) {
  const { CLIENT_ID, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  const state = jwt.sign({ userId }, stateSecret, { expiresIn: "10m" });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    state,
  });

  return `https://bitbucket.org/site/oauth2/authorize?${params.toString()}`;
}

// ── OAuth Step 2: Exchange code → token ───────────────────────

/**
 * Complete the Bitbucket OAuth flow.
 * @param {{ code: string, state: string }}
 * @returns {{ bitbucketUsername: string }}
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
    "https://bitbucket.org/site/oauth2/access_token",
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    },
    {
      auth: {
        username: CLIENT_ID,
        password: CLIENT_SECRET,
      },
    },
  );

  const { access_token, refresh_token, error } = tokenRes.data;
  if (error || !access_token) {
    const err = new Error(
      `Bitbucket OAuth error: ${error || "no access token returned"}`,
    );
    err.code = "OAUTH_EXCHANGE_FAILED";
    err.status = 400;
    throw err;
  }

  // 3. Fetch Bitbucket user profile
  const bbUser = await bbService.getAuthenticatedUser(access_token);

  // 4. Update User record with Bitbucket identity
  await User.findByIdAndUpdate(userId, {
    bitbucketId: bbUser.id,
    bitbucketUsername: bbUser.username,
  });

  // 5. Store encrypted token on User
  await User.findByIdAndUpdate(
    userId,
    {
      bitbucketTokenEncrypted: encrypt(access_token),
      bitbucketRefreshTokenEncrypted: refresh_token
        ? encrypt(refresh_token)
        : null,
      bitbucketConnectedAt: new Date(),
    },
    { new: true },
  );

  return { bitbucketUsername: bbUser.username };
}

// ── Token management ──────────────────────────────────────────

export function encryptProvidersToken(token) {
  return encrypt(token);
}

export function decryptProvidersToken(encrypted) {
  return decrypt(encrypted);
}

export async function disconnect(userId) {
  await User.findByIdAndUpdate(userId, {
    bitbucketId: null,
    bitbucketUsername: null,
    bitbucketTokenEncrypted: null,
    bitbucketRefreshTokenEncrypted: null,
    bitbucketConnectedAt: null,
  });
}
