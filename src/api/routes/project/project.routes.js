


import { Router } from "express";
import { param, body } from "express-validator";
import multer from "multer";
import * as ctrl from "../../controllers/project/project.controller.js";
import * as attachmentCtrl from "../../controllers/project/attachment.controller.js";
import * as shareCtrl from "../../controllers/project/share.controller.js";
import * as portalCtrl from "../../controllers/portal/portal.controller.js";
import { MCPController } from "../../controllers/project/mcp.controller.js";
import zipRoutes from "./zip-upload.routes.js";
import apispecRoutes from "../apispec/apispec.routes.js";
import mcpRoutes from "./mcp.routes.js";
import { protect } from "../../../middleware/auth.middleware.js";
import { checkTokenScope } from "../../../middleware/token-auth.middleware.js";
import { rules, validate } from "../../../middleware/validate.middleware.js";
import { apiLimiter } from "../../../middleware/rateLimiter.middleware.js";
import {
  checkProjectLimit,
  checkPortalPublishLimit,
  checkAiChatLimit,
  requireExportFormat,
  requireApiImporter,
  requireGithubSync,
} from "../../../middleware/plan-gate.middleware.js";
import { wrap } from "../../../utils/response.util.js";
import { SECTIONS } from "../../../models/DocumentVersion.js";
import { autoLog } from "../../../middleware/activity-logger.middleware.js";

const router = Router();
router.use(protect, apiLimiter);


router.use("/zip", zipRoutes);


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});


const validateMongoId = [
  param("id").isMongoId().withMessage("Invalid project ID"),
  validate,
];
const validatePatchBody = [...rules.updateProject, validate];
const validateSection = [
  param("section")
    .isIn(SECTIONS)
    .withMessage(`section must be one of: ${SECTIONS.join(", ")}`),
  validate,
];
const validateVersionId = [
  param("versionId").isMongoId().withMessage("Invalid version ID"),
  validate,
];


router.get("/shared", wrap(shareCtrl.getSharedProjects));


router.post(
  "/",
  rules.createProject,
  validate,
  checkProjectLimit,
  wrap(ctrl.createProject),
);
router.post(
  "/from-scratch",
  checkProjectLimit,
  wrap(ctrl.createFromScratchProject),
);
router.get("/", rules.listProjects, validate, wrap(ctrl.listProjects));


router.get("/:id", validateMongoId, wrap(ctrl.getProject));
router.delete("/:id", validateMongoId, wrap(ctrl.deleteProject));
router.patch(
  "/:id",
  validateMongoId,
  validatePatchBody,
  wrap(ctrl.updateProject),
);


router.post("/:id/retry", validateMongoId, wrap(ctrl.retryProject));
router.post("/:id/sync", validateMongoId, requireGithubSync, wrap(ctrl.syncProject));


router.get("/:id/stream", validateMongoId, ctrl.streamProject);

router.get("/:id/events", validateMongoId, wrap(ctrl.getProjectEvents));

router.patch(
  "/:id/docs/:section",
  validateMongoId,
  validateSection,
  [
    body("content").isString().notEmpty().withMessage("content is required"),
    validate,
  ],
  wrap(ctrl.editDocSection),
);

router.delete(
  "/:id/docs/:section/edit",
  validateMongoId,
  validateSection,
  wrap(ctrl.revertDocSection),
);

router.post(
  "/:id/docs/:section/accept-ai",
  validateMongoId,
  validateSection,
  wrap(ctrl.acceptAISection),
);


router.get(
  "/:id/docs/:section/versions",
  validateMongoId,
  validateSection,
  wrap(ctrl.listVersions),
);

router.get(
  "/:id/docs/:section/versions/:versionId",
  validateMongoId,
  validateSection,
  validateVersionId,
  wrap(ctrl.getVersion),
);

router.post(
  "/:id/docs/:section/versions/:versionId/restore",
  validateMongoId,
  validateSection,
  validateVersionId,
  wrap(ctrl.restoreVersion),
);


router.get(
  "/:id/changelog",
  validateMongoId,
  wrap(ctrl.getProjectChangeLog),
);

router.get("/:id/export/pdf", validateMongoId, requireExportFormat("pdf"), wrap(ctrl.exportPdf));
router.post("/:id/export/pdf", validateMongoId, requireExportFormat("pdf"), autoLog("EXPORT_PDF"), wrap(ctrl.exportPdf));
router.get("/:id/export/yaml", validateMongoId, wrap(ctrl.exportYaml));
router.post("/:id/export/yaml", validateMongoId, autoLog("EXPORT_YAML"), wrap(ctrl.exportYaml));
router.post("/:id/export/notion", validateMongoId, requireExportFormat("notion"), autoLog("EXPORT_NOTION"), wrap(ctrl.exportNotion));


