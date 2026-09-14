/**
 * API Token Authentication Middleware
 * Validates Bearer tokens generated from Dashboard → Settings → API Tokens
 * Attaches token info to req.tokenAuth on success
 */

import { APIToken } from "../models/APIToken.js";
import { fail } from "../utils/response.util.js";
import { hashToken } from "../utils/crypto.util.js";

function clientIpOf(req) {
  return req.ip || req.socket?.remoteAddress || "";
}

/**
 * Authenticate API token from Authorization header
 * Validates token against database, checks expiration and status
 * Attaches req.tokenAuth = { token, user, scopes, isValid } on success
 * Falls back to session auth if no API token
 */
export async function authenticateAPIToken(req, res, next) {
  if (req.tokenAuth) return next();

  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    if (req.user) return next();
    return fail(
      res,
      "NO_TOKEN",
      "Missing or invalid Authorization header. Use: Authorization: Bearer <token>",
      401,
    );
  }

  const plainToken = header.slice(7).trim();

  // Session JWT already authenticated (protect ran first), or a non-API token.
  if (req.user && !plainToken.startsWith("docnine_")) {
    return next();
  }

  if (!plainToken.startsWith("docnine_")) {
    return fail(
      res,
      "INVALID_TOKEN",
      "Token format is invalid. API tokens start with docnine_.",
      401,
    );
  }

  const clientIp = clientIpOf(req);

  try {
    if (plainToken.length < 10) {
      return fail(res, "INVALID_TOKEN", "Token format is invalid", 401);
    }

    const tokenHash = hashToken(plainToken);
    const apiToken = await APIToken.findOne({
      tokenHash,
      isRevoked: false,
    }).populate("userId", "email name");

    if (!apiToken) {
      return fail(
        res,
        "INVALID_TOKEN",
        "API token not found or has been revoked",
        401,
      );
    }

    if (apiToken.expiresAt && new Date() > apiToken.expiresAt) {
      return fail(res, "TOKEN_EXPIRED", "API token has expired", 401);
    }

    if (apiToken.ipWhitelist && apiToken.ipWhitelist.length > 0) {
      if (!apiToken.ipWhitelist.includes(clientIp)) {
        return fail(
          res,
          "IP_BLOCKED",
          "Client IP is not whitelisted for this token",
          403,
        );
      }
    }

    const projectId = req.params.id || req.params.projectId;
    if (projectId && !apiToken.hasProjectAccess(projectId)) {
      return fail(
        res,
        "FORBIDDEN",
        "This token is not allowed to access this project",
        403,
      );
    }

    try {
      await apiToken.recordUsage(clientIp);
    } catch (err) {
      console.warn("Failed to record token usage:", err);
    }

    req.tokenAuth = {
      token: plainToken,
      tokenId: apiToken._id,
      user: apiToken.userId,
      userId: apiToken.userId._id,
      scope: apiToken.scope,
      projectIds: apiToken.projectIds || [],
      isValid: apiToken.isValid(),
    };

    req.user = {
      userId: apiToken.userId._id,
      email: apiToken.userId.email,
    };

    next();
  } catch (err) {
    console.error("Token auth error:", err);
    return fail(res, "AUTH_ERROR", "Failed to authenticate token", 500);
  }
}

/**
 * Optional: Require API token (not session auth)
 * Use after authenticateAPIToken to ensure it's a token, not session
 */
export function requireAPIToken(req, res, next) {
  if (!req.tokenAuth || !req.tokenAuth.token) {
    return fail(
      res,
      "REQUIRE_TOKEN",
      "This endpoint requires API token authentication",
      401,
    );
  }
  next();
}

/**
 * Optional: Check token scope.
 * Session JWTs (dashboard) skip this check.
 * Works with both singular string scope and array of scopes.
 */
export function checkTokenScope(requiredScopes = []) {
  return (req, res, next) => {
    if (!req.tokenAuth) {
      if (req.user) return next();
      return fail(
        res,
        "NO_TOKEN",
        "Token authentication required for this scope",
        401,
      );
    }

    const rawScope = req.tokenAuth.scope || req.tokenAuth.scopes || [];
    const tokenScopes = Array.isArray(rawScope) ? rawScope : [rawScope];
    const hasScope = requiredScopes.some((scope) => tokenScopes.includes(scope));

    if (!hasScope) {
      return fail(
        res,
        "INSUFFICIENT_SCOPE",
        `Token missing required scope. Required: ${requiredScopes.join(", ")}`,
        403,
      );
    }

    next();
  };
}

export default authenticateAPIToken;
