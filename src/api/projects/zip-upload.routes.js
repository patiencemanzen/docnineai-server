// =============================================================
// ZIP Upload Routes
//
// POST   /projects/zip/upload     — create project from ZIP
// POST   /projects/zip/validate   — validate ZIP without creating
// =============================================================

import { Router } from "express";
import multer from "multer";
import * as ctrl from "./zip-upload.controller.js";
import { protect } from "../../middleware/auth.middleware.js";
import { apiLimiter } from "../../middleware/rateLimiter.middleware.js";
import { checkProjectLimit } from "../../middleware/plan-gate.middleware.js";
import { wrap } from "../../utils/response.util.js";

const router = Router();

// ── Middleware ────────────────────────────────────────────────
// Multer: in-memory storage, 50MB ZIP limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "application/zip" ||
      file.originalname.endsWith(".zip")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only ZIP files are accepted"));
    }
  },
});

router.use(protect, apiLimiter);

// ── Routes ────────────────────────────────────────────────────

// Validate ZIP without creating project
router.post(
  "/validate",
  upload.single("file"),
  wrap(ctrl.validateZipUpload)
);

// Upload and create project
router.post(
  "/upload",
  checkProjectLimit,
  upload.single("file"),
  wrap(ctrl.uploadZipProject)
);

export default router;