router.get(
  "/:id/export/google-docs/connect",
  validateMongoId,
  wrap(ctrl.googleDocsConnect),
);
router.get(
  "/:id/export/google-docs/status",
  validateMongoId,
  wrap(ctrl.googleDocsStatus),
);
router.delete(
  "/:id/export/google-docs",
  validateMongoId,
  wrap(ctrl.googleDocsDisconnect),
);
router.post(
  "/:id/export/google-docs",
  validateMongoId,
  requireExportFormat("google_docs"),
  autoLog("EXPORT_GOOGLE_DOCS"),
  wrap(ctrl.exportGoogleDocs),
);


router.post("/:id/chat", validateMongoId, checkAiChatLimit, ctrl.chatHandler);
router.delete("/:id/chat", validateMongoId, wrap(ctrl.resetChat));


const validateShareId = [
  param("shareId").isMongoId().withMessage("Invalid share ID"),
  validate,
];


router.post("/share/accept/:token", wrap(shareCtrl.acceptInvite));

router.post("/:id/share", validateMongoId, wrap(shareCtrl.inviteUsers));
router.get("/:id/share", validateMongoId, wrap(shareCtrl.listAccess));
router.patch(
  "/:id/share/:shareId",
  validateMongoId,
  validateShareId,
  wrap(shareCtrl.changeRole),
);
router.delete(
  "/:id/share/:shareId",
  validateMongoId,
  validateShareId,
  wrap(shareCtrl.revokeAccess),
);
router.post(
  "/:id/share/:shareId/resend",
  validateMongoId,
  validateShareId,
  wrap(shareCtrl.resendInvite),
);
router.delete(
  "/:id/share/:shareId/cancel",
  validateMongoId,
  validateShareId,
  wrap(shareCtrl.cancelInvite),
);


const validateAttachmentId = [
  param("attachmentId").isMongoId().withMessage("Invalid attachment ID"),
  validate,
];

router.get(
  "/:id/attachments",
  validateMongoId,
  wrap(attachmentCtrl.listAttachments),
);
router.post(
  "/:id/attachments",
  validateMongoId,
  upload.single("file"),
  wrap(attachmentCtrl.uploadAttachment),
);

router.get(
  "/:id/attachments/:attachmentId",
  validateMongoId,
  validateAttachmentId,
  attachmentCtrl.downloadAttachment,
);
router.patch(
  "/:id/attachments/:attachmentId",
  validateMongoId,
  validateAttachmentId,
  [
    body("description").isString().withMessage("description must be a string"),
    validate,
  ],
  wrap(attachmentCtrl.updateAttachment),
);
router.delete(
  "/:id/attachments/:attachmentId",
  validateMongoId,
  validateAttachmentId,
  wrap(attachmentCtrl.deleteAttachment),
);



router.get("/:id/portal", validateMongoId, wrap(portalCtrl.getOwnerPortal));
router.put("/:id/portal", validateMongoId, wrap(portalCtrl.upsertPortal));
router.post(
  "/:id/portal/publish",
  validateMongoId,
  checkPortalPublishLimit,
  wrap(portalCtrl.togglePublish),
);



const validateTabId = [
  param("tabId").isMongoId().withMessage("Invalid tab ID"),
  validate,
];

router.post("/:id/custom-tabs", validateMongoId, wrap(ctrl.createCustomTab));
router.get("/:id/custom-tabs", validateMongoId, wrap(ctrl.listCustomTabs));
router.patch(
  "/:id/custom-tabs/:tabId",
  validateMongoId,
  validateTabId,
  wrap(ctrl.updateCustomTab),
);
router.delete(
  "/:id/custom-tabs/:tabId",
  validateMongoId,
  validateTabId,
  wrap(ctrl.deleteCustomTab),
);
router.patch(
  "/:id/custom-tabs/reorder",
  validateMongoId,
  wrap(ctrl.reorderCustomTabs),
);



router.use("/:id/apispec", validateMongoId, apispecRoutes);




router.post(
  "/mcp/list_projects",
  protect,
  checkTokenScope(["mcp"]),
  wrap(async (req, res) => {
    const userId = req.tokenAuth?.userId || req.user?.userId;
    const result = await MCPController.invokeTool(
      "list_projects",
      {},
      null,
      userId,
    );
    res.json(result);
  }),
);

router.use("/:id/mcp", validateMongoId, mcpRoutes);

export default router;
