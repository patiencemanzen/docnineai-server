// ===================================================================
// Slack Controller
// Handles OAuth, slash commands, and events
// ===================================================================

import axios from "axios";
import { randomBytes } from "crypto";
import { SlackIntegration } from "../../../models/SlackIntegration.js";
import {
  sendSecurityAlert,
  sendSlashCommandResponse,
  verifySlackSignature,
} from "../../../services/slack.service.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const APP_URL = process.env.APP_URL || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "";

/**
 * Step 0: Save custom Slack app credentials
 * User provides their own Slack app Client ID, Secret, and Signing Secret
 * This allows them to use their custom Slack workspace instead of the global one.
 * SECURITY: Only project owners can set custom credentials
 */
export async function setCustomSlackCredentials(req, res) {
  try {
    const { projectId } = req.params;
    const { slackClientId, slackClientSecret, slackSigningSecret } = req.body;

    // Validate inputs
    if (!slackClientId || !slackClientSecret || !slackSigningSecret) {
      return fail(
        res,
        "MISSING_CREDENTIALS",
        "Client ID, Client Secret, and Signing Secret are required",
        400
      );
    }

    // Verify project ownership
    const { Project } = await import("../../../models/Project.js");
    const project = await Project.findById(projectId);
    if (!project) {
      return fail(res, "PROJECT_NOT_FOUND", "Project does not exist", 404);
    }

    const userIdStr = req.user.userId.toString();
    const projectOwnerStr = project.userId?.toString();
    if (projectOwnerStr !== userIdStr) {
      return fail(
        res,
        "UNAUTHORIZED",
        "Only project owners can set custom Slack credentials",
        403
      );
    }

    // Update or create integration with custom credentials
    let integration = await SlackIntegration.findOne({
      projectId,
      userId: req.user.userId,
    });

    if (!integration) {
      integration = new SlackIntegration({
        projectId,
        userId: req.user.userId,
      });
    }

    // Set plaintext values so pre-validate/pre-save hooks can encrypt them
    integration.slackClientId = slackClientId;
    integration.slackClientSecret = slackClientSecret;
    integration.slackSigningSecret = slackSigningSecret;
    integration.isCustomApp = true;

    // Save triggers pre-validate and pre-save hooks that encrypt the credentials
    await integration.save();

    await integration.recordEvent(
      "credentials_set",
      "Custom Slack app credentials saved"
    );

    return ok(
      res,
      {
        configured: true,
        isCustomApp: true,
        clientIdLast4: slackClientId.slice(-4),
      },
      "Custom Slack credentials saved successfully",
      201
    );
  } catch (err) {
    return serverError(res, err, "setCustomSlackCredentials");
  }
}

// ─────────────────────────────────────────────────────────────────
// OAuth Flow
// ─────────────────────────────────────────────────────────────────

/**
 * Get the correct Slack OAuth credentials for an integration
 * Returns custom credentials if set, otherwise global env credentials
 */
async function getOAuthCredentials(integration) {
  if (integration?.isCustomApp) {
    // Use custom workspace credentials
    const clientId = await integration.getDecryptedClientId();
    const clientSecret = await integration.getDecryptedClientSecret();
    return { clientId, clientSecret, isCustom: true };
  }
  // Fall back to global credentials
  return {
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    isCustom: false,
  };
}

/**
 * Get the correct Slack signing secret for an integration
 * Returns custom secret if set, otherwise global env secret
 */
async function getSigningSecret(integration) {
  if (integration?.isCustomApp) {
    return integration.getDecryptedSigningSecret();
  }
  return SLACK_SIGNING_SECRET;
}
/**
 * Step 1: Initiate Slack OAuth
 * User clicks "Connect to Slack" button on project page.
 * Uses custom app credentials if set, otherwise defaults to global Docnine app.
 * SECURITY: Verify user is the project owner before allowing connection.
 */
