import { Router } from "express";
import { body } from "express-validator";
import * as ctrl from "./cli.controller.js";
import { protect } from "../../middleware/auth.middleware.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import { wrap } from "../../utils/response.util.js";

const router = Router();

router.use(protect, apiLimiter);

router.post(
  "/generate",
  [
    body("projectId").isMongoId().withMessage("projectId must be a valid MongoDB id"),
    body("files").isArray({ min: 1 }).withMessage("files must be a non-empty array"),
    body("files.*.path").isString().notEmpty().withMessage("file.path is required"),
    body("files.*.content").isString().withMessage("file.content must be a string"),
    body("agentsOnly").optional().isArray().withMessage("agentsOnly must be an array"),
    body("format").optional().isString(),
    validate,
  ],
  wrap(ctrl.generate),
);

router.post(
  "/chat",
  [
    body("projectId").isMongoId().withMessage("projectId must be a valid MongoDB id"),
    body("question").isString().notEmpty().withMessage("question is required"),
    body("history").optional().isArray(),
    validate,
  ],
  wrap(ctrl.chat),
);

export default router;

