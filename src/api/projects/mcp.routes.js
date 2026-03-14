import express from 'express';
import { MCPController } from './mcp.controller.js';
import { protect } from '../../middleware/auth.middleware.js';
import { authenticateAPIToken } from '../../middleware/token-auth.middleware.js';

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

// Call MCP tool (requires token auth)
// Supports both Bearer token and logged-in user
router.post('/call', authenticateAPIToken, MCPController.callTool);

// Direct tool endpoints (e.g., POST /api/projects/:projectId/mcp/get_project_docs)
// Supports all 12 available tools
router.post('/:tool', authenticateAPIToken, MCPController.callTool);

export default router;
