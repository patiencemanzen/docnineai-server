// ===================================================================
// Slack Routes
// All Slack OAuth, events, and slash command endpoints
// ===================================================================

import express from "express";
import {
  setCustomSlackCredentials,
  initiateSlackOAuth,
  handleSlackCallback,
  handleSlashCommand,
  handleSlackEvent,
  getSlackConfig,
  updateSlackConfig,
  disconnectSlack,
} from "../../controllers/slack/slack.controller.js";
import { protect } from "../../../middleware/auth.middleware.js";

const router = express.Router();


// ── Custom Slack App Setup ─────────────────────────────────────
// Protected endpoints — auth required

/**
 * Set custom Slack credentials for a project
 * Allows users to connect their own Slack app instead of using global one
 */
router.post("/credentials/:projectId", protect, setCustomSlackCredentials);

// ── OAuth Flow ─────────────────────────────────────────────────
// OAuth start requires the current Docnine user

/**
 * Initiate Slack OAuth flow
 * Uses custom credentials if configured, otherwise uses global app
 */
router.post("/oauth/start", protect, initiateSlackOAuth);

/**
 * Handle Slack OAuth callback
 */
router.get("/oauth/callback", handleSlackCallback);

// ── Slash Commands & Events ────────────────────────────────────
// Public endpoints — verified via Slack signature

/**
 * Handle slash commands
 * Slack sends: /docnine ask, /docnine audit, /docnine security, etc.
 * Body is already parsed as urlencoded by middleware in app.js
 */
router.post("/commands", handleSlashCommand);

/**
 * Handle Slack events and URL verification
 * Body parsing + rawBody capture handled in app.js middleware
 */
router.post("/events", handleSlackEvent);

// ── Configuration ──────────────────────────────────────────────
// Protected endpoints — auth required

/**
 * Get Slack integration config for a project
 */
router.get("/config/:projectId", protect, getSlackConfig);

/**
 * Update Slack integration config (alert channel, preferences, etc.)
 */
router.put("/config/:projectId", protect, updateSlackConfig);

/**
 * Disconnect Slack integration
 */
router.delete("/:projectId", protect, disconnectSlack);

export default router;
