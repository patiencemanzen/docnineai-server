import express from "express";
import { MCPController } from "../../controllers/project/mcp.controller.js";
import { protect } from "../../../middleware/auth.middleware.js";
import { checkTokenScope } from "../../../middleware/token-auth.middleware.js";

const router = express.Router({ mergeParams: true });

router.get("/health", MCPController.healthCheck);

router.get("/tools", protect, MCPController.listTools);

router.get("/info", protect, MCPController.getMCPInfo);

router.post("/call", protect, checkTokenScope(["mcp"]), MCPController.callTool);

router.post("/:tool", protect, checkTokenScope(["mcp"]), MCPController.callTool);

export default router;
