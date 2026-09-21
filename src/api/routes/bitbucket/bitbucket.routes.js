import { Router } from "express";
import * as ctrl from "../../controllers/bitbucket/bitbucket.controller.js";
import { protect } from "../../../middleware/auth.middleware.js";
import { apiLimiter } from "../../../middleware/rateLimiter.middleware.js";
import { wrap } from "../../../utils/response.util.js";

const router = Router();

router.get("/oauth/callback", wrap(ctrl.oauthCallback));

router.use(protect, apiLimiter);

router.get("/oauth/start", wrap(ctrl.oauthStart));
router.get("/repos", wrap(ctrl.listRepos));
router.get("/status", wrap(ctrl.connectionStatus));
router.delete("/disconnect", wrap(ctrl.disconnect));

export default router;
