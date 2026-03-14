/**
 * API Token Authentication Middleware
 * Validates Bearer tokens generated from Dashboard → Settings → API Tokens
 * Attaches token info to req.tokenAuth on success
 */

import { APIToken } from '../models/APIToken.js';
import { fail } from '../utils/response.util.js';
import { hashToken } from '../utils/crypto.util.js';

/**
 * Authenticate API token from Authorization header
 * Validates token against database, checks expiration and status
 * Attaches req.tokenAuth = { token, user, scopes, isValid } on success
 * Falls back to session auth if no API token
 */
export async function authenticateAPIToken(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    // No API token — fall back to session auth (if user is logged in)
    if (req.user) {
      return next();
    }
    return fail(
      res,
      'NO_TOKEN',
      'Missing or invalid Authorization header. Use: Authorization: Bearer <token>',
      401
    );
  }

  const plainToken = header.slice(7).trim();

  try {
    // Validate token format (basic check)
    if (!plainToken || plainToken.length < 10) {
      return fail(
        res,
        'INVALID_TOKEN',
        'Token format is invalid',
        401
      );
    }

    // Find token in database by hash
    // APIToken stores tokenHash (SHA256 hash of the plain token)
    const tokenHash = hashToken(plainToken);
    const apiToken = await APIToken.findOne({
      tokenHash,
      isRevoked: false, // Only active tokens
    }).populate('userId', 'email name');

    if (!apiToken) {
      return fail(
        res,
        'INVALID_TOKEN',
        'API token not found or has been revoked',
        401
      );
    }

    // Check expiration
    if (apiToken.expiresAt && new Date() > apiToken.expiresAt) {
      return fail(
        res,
        'TOKEN_EXPIRED',
        'API token has expired',
        401
      );
    }

    // Check IP whitelist if configured
    if (apiToken.ipWhitelist && apiToken.ipWhitelist.length > 0) {
      const clientIp = req.ip || req.connection.remoteAddress;
      if (!apiToken.ipWhitelist.includes(clientIp)) {
        return fail(
          res,
          'IP_BLOCKED',
          'Client IP is not whitelisted for this token',
          403
        );
      }
    }

    // Record usage
    try {
      await apiToken.recordUsage(clientIp);
    } catch (err) {
      console.warn('Failed to record token usage:', err);
      // Don't fail on usage recording
    }

    // Attach to request
    req.tokenAuth = {
      token: plainToken,
      tokenId: apiToken._id,
      user: apiToken.userId,
      userId: apiToken.userId._id,
      scope: apiToken.scope,
      isValid: apiToken.isValid(),
    };

    // Also set req.user for consistency with session auth
    req.user = {
      userId: apiToken.userId._id,
      email: apiToken.userId.email,
    };

    next();
  } catch (err) {
    console.error('Token auth error:', err);
    return fail(
      res,
      'AUTH_ERROR',
      'Failed to authenticate token',
      500
    );
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
      'REQUIRE_TOKEN',
      'This endpoint requires API token authentication',
      401
    );
  }
  next();
}

/**
 * Optional: Check token scope
 */
export function checkTokenScope(requiredScopes = []) {
  return (req, res, next) => {
    if (!req.tokenAuth) {
      return fail(
        res,
        'NO_TOKEN',
        'Token authentication required for this scope',
        401
      );
    }

    const tokenScopes = req.tokenAuth.scopes || [];
    const hasScope = requiredScopes.some(scope => tokenScopes.includes(scope));

    if (!hasScope) {
      return fail(
        res,
        'INSUFFICIENT_SCOPE',
        `Token missing required scope. Required: ${requiredScopes.join(', ')}`,
        403
      );
    }

    next();
  };
}

export default authenticateAPIToken;
