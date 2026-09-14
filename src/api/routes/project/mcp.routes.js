import express from 'express';
import { MCPController } from '../../controllers/project/mcp.controller.js';
import { protect } from '../../../middleware/auth.middleware.js';
import { checkTokenScope } from '../../../middleware/token-auth.middleware.js';

const router = express.Router({ mergeParams: true });

/**
 * MCP Server Routes
 * Pattern: /api/projects/:projectId/mcp/*
 * 
 * Supports:
 * - Claude, Cursor, VS Code, and other MCP-compatible tools
 * - Bearer token authentication (API tokens from dashboard)
 * - Per-project isolation
 */

// Health check (public, no auth required)
router.get('/health', MCPController.healthCheck);

// List available tools (requires auth)
router.get('/tools', protect, MCPController.listTools);

// Get MCP server info (requires auth)
router.get('/info', protect, MCPController.getMCPInfo);

// Call MCP tool (JWT session or API token). protect() already accepts docnine_ tokens.
router.post('/call', protect, checkTokenScope(['mcp']), MCPController.callTool);

// Direct tool endpoints (e.g., POST /projects/:id/mcp/get_project_docs)
router.post('/:tool', protect, checkTokenScope(['mcp']), MCPController.callTool);

export default router;
