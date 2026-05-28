// =============================================================
// Public portal routes — no authentication required.
//
//   GET  /portal/:slug        — fetch portal + content
//   POST /portal/:slug/auth   — verify portal password
// =============================================================

import { Router } from "express";
import { wrap } from "../../../utils/response.util.js";
import * as ctrl from "../../controllers/portal/portal.controller.js";
import { portalAuthLimiter } from "../../../middleware/rateLimiter.middleware.js";

const router = Router();

router.get("/:slug", wrap(ctrl.getPublicPortal));
router.post("/:slug/auth", portalAuthLimiter, wrap(ctrl.authPortal));

export default router;
