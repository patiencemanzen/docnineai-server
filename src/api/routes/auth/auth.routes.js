// ===================================================================
// Auth router — mounted at /auth in server.js
//
// Middleware chain per route:
//   [rateLimiter?] → [validation rules] → validate → controller
// ===================================================================

import { Router } from "express";
import * as ctrl from "../../controllers/auth/auth.controller.js";
import tokenRoutes from "./token.routes.js";
import { rules, validate } from "../../../middleware/validate.middleware.js";
import { protect } from "../../../middleware/auth.middleware.js";
import {
  authLimiter,
  signupLimiter,
  refreshLimiter,
  verifyEmailLimiter,
  cliPollLimiter,
} from "../../../middleware/rateLimiter.middleware.js";
import { wrap } from "../../../utils/response.util.js";
import { autoLog } from "../../../middleware/activity-logger.middleware.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────
router.post(
  "/signup",
  signupLimiter,
  rules.signup,
  validate,
  autoLog("AUTH_SIGNUP", (_req, body) => ({
    userId:     body.data?.user?._id,
    actorName:  body.data?.user?.name  ?? "",
    actorEmail: body.data?.user?.email ?? "",
  })),
  wrap(ctrl.signup),
);
router.post(
  "/login",
  authLimiter,
  rules.login,
  validate,
  autoLog("AUTH_LOGIN", (_req, body) => ({
    userId:     body.data?.user?._id,
    actorName:  body.data?.user?.name  ?? "",
    actorEmail: body.data?.user?.email ?? "",
  })),
  wrap(ctrl.login),
);
router.post(
  "/verify-email",
  verifyEmailLimiter,
  rules.verifyEmail,
  validate,
  wrap(ctrl.verifyEmail),
);
router.post(
  "/forgot-password",
  authLimiter,
  rules.forgotPassword,
  validate,
  wrap(ctrl.forgotPassword),
);
router.post(
  "/reset-password",
  rules.resetPassword,
  validate,
  wrap(ctrl.resetPassword),
);

// Uses httpOnly refresh token cookie — no Bearer token needed
router.post("/refresh", refreshLimiter, wrap(ctrl.refresh));

// CLI login flow (browser-assisted, cookie-based approval)
router.post("/cli/init", wrap(ctrl.cliInit));
router.get("/cli/poll/:sessionId", cliPollLimiter, wrap(ctrl.cliPoll));
router.post("/cli/approve", wrap(ctrl.cliApprove));
router.post("/cli/cancel", cliPollLimiter, wrap(ctrl.cliCancel));

// ── OAuth — Social Login (GitHub) ─────────────────────────────
// The callbacks use redirect so they must NOT be JSON-wrapped.
router.get("/github/start", ctrl.githubLoginStart);
router.get("/github/callback", wrap(ctrl.githubLoginCallback));

// ── OAuth — Popup flows for provider connection (GitHub, GitLab, Bitbucket, Azure) ─
// These serve an HTML page that initiates OAuth flow in a popup window
router.get("/github", ctrl.githubPopup);
router.get("/gitlab", ctrl.gitlabPopup);
router.get("/bitbucket", ctrl.bitbucketPopup);
router.get("/azure", ctrl.azurePopup);

// ── OAuth — Social Login (Google) ────────────────────────────
router.get("/google/start", ctrl.googleLoginStart);
router.get("/google/callback", wrap(ctrl.googleLoginCallback));

// ── OAuth — Google Docs export ────────────────────────────────
router.get("/google-docs/callback", wrap(ctrl.googleDocsCallback));
router.get("/google-docs/status", protect, wrap(ctrl.googleDocsStatusForUser));
router.get("/google-docs/start", protect, wrap(ctrl.googleDocsStart));
router.delete("/google-docs", protect, wrap(ctrl.googleDocsDisconnectForUser));

// ── Notion integration (per-user API key) ────────────────────
router.post("/notion/connect", protect, wrap(ctrl.notionConnect));
router.get("/notion/status", protect, wrap(ctrl.notionStatus));
router.delete("/notion", protect, wrap(ctrl.notionDisconnect));

// ── Webhook Integration (settings-level, global) ──────────────
router.get("/webhook/status", protect, wrap(ctrl.webhookStatus));
router.post("/webhook/init", protect, wrap(ctrl.initWebhook));
router.post("/webhook/rotate", protect, wrap(ctrl.rotateWebhookSecret));
router.patch("/webhook", protect, wrap(ctrl.updateWebhookSettings));

// ── CLI logout (server-side token revocation) ───────────────
router.post("/cli/logout", protect, wrap(ctrl.cliLogout));

// ── Protected ─────────────────────────────────────────────────
router.post("/logout", protect, autoLog("AUTH_LOGOUT"), wrap(ctrl.logout));
router.get("/me", protect, wrap(ctrl.getMe));
router.patch(
  "/profile",
  protect,
  rules.updateProfile,
  validate,
  wrap(ctrl.updateProfile),
);
router.post(
  "/change-password",
  protect,
  rules.changePassword,
  validate,
  autoLog("AUTH_PASSWORD_CHANGED"),
  wrap(ctrl.changePassword),
);

// ── API Tokens ────────────────────────────────────────────────
router.use("/tokens", tokenRoutes);

export default router;
