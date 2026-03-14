/**
 * API Token Authentication Middleware
 * Validates Bearer tokens from the Authorization header
 * Used for MCP, CLI, and other API clients
 */

import * as tokenService from "../../services/token.service.js";

/**
 * Middleware to authenticate API token
 * Bearer <token> in Authorization header
 */
export async function authenticateAPIToken(req, res, next) {
  const authHeader = req.get("Authorization");

  if (!authHeader) {
    // No token provided — proceed without authentication
    // Routes can decide if token is required
    req.tokenAuth = null;
    return next();
  }

  // Parse "Bearer <token>"
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return res.status(401).json({
      code: "INVALID_AUTH_HEADER",
      message: "Authorization header must be 'Bearer <token>'",
    });
  }

  const token = parts[1];

  try {
    const ipAddress = req.ip || req.connection.remoteAddress;
    const tokenData = await tokenService.validateToken(token, { ipAddress });

    // Attach to request for use in route handlers
    req.tokenAuth = tokenData;
    req.user = tokenData.user;
    next();
  } catch (err) {
    return res.status(err.status || 401).json({
      code: err.code || "INVALID_TOKEN",
      message: err.message,
    });
  }
}

/**
 * Require API token authentication
 * Use this on protected routes that need token auth
 */
export function requireAPIToken(req, res, next) {
  if (!req.tokenAuth) {
    return res.status(401).json({
      code: "TOKEN_REQUIRED",
      message: "API token is required for this endpoint",
    });
  }
  next();
}

/**
 * Check if token has required scope
 * e.g., checkTokenScope("mcp") or checkTokenScope(["mcp", "cli"])
 */
export function checkTokenScope(...requiredScopes) {
  return (req, res, next) => {
    if (!req.tokenAuth) {
      return res.status(401).json({
        code: "TOKEN_REQUIRED",
        message: "API token is required",
      });
    }

    const hasScope = requiredScopes.some((s) =>
      req.tokenAuth.scope.includes(s),
    );
    if (!hasScope) {
      return res.status(403).json({
        code: "INSUFFICIENT_SCOPE",
        message: `Token must have one of these scopes: ${requiredScopes.join(", ")}`,
      });
    }

    next();
  };
}

/**
 * Check project access
 * Token can optionally restrict to specific projects
 */
export async function checkTokenProjectAccess(req, res, next) {
  if (!req.tokenAuth) {
    return next();
  }

  const projectId = req.params.id || req.query.projectId;
  if (!projectId) {
    return next();
  }

  const hasAccess = await tokenService.checkProjectAccess(
    req.tokenAuth.token,
    projectId,
  );

  if (!hasAccess) {
    return res.status(403).json({
      code: "PROJECT_ACCESS_DENIED",
      message: "Token does not have access to this project",
    });
  }

  next();
}
