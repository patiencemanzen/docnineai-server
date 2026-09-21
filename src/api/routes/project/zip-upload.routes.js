import { Router } from "express";
import multer from "multer";
import * as ctrl from "../../controllers/project/zip-upload.controller.js";
import { protect } from "../../../middleware/auth.middleware.js";
import { apiLimiter } from "../../../middleware/rateLimiter.middleware.js";
import { checkProjectLimit } from "../../../middleware/plan-gate.middleware.js";
import { wrap } from "../../../utils/response.util.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/zip" || file.originalname.endsWith(".zip")) {
      cb(null, true);
    } else {
      cb(new Error("Only ZIP files are accepted"));
    }
  },
});

router.use(protect, apiLimiter);

router.post("/validate", upload.single("file"), wrap(ctrl.validateZipUpload));

router.post("/upload", checkProjectLimit, upload.single("file"), wrap(ctrl.uploadZipProject));

export default router;
