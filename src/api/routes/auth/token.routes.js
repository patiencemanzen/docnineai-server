/**
 * API Token Routes
 * POST   /auth/tokens              - Create a new token
 * GET    /auth/tokens              - List user's tokens
 * GET    /auth/tokens/:id          - Get token details
 * DELETE /auth/tokens/:id          - Revoke/delete token
 */

import { Router } from "express";
import * as tokenService from "../../../services/token.service.js";
import { protect } from "../../../middleware/auth.middleware.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";

const router = Router();

// ── Middleware: Require authentication ──
router.use(protect);

// ── POST /auth/tokens: Create new token ──
export async function createTokenHandler(req, res) {
  const userId = req.user.userId;
  const { name, description, scope, projectIds, expiresAt } = req.body;

  try {
    if (!name) {
      return fail(res, "INVALID_REQUEST", "Token name is required", 400);
    }

    const result = await tokenService.createToken(userId, {
      name,
      description,
      scope: scope || ["api"],
      projectIds: projectIds || [],
      expiresAt,
    });

    return ok(
      res,
      result,
      "Token created. Save it now : you won't see it again!",
      201
    );
  } catch (err) {
    if (err.code) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "createToken");
  }
}

// ── GET /auth/tokens: List user's tokens ──
export async function listTokensHandler(req, res) {
  const userId = req.user.userId;

  try {
    const tokens = await tokenService.getTokens(userId, {
      includeRevoked: req.query.includeRevoked === "true",
    });

    const stats = await tokenService.getTokenStats(userId);

    return ok(res, { tokens, stats });
  } catch (err) {
    return serverError(res, err, "listTokens");
  }
}

// ── GET /auth/tokens/:id: Get token details ──
export async function getTokenHandler(req, res) {
  const userId = req.user.userId;
  const { id } = req.params;

  try {
    const token = await tokenService.getToken(userId, id);
    return ok(res, token);
  } catch (err) {
    if (err.code) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getToken");
  }
}

// ── DELETE /auth/tokens/:id: Revoke token ──
export async function revokeTokenHandler(req, res) {
  const userId = req.user.userId;
  const { id } = req.params;

  try {
    const result = await tokenService.revokeToken(userId, id);
    return ok(res, result, "Token revoked");
  } catch (err) {
    if (err.code) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "revokeToken");
  }
}

// ── DELETE /auth/tokens/:id?permanent=true: Permanently delete token ──
export async function deleteTokenHandler(req, res) {
  const userId = req.user.userId;
  const { id } = req.params;

  try {
    const result = await tokenService.deleteToken(userId, id);
    return ok(res, result, "Token deleted permanently");
  } catch (err) {
    if (err.code) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "deleteToken");
  }
}

// ── Routes ──
router.post("/", createTokenHandler);
router.get("/", listTokensHandler);
router.get("/:id", getTokenHandler);
router.delete("/:id", (req, res) => {
  const isPermanent = req.query.permanent === "true";
  return isPermanent
    ? deleteTokenHandler(req, res)
    : revokeTokenHandler(req, res);
});

export default router;
