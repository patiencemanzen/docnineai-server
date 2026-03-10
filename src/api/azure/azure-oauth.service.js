// =============================================================
// Azure DevOps OAuth flow and token management.
// =============================================================

import jwt from "jsonwebtoken";
import axios from "axios";
import { User } from "../../models/User.js";
import { encrypt, decrypt } from "../../utils/crypto.util.js";
import * as azService from "../../services/azure-devops.service.js";

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

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "Assertion",
    state,
    scope: "vso.code",
    redirect_uri: REDIRECT_URI,
  });

  return `https://app.vssps.visualstudio.com/oauth2/authorize?${params.toString()}`;
}

// ── OAuth Step 2: Exchange assertion → token ──────────────────

/**
 * Complete the Azure DevOps OAuth flow.
 * @param {{ assertion: string, state: string }}
 * @returns {{ azureUsername: string }}
 */
export async function handleOAuthCallback({ assertion, state }) {
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

  // 2. Exchange assertion for PAT
  const tokenRes = await axios.post(
    "https://app.vssps.visualstudio.com/oauth2/token",
    {
      assertion,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      redirect_uri: REDIRECT_URI,
    },
  );

  const { access_token, refresh_token, error } = tokenRes.data;
  if (error || !access_token) {
    const err = new Error(
      `Azure DevOps OAuth error: ${error || "no access token returned"}`,
    );
    err.code = "OAUTH_EXCHANGE_FAILED";
    err.status = 400;
    throw err;
  }

  // 3. Fetch Azure DevOps user profile
  const azUser = await azService.getAuthenticatedUser(access_token);

  // 4. Update User record
  await User.findByIdAndUpdate(userId, {
    azureDevOpsId: azUser.id,
    azureDevOpsUsername: azUser.username,
  });

  // 5. Store encrypted token
  await User.findByIdAndUpdate(
    userId,
    {
      azureDevOpsTokenEncrypted: encrypt(access_token),
      azureDevOpsRefreshTokenEncrypted: refresh_token
        ? encrypt(refresh_token)
        : null,
      azureDevOpsConnectedAt: new Date(),
    },
    { new: true },
  );

  return { azureUsername: azUser.username };
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