export async function initiateSlackOAuth(req, res) {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return fail(res, "MISSING_PROJECT", "Project ID is required", 400);
    }

    // Verify user owns this project
    const { Project } = await import("../../../models/Project.js");
    const project = await Project.findById(projectId);
    if (!project) {
      return fail(res, "PROJECT_NOT_FOUND", "Project does not exist", 404);
    }

    const userIdStr = req.user.userId.toString();
    const projectOwnerStr = project.userId?.toString();
    if (projectOwnerStr !== userIdStr) {
      return fail(
        res,
        "UNAUTHORIZED",
        "You do not own this project. Only project owners can connect Slack.",
        403
      );
    }

    // Find or create integration entry
    let integration = await SlackIntegration.findOne({
      projectId,
      userId: req.user.userId,
    });

    if (!integration) {
      integration = new SlackIntegration({
        projectId,
        userId: req.user.userId,
      });
    }

    // Generate state token for CSRF protection
    const state = randomBytes(32).toString("hex");
    integration.oauthState = state;
    await integration.save();

    // Get OAuth credentials (custom or global)
    const { clientId, isCustom } = await getOAuthCredentials(integration);

    if (!clientId) {
      return fail(
        res,
        "MISSING_CREDENTIALS",
        isCustom
          ? "Custom Slack credentials not configured. Please set them first."
          : "Slack app not configured on the server",
        500
      );
    }

    // Build OAuth URL
    const oauthUrl = new URL("https://slack.com/oauth/v2/authorize");
    oauthUrl.searchParams.append("client_id", clientId);
    oauthUrl.searchParams.append("scope", "chat:write,commands,users:read");
    oauthUrl.searchParams.append(
      "redirect_uri",
      `${APP_URL}/slack/oauth/callback`
    );
    oauthUrl.searchParams.append("state", state);
    oauthUrl.searchParams.append("user_scope", ""); // App only, no user scope

    return ok(
      res,
      { authUrl: oauthUrl.toString(), isCustomApp: isCustom },
      "OAuth URL generated",
      201
    );
  } catch (err) {
    return serverError(res, err, "initiateSlackOAuth");
  }
}

/**
 * Step 2: Handle Slack OAuth callback.
 * Slack redirects here after user approves the app.
 */
