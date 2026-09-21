import { Router } from "express";
import { body, param } from "express-validator";
import multer from "multer";
import * as ctrl from "../../controllers/apispec/apispec.controller.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { requireApiImporter } from "../../../middleware/plan-gate.middleware.js";
import { wrap } from "../../../utils/response.util.js";

const router = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = [
      "application/json",
      "application/x-yaml",
      "application/yaml",
      "text/yaml",
      "text/plain",
      "text/x-yaml",
    ];
    const ok = allowed.includes(file.mimetype) || /\.(json|yaml|yml)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only JSON / YAML files are accepted."), ok);
  },
});

router.get("/", wrap(ctrl.getSpec));

router.post(
  "/import",
  requireApiImporter,
  upload.single("file"),
  [
    body("method")
      .optional()
      .isIn(["file", "url", "raw"])
      .withMessage("method must be file, url, or raw"),
    body("url")
      .optional()
      .isURL({ require_protocol: true })
      .withMessage("url must be a valid URL starting with http(s)"),
    validate,
  ],
  wrap(ctrl.importSpec),
);

router.post("/sync", requireApiImporter, wrap(ctrl.syncSpec));

router.delete("/", wrap(ctrl.deleteSpec));

router.patch(
  "/endpoint",
  [
    body("endpointId").isString().notEmpty().withMessage("endpointId is required"),
    body("note").optional().isString(),
    validate,
  ],
  wrap(ctrl.updateEndpointNote),
);

router.post(
  "/try",
  [
    body("method").isString().notEmpty().withMessage("method is required"),
    body("baseUrl").isURL({ require_protocol: true }).withMessage("baseUrl must be a valid URL"),
    body("path").isString().notEmpty().withMessage("path is required"),
    validate,
  ],
  wrap(ctrl.tryRequest),
);

export default router;
