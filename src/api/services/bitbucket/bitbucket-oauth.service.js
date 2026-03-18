// =============================================================
// Bitbucket OAuth flow and token management.
// =============================================================

import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../../../models/User.js";
import { encrypt, decrypt } from "../../../utils/crypto.util.js";
import * as bbService from "../../../services/bitbucket.service.js";

// ── Internal helpers ──────────────────────────────────────────

function getOAuthConfig() {
  const CLIENT_ID = process.env.BITBUCKET_CLIENT_ID;
  const CLIENT_SECRET = process.env.BITBUCKET_CLIENT_SECRET;
  const REDIRECT_URI = process.env.BITBUCKET_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Application keys not set.");
  }

  return { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI };
}

function getStateSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("Token keys not set");
  return secret;
}

// ── OAuth Step 1: Build authorisation URL ─────────────────────

/**
 * Generate the Bitbucket OAuth authorisation URL.
 * 
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
    redirect_uri: REDIRECT_URI,
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
    console.log("[Bitbucket OAuth Service] State verified", {
      userId: statePayload.userId,
    });
  } catch (err) {
    console.error("[Bitbucket OAuth Service] State verification failed", {
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
  console.log("[Bitbucket OAuth Service] Exchanging code for token...");
  let tokenRes;
  try {
    // Bitbucket requires form-encoded data, not JSON
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });

    tokenRes = await axios.post(
      "https://bitbucket.org/site/oauth2/access_token",
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        auth: {
          username: CLIENT_ID,
          password: CLIENT_SECRET,
        },
      },
    );
  } catch (err) {
    console.error("[Bitbucket OAuth Service] Token exchange failed", {
      status: err.response?.status,
      data: err.response?.data,
    });
    const e = new Error(`Bitbucket token exchange failed: ${err.message}`);
    e.code = "TOKEN_EXCHANGE_FAILED";
    e.status = 400;
    throw e;
  }

  const { access_token, refresh_token, error } = tokenRes.data;
  if (error || !access_token) {
    console.error("[Bitbucket OAuth Service] No access token in response", {
      error,
      hasToken: !!access_token,
    });
    const e = new Error(
      `Bitbucket OAuth error: ${error || "no access token returned"}`,
    );
    e.code = "OAUTH_EXCHANGE_FAILED";
    e.status = 400;
    throw e;
  }

  console.log(
    "[Bitbucket OAuth Service] Got access token, fetching user profile...",
  );

  // 3. Fetch Bitbucket user profile
  const bbUser = await bbService.getAuthenticatedUser(access_token);

  console.log("[Bitbucket OAuth Service] Got Bitbucket user", {
    bitbucketId: bbUser.id,
    bitbucketUsername: bbUser.username,
  });

  // 4. Update User record with Bitbucket identity
  console.log(
    "[Bitbucket OAuth Service] Updating user with Bitbucket identity...",
  );
  const updated1 = await User.findByIdAndUpdate(userId, {
    bitbucketId: bbUser.id,
    bitbucketUsername: bbUser.username,
  });

  if (!updated1) {
    console.error(
      "[Bitbucket OAuth Service] User not found when updating identity",
      {
        userId,
      },
    );
    throw new Error("User not found in database. Please log in again and try.");
  }

  // 5. Store encrypted token on User
  console.log("[Bitbucket OAuth Service] Encrypting and storing token...");
  const encryptedToken = encrypt(access_token);
  const encryptedRefresh = refresh_token ? encrypt(refresh_token) : null;

  const updated2 = await User.findByIdAndUpdate(
    userId,
    {
      bitbucketTokenEncrypted: encryptedToken,
      bitbucketRefreshTokenEncrypted: encryptedRefresh,
      bitbucketConnectedAt: new Date(),
    },
    { new: true },
  );

  if (!updated2) {
    console.error(
      "[Bitbucket OAuth Service] User not found when storing token",
      {
        userId,
      },
    );
    throw new Error("Failed to store Bitbucket token. Please try again.");
  }

  console.log("[Bitbucket OAuth Service] Successfully stored token", {
    userId,
    hasTokenEncrypted: !!updated2.bitbucketTokenEncrypted,
    bitbucketUsername: updated2.bitbucketUsername,
  });

  return { bitbucketUsername: bbUser.username, userId };
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
