// =============================================================
// Azure DevOps OAuth flow and token management.
// =============================================================

import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../../../models/User.js";
import { encrypt, decrypt } from "../../../utils/crypto.util.js";
import * as azService from "../../../services/azure-devops.service.js";

// ── Internal helpers ──────────────────────────────────────────

function getOAuthConfig() {
  const CLIENT_ID = process.env.AZURE_DEVOPS_CLIENT_ID;
  const CLIENT_SECRET = process.env.AZURE_DEVOPS_CLIENT_SECRET;
  const REDIRECT_URI = process.env.AZURE_DEVOPS_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "AZURE_DEVOPS_CLIENT_ID and AZURE_DEVOPS_CLIENT_SECRET must be set in .env\n" +
        "Register an app at: https://app.vsaex.visualstudio.com/app/register",
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
 * Generate the Azure DevOps OAuth authorisation URL.
 * @param {string} userId
 * @returns {string} redirect URL
 */
export function buildOAuthUrl(userId) {
  const { CLIENT_ID, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  const state = jwt.sign({ userId }, stateSecret, { expiresIn: "10m" });

  console.log("[Azure OAuth] Building authorization URL", {
    CLIENT_ID,
    REDIRECT_URI,
    scope: "vso.code",
  });

  // Azure DevOps OAuth2 authorization request
  // Azure DevOps uses response_type=Assertion (not "code")
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "Assertion",
    state,
    scope: "vso.code",
    redirect_uri: REDIRECT_URI,
  });

  // Azure DevOps OAuth2 authorization endpoint
  const url = `https://app.vssps.visualstudio.com/oauth2/authorize?${params.toString()}`;
  
  // Log full URL for debugging
  console.log("[Azure OAuth] Full authorization URL:");
  console.log(url);
  
  return url;
}

// ── OAuth Step 2: Exchange assertion → token ──────────────────

/**
 * Complete the Azure DevOps OAuth flow.
 * @param {{ assertion: string, state: string }}
 * @returns {{ azureUsername: string }}
 */
export async function handleOAuthCallback({ code, state }) {
  const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = getOAuthConfig();
  const stateSecret = getStateSecret();

  // 1. Verify state JWT (CSRF check)
  let statePayload;
  try {
    statePayload = jwt.verify(state, stateSecret);
    console.log("[Azure OAuth Service] State verified", {
      userId: statePayload.userId,
    });
  } catch (err) {
    console.error("[Azure OAuth Service] State verification failed", {
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
  console.log("[Azure OAuth Service] Exchanging code for token...");
  let tokenRes;
  try {
    // Azure DevOps uses non-standard OAuth token exchange parameters
    const params = new URLSearchParams({
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: CLIENT_SECRET,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: code,
      redirect_uri: REDIRECT_URI,
    });

    tokenRes = await axios.post(
      "https://app.vssps.visualstudio.com/oauth2/token",
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
  } catch (err) {
    console.error("[Azure OAuth Service] Token exchange failed", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    const e = new Error(`Azure token exchange failed: ${err.message}`);
    e.code = "TOKEN_EXCHANGE_FAILED";
    e.status = 400;
    throw e;
  }

  const { access_token, refresh_token, error } = tokenRes.data;
  
  console.log("[Azure OAuth Service] Token exchange response", {
    hasAccessToken: !!access_token,
    hasRefreshToken: !!refresh_token,
    error: error || null,
    responseKeys: Object.keys(tokenRes.data || {}),
  });
  
  if (error || !access_token) {
    console.error("[Azure OAuth Service] No access token in response", {
      error,
      hasToken: !!access_token,
    });
    const e = new Error(
      `Azure DevOps OAuth error: ${error || "no access token returned"}`,
    );
    e.code = "OAUTH_EXCHANGE_FAILED";
    e.status = 400;
    throw e;
  }

  console.log("[Azure OAuth Service] Got access token, fetching user profile...");

  // 3. Fetch Azure DevOps user profile
  const azUser = await azService.getAuthenticatedUser(access_token);

  console.log("[Azure OAuth Service] Got Azure user", {
    azureId: azUser.id,
    azureUsername: azUser.username,
  });

  // 4. Update User record
  console.log("[Azure OAuth Service] Updating user with Azure identity...");
  const updated1 = await User.findByIdAndUpdate(userId, {
    azureDevOpsId: azUser.id,
    azureDevOpsUsername: azUser.username,
  });

  if (!updated1) {
    console.error("[Azure OAuth Service] User not found when updating identity", {
      userId,
    });
    throw new Error(
      "User not found in database. Please log in again and try.",
    );
  }

  // 5. Store encrypted token
  console.log("[Azure OAuth Service] Encrypting and storing token...");
  const encryptedToken = encrypt(access_token);
  const encryptedRefresh = refresh_token ? encrypt(refresh_token) : null;

  const updated2 = await User.findByIdAndUpdate(
    userId,
    {
      azureDevOpsTokenEncrypted: encryptedToken,
      azureDevOpsRefreshTokenEncrypted: encryptedRefresh,
      azureDevOpsConnectedAt: new Date(),
    },
    { new: true },
  );

  if (!updated2) {
    console.error("[Azure OAuth Service] User not found when storing token", {
      userId,
    });
    throw new Error("Failed to store Azure token. Please try again.");
  }

  console.log("[Azure OAuth Service] Successfully stored token", {
    userId,
    hasTokenEncrypted: !!updated2.azureDevOpsTokenEncrypted,
    azureDevOpsUsername: updated2.azureDevOpsUsername,
  });

  return { azureUsername: azUser.username, userId };
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
    azureDevOpsId: null,
    azureDevOpsUsername: null,
    azureDevOpsTokenEncrypted: null,
    azureDevOpsRefreshTokenEncrypted: null,
    azureDevOpsConnectedAt: null,
  });
}
