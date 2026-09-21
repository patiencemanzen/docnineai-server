
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


router.post(
  "/signup",
  signupLimiter,
  rules.signup,
  validate,
  wrap(ctrl.signup),
);
router.post(
  "/login",
  authLimiter,
  rules.login,
  validate,
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
  authLimiter,
  rules.resetPassword,
  validate,
  wrap(ctrl.resetPassword),
);


router.post("/refresh", refreshLimiter, wrap(ctrl.refresh));


router.post("/cli/init", authLimiter, wrap(ctrl.cliInit));
router.get("/cli/poll/:sessionId", cliPollLimiter, wrap(ctrl.cliPoll));
router.post("/cli/approve", wrap(ctrl.cliApprove));
router.post("/cli/cancel", cliPollLimiter, wrap(ctrl.cliCancel));


router.get("/github/start", ctrl.githubLoginStart);
router.get("/github/callback", wrap(ctrl.githubLoginCallback));


router.get("/github", ctrl.githubPopup);
router.get("/gitlab", ctrl.gitlabPopup);
router.get("/bitbucket", ctrl.bitbucketPopup);
router.get("/azure", ctrl.azurePopup);


router.get("/google/start", ctrl.googleLoginStart);
router.get("/google/callback", wrap(ctrl.googleLoginCallback));


router.get("/google-docs/callback", wrap(ctrl.googleDocsCallback));
router.get("/google-docs/status", protect, wrap(ctrl.googleDocsStatusForUser));
router.get("/google-docs/start", protect, wrap(ctrl.googleDocsStart));
router.delete("/google-docs", protect, wrap(ctrl.googleDocsDisconnectForUser));


router.post("/notion/connect", protect, wrap(ctrl.notionConnect));
router.get("/notion/status", protect, wrap(ctrl.notionStatus));
router.delete("/notion", protect, wrap(ctrl.notionDisconnect));


router.get("/webhook/status", protect, wrap(ctrl.webhookStatus));
router.post("/webhook/init", protect, wrap(ctrl.initWebhook));
router.post("/webhook/rotate", protect, wrap(ctrl.rotateWebhookSecret));
router.patch("/webhook", protect, wrap(ctrl.updateWebhookSettings));


router.post("/cli/logout", protect, wrap(ctrl.cliLogout));


router.post("/logout", protect, wrap(ctrl.logout));
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


router.use("/tokens", tokenRoutes);

export default router;