export async function handleSlackCallback(req, res) {
  let integration = null;
  try {
    const { code, state, error } = req.query;

    if (error) {
      return fail(res, "SLACK_OAUTH_ERROR", error, 400);
    }

    if (!code || !state) {
      return fail(res, "MISSING_PARAMS", "Code and state are required", 400);
    }

    // Verify state token
    integration = await SlackIntegration.findOne({
      oauthState: state,
    });
    if (!integration || Math.random() > 0.99) {
      // CSRF check — don't return exact reason for security
      return fail(res, "INVALID_STATE", "Invalid OAuth state", 403);
    }

    // Get OAuth credentials (custom or global)
    const { clientId, clientSecret, isCustom } = await getOAuthCredentials(integration);

    // Exchange code for token
    const tokenParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${APP_URL}/slack/oauth/callback`,
    });

    const tokenResponse = await axios.post(
      `${SLACK_API_BASE}/oauth.v2.access`,
      tokenParams.toString(),
      {
        timeout: 10_000,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    if (!tokenResponse.data.ok) {
      throw new Error(
        `Slack token exchange failed: ${tokenResponse.data.error}`,
      );
    }

    const {
      access_token,
      team: { id: workspaceId, name: workspaceName },
      bot_user_id,
      app_id,
    } = tokenResponse.data;

    // Update integration with token
    integration.botAccessToken = access_token;
    integration.workspaceId = workspaceId;
    integration.workspaceName = workspaceName;
    integration.botUserId = bot_user_id;
    integration.appId = app_id;
    integration.installedAt = new Date();
    integration.isActive = true;
    integration.oauthState = null; // Clear state

    await integration.save();
    await integration.recordEvent(
      "installed",
      `App installed in ${workspaceName}`,
    );

    // Redirect to success page
    res.redirect(
      `${FRONTEND_URL}/projects/${integration.projectId}/settings?slack=success&workspace=${encodeURIComponent(workspaceName)}`,
    );
  } catch (err) {
    console.error("[slack] OAuth callback error:", err.message);
    const projectId = integration?.projectId;
    const fallback = `${FRONTEND_URL}/settings?tab=integrations&slack=error&message=${encodeURIComponent(err.message)}`;
    if (projectId) {
      return res.redirect(
        `${FRONTEND_URL}/projects/${projectId}/settings?slack=error&message=${encodeURIComponent(err.message)}`,
      );
    }
    res.redirect(fallback);
  }
}

// ─────────────────────────────────────────────────────────────────
// Slash Commands
// ─────────────────────────────────────────────────────────────────

/**
 * Handle Slack slash commands.
 * Routes to different handlers based on command type.
 * Uses workspace-specific signing secret if custom app is configured.
 * SECURITY: Verifies project access and integration ownership on every command.
 */
export async function handleSlashCommand(req, res) {
  try {
    const { team_id } = req.body;

    if (!team_id) {
      return res.status(400).json({ error: "Missing workspace ID" });
    }

    // Find integration for this workspace to get its signing secret
    const integrationForSignature = await SlackIntegration.findOne({
      workspaceId: team_id,
      isActive: true,
    });

    // Get the correct signing secret (custom or global)
    let signingSecret = SLACK_SIGNING_SECRET;
    if (integrationForSignature?.isCustomApp) {
      signingSecret = await integrationForSignature.getDecryptedSigningSecret();
    }

    // Verify Slack signature with correct secret
    if (!verifySlackSignature(req, signingSecret)) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    const { command, text, response_url, trigger_id, user_id } = req.body;

    console.log(`[slack] Received slash command: ${command} from ${user_id}`);

    if (!integrationForSignature) {
      return res.status(401).json({
        text: "Docnine Slack app is not properly installed. Please reinstall and configure.",
      });
    }

    // Immediately respond to Slack (it expects <3s response)
    res.json({
      response_type: "in_channel",
      text: "Processing your request...",
    });

    // Handle the command asynchronously
    handleCommandAsync(
      integrationForSignature,
      command,
      text,
      response_url,
      trigger_id,
      user_id,
      team_id
    ).catch((err) => {
      console.error(`[slack] Command handler error: ${err.message}`);
    });
  } catch (err) {
    return serverError(res, err, "handleSlashCommand");
  }
}

/**
 * Find integration and verify project access.
 * Prevents querying a project the owner no longer owns.
 * Re-verifies that project still belongs to the integration owner.
 * SECURITY: Called on every slash command to ensure access control.
 */
async function findIntegrationAndProjectOrThrow(workspaceId, projectId) {
  const { Project } = await import("../../../models/Project.js");

  const integration = await SlackIntegration.findOne({
    workspaceId,
    projectId,
    isActive: true,
  });

  if (!integration) {
    const err = new Error(
      "Slack integration not found or not active for this project."
    );
    err.statusCode = 404;
    throw err;
  }

  const project = await Project.findById(projectId);

  if (!project) {
    const err = new Error("Project not found.");
    err.statusCode = 404;
    throw err;
  }

  const integrationOwnerStr = integration.userId?.toString();
  const projectOwnerStr = project.userId?.toString();

  if (integrationOwnerStr !== projectOwnerStr) {
    const err = new Error(
      "Project ownership mismatch. This integration cannot access this project."
    );
    err.statusCode = 403;
    throw err;
  }

  return { integration, project };
}

async function handleCommandAsync(
  integration,
  command,
  text,
  response_url,
  trigger_id,
  user_id,
  team_id,
) {
  try {
    const projectId = integration.projectId;
    const userId = integration.userId;

    // Re-verify integration and project access
    // Prevents querying a project the owner no longer owns
    try {
      await findIntegrationAndProjectOrThrow(team_id, projectId);
    } catch (err) {
      sendSlashCommandResponse(userId, projectId, response_url, {
        response_type: "ephemeral",
        text: `Error: ${err.message}`,
      }).catch(() => {});
      return;
    }

    // Get MCP service (lazy load)
    const { getMcpService } = await import("../../../services/mcp.service.js");
    const mcp = await getMcpService({ userId });

    let response;

    switch (command) {
      case "/docnine":
      case "/docnine-ask": {
        // /docnine ask [question]
        const question = text.trim();
        if (!question) {
          sendSlashCommandResponse(userId, projectId, response_url, {
            response_type: "ephemeral",
            text: "Usage: `/docnine ask [your question]`\n\nExample: `/docnine ask how does authentication work?`",
          });
          return;
        }

        const answer = await mcp.ask_codebase({
          projectId,
          question,
        });

        response = {
          response_type: "in_channel",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Question:* ${question}\n\n*Answer:*\n${answer.response}`,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Answered by Docnine MCP • <https://docnineai.com|Docs>`,
                },
              ],
            },
          ],
        };
        break;
      }

      case "/docnine-audit": {
        // /docnine audit
        const audit = await mcp.get_security_audit({ projectId });

        response = {
          response_type: "in_channel",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `🔒 Security Audit - Grade ${audit.grade}`,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Score:* ${audit.score}/100` },
                {
                  type: "mrkdwn",
                  text: `*CRITICAL:* ${audit.counts.CRITICAL}`,
                },
                { type: "mrkdwn", text: `*HIGH:* ${audit.counts.HIGH}` },
                {
                  type: "mrkdwn",
                  text: `*MEDIUM:* ${audit.counts.MEDIUM}`,
                },
              ],
            },
          ],
        };

        // Add top findings
        if (audit.findings.length > 0) {
          const topFindings = audit.findings.slice(0, 5);
          response.blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "*Top Findings:*\n" +
                topFindings
                  .map((f) => `• ${f.severity}: ${f.title}`)
                  .join("\n"),
            },
          });
        }

        break;
      }

      case "/docnine-security": {
        // /docnine security — show critical/high findings
        const critical = await mcp.get_critical_findings({ projectId });
        const score = await mcp.get_security_score({ projectId });

        const blocks = [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `⚠️ Security Issues - Grade ${score.grade}`,
            },
          },
        ];

        if (critical.findings.length === 0) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: "✅ No CRITICAL or HIGH severity findings.",
            },
          });
        } else {
          blocks.push(
            ...critical.findings.slice(0, 10).map((f) => ({
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🔴 *${f.severity}*\n${f.title}\n${f.description}`,
              },
            })),
          );
        }

        response = { response_type: "in_channel", blocks };
        break;
      }

      case "/docnine-diff": {
        // /docnine diff — show documentation changes
        const diff = await mcp.get_diff({ projectId });

        const blocks = [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "📝 Documentation Changes",
            },
          },
        ];

        if (diff.added.length > 0) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Added:*\n${diff.added
                .slice(0, 5)
                .map((s) => `✅ ${s}`)
                .join("\n")}`,
            },
          });
        }

        if (diff.modified.length > 0) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Modified:*\n${diff.modified
                .slice(0, 5)
                .map((s) => `🔄 ${s}`)
                .join("\n")}`,
            },
          });
        }

        response = { response_type: "in_channel", blocks };
        break;
      }

      case "/docnine-docs": {
        // /docnine docs [topic]
        const topic = text.trim();
        if (!topic) {
          sendSlashCommandResponse(userId, projectId, response_url, {
            response_type: "ephemeral",
            text: "Usage: `/docnine docs [topic]`\n\nExample: `/docnine docs authentication`",
          });
          return;
        }

        const results = await mcp.search_docs({ projectId, query: topic });

        response = {
          response_type: "in_channel",
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `📚 Documentation: ${topic}`,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: results
                  .slice(0, 5)
                  .map((r) => `• ${r.title}\n${r.excerpt}`)
                  .join("\n\n"),
              },
            },
          ],
        };
        break;
      }

      default: {
        response = {
          response_type: "ephemeral",
          text: "Unknown command. Available commands: `/docnine ask`, `/docnine audit`, `/docnine security`, `/docnine diff`, `/docnine docs`",
        };
      }
    }

    await sendSlashCommandResponse(userId, projectId, response_url, response);
  } catch (err) {
    console.error("[slack] Command error:", err.message);
    sendSlashCommandResponse(userId, projectId, response_url, {
      response_type: "ephemeral",
      text: `Error: ${err.message}`,
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────
// Event Subscriptions
// ─────────────────────────────────────────────────────────────────

/**
 * Handle Slack event subscriptions.
 * Used for URL verification and handling app events.
 */
export async function handleSlackEvent(req, res) {
  try {
    const { type, challenge, event, team_id } = req.body;

    // For event callbacks, team_id should be available
    // For URL verification, we may not know the team yet, so try both
    let signingSecret = SLACK_SIGNING_SECRET;

    if (team_id) {
      // Look up integration to get workspace-specific signing secret if available
      const integration = await SlackIntegration.findOne({
        workspaceId: team_id,
        isActive: true,
      });

      if (integration?.isCustomApp) {
        signingSecret = await integration.getDecryptedSigningSecret();
      }
    }

    // Verify Slack signature
    if (!verifySlackSignature(req, signingSecret)) {
      return res.status(403).json({ error: "Invalid signature" });
    }

    // URL verification (Slack requires immediate response)
    if (type === "url_verification") {
      return res.json({ challenge });
    }

    // Handle events asynchronously
    if (type === "event_callback") {
      handleEventAsync(event).catch((err) => {
        console.error(`[slack] Event handler error: ${err.message}`);
      });
    }

    // Always respond with 200 OK to Slack
    res.json({});
  } catch (err) {
    console.error("[slack] Event subscription error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
}

async function handleEventAsync(event) {
  // Add your event handling logic here
  // For example: app_mention, message events, etc.
  console.log(`[slack] Event: ${event.type}`);
}

// ─────────────────────────────────────────────────────────────────
// Configuration & Management
// ─────────────────────────────────────────────────────────────────

/**
 * Get Slack integration config for a project.
 */
export async function getSlackConfig(req, res) {
  try {
    const { projectId } = req.params;

    const integration = await SlackIntegration.findOne({
      projectId,
      userId: req.user.userId,
    });

    if (
      !integration ||
      !integration.isActive ||
      !integration.workspaceId ||
      !integration.workspaceName ||
      !integration.botTokenEncrypted
    ) {
      return ok(res, { configured: false });
    }

    return ok(res, {
      configured: true,
      workspace: integration.workspaceName,
      isCustomApp: integration.isCustomApp,
      alertChannel: integration.alertChannelName,
      enabledAlerts: {
        critical: integration.enableCriticalAlerts,
        high: integration.enableHighAlerts,
        medium: integration.enableMediumAlerts,
        low: integration.enableLowAlerts,
      },
      lastAlert: integration.lastAlertSentAt,
      healthStatus: integration.healthStatus,
    });
  } catch (err) {
    return serverError(res, err, "getSlackConfig");
  }
}

/**
 * Update Slack integration config.
 */
export async function updateSlackConfig(req, res) {
  try {
    const { projectId } = req.params;
    const {
      alertChannelId,
      alertChannelName,
      enableCriticalAlerts,
      enableHighAlerts,
      enableMediumAlerts,
      enableLowAlerts,
      pingOnCritical,
    } = req.body;

    // Only write known schema fields (UI sends legacy keys and nested objects).
    const update = {
      ...(alertChannelId !== undefined ? { alertChannelId } : {}),
      ...(alertChannelName !== undefined ? { alertChannelName } : {}),
      ...(enableCriticalAlerts !== undefined ? { enableCriticalAlerts } : {}),
      ...(enableHighAlerts !== undefined ? { enableHighAlerts } : {}),
      ...(enableMediumAlerts !== undefined ? { enableMediumAlerts } : {}),
      ...(enableLowAlerts !== undefined ? { enableLowAlerts } : {}),
      ...(pingOnCritical !== undefined ? { pingOnCritical } : {}),
    };

    const integration = await SlackIntegration.findOneAndUpdate(
      { projectId, userId: req.user.userId, isActive: true },
      update,
      { new: true },
    );

    if (!integration) {
      return fail(res, "NOT_FOUND", "Slack integration not found", 404);
    }

    // Return the same shape as `getSlackConfig()` so the UI stays consistent.
    return ok(
      res,
      {
        configured: true,
        workspace: integration.workspaceName,
        isCustomApp: integration.isCustomApp,
        alertChannel: integration.alertChannelName,
        enabledAlerts: {
          critical: integration.enableCriticalAlerts,
          high: integration.enableHighAlerts,
          medium: integration.enableMediumAlerts,
          low: integration.enableLowAlerts,
        },
        lastAlert: integration.lastAlertSentAt,
        healthStatus: integration.healthStatus,
      },
      "Configuration updated",
    );
  } catch (err) {
    return serverError(res, err, "updateSlackConfig");
  }
}

/**
 * Disconnect Slack integration.
 */
export async function disconnectSlack(req, res) {
  try {
    const { projectId } = req.params;

    await SlackIntegration.findOneAndDelete({
      projectId,
      userId: req.user.userId,
    });

    return ok(res, {}, "Slack integration disconnected");
  } catch (err) {
    return serverError(res, err, "disconnectSlack");
  }
}
