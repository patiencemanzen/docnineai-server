
import axios from "axios";
import { randomBytes } from "crypto";
import { SlackIntegration } from "../../../models/SlackIntegration.js";
import {
  sendSecurityAlert,
  sendSlashCommandResponse,
  verifySlackSignature,
} from "../../../services/slack.service.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";
import { NotificationService } from "../../../services/notification.service.js";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const APP_URL = process.env.APP_URL || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "";


export async function setCustomSlackCredentials(req, res) {
  try {
    const { projectId } = req.params;
    const { slackClientId, slackClientSecret, slackSigningSecret } = req.body;


    if (!slackClientId || !slackClientSecret || !slackSigningSecret) {
      return fail(
        res,
        "MISSING_CREDENTIALS",
        "Client ID, Client Secret, and Signing Secret are required",
        400
      );
    }


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


    integration.slackClientId = slackClientId;
    integration.slackClientSecret = slackClientSecret;
    integration.slackSigningSecret = slackSigningSecret;
    integration.isCustomApp = true;


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
        signingSecretLast4: slackSigningSecret.slice(-4),
      },
      "Custom Slack credentials saved successfully",
      201
    );
  } catch (err) {
    return serverError(res, err, "setCustomSlackCredentials");
  }
}




async function getOAuthCredentials(integration) {
  if (integration?.isCustomApp) {

    const clientId = await integration.getDecryptedClientId();
    const clientSecret = await integration.getDecryptedClientSecret();
    return { clientId, clientSecret, isCustom: true };
  }

  return {
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    isCustom: false,
  };
}


async function getSigningSecret(integration) {
  if (integration?.isCustomApp) {
    return integration.getDecryptedSigningSecret();
  }
  return SLACK_SIGNING_SECRET;
}

export async function initiateSlackOAuth(req, res) {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return fail(res, "MISSING_PROJECT", "Project ID is required", 400);
    }


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


    const state = randomBytes(32).toString("hex");
    integration.oauthState = state;
    await integration.save();


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


    const oauthUrl = new URL("https://slack.com/oauth/v2/authorize");
    oauthUrl.searchParams.append("client_id", clientId);
    oauthUrl.searchParams.append("scope", "chat:write,commands,users:read");
    oauthUrl.searchParams.append(
      "redirect_uri",
      `${APP_URL}/slack/oauth/callback`
    );
    oauthUrl.searchParams.append("state", state);
    oauthUrl.searchParams.append("user_scope", "");

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


    integration = await SlackIntegration.findOne({
      oauthState: state,
    });
    if (!integration) {

      return fail(res, "INVALID_STATE", "Invalid OAuth state", 403);
    }


    const { clientId, clientSecret, isCustom } = await getOAuthCredentials(integration);


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


    integration.botAccessToken = access_token;
    integration.workspaceId = workspaceId;
    integration.workspaceName = workspaceName;
    integration.botUserId = bot_user_id;
    integration.appId = app_id;
    integration.installedAt = new Date();
    integration.isActive = true;
    integration.oauthState = null;

    await integration.save();
    await integration.recordEvent(
      "installed",
      `App installed in ${workspaceName}`,
    );

    NotificationService.create({
      userId: integration.userId,
      type: "SLACK_CONNECTED",
      projectId: integration.projectId,
      actionUrl: `/projects/${integration.projectId}/settings`,
      metadata: { workspaceName },
    });


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




export async function handleSlashCommand(req, res) {
  try {
    const { team_id } = req.body;

    if (!team_id) {
      return res.status(400).json({ error: "Missing workspace ID" });
    }


    const integrationForSignature = await SlackIntegration.findOne({
      workspaceId: team_id,
      isActive: true,
    });


    let signingSecret = SLACK_SIGNING_SECRET;
    if (integrationForSignature?.isCustomApp) {
      signingSecret = await integrationForSignature.getDecryptedSigningSecret();
    }


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


    res.json({
      response_type: "in_channel",
      text: "Processing your request...",
    });


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
  const projectId = integration.projectId;
  const userId = integration.userId;

  try {

    try {
      await findIntegrationAndProjectOrThrow(team_id, projectId);
    } catch (err) {
      sendSlashCommandResponse(userId, projectId, response_url, {
        response_type: "ephemeral",
        text: `Error: ${err.message}`,
      }).catch(() => {});
      return;
    }


    const { getMcpService } = await import("../../../services/mcp.service.js");
    const mcp = await getMcpService({ userId });


    const trimmed = (text || "").trim();
    const spaceIdx = trimmed.indexOf(" ");
    const subcommand = spaceIdx === -1
      ? trimmed.toLowerCase()
      : trimmed.slice(0, spaceIdx).toLowerCase();
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    let response;

    switch (subcommand) {
      case "ask": {
        const question = rest;
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

      case "audit": {
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

      case "security": {
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

      case "diff": {
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

      case "docs": {
        const topic = rest;
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

      case "help":
      case "": {
        response = {
          response_type: "ephemeral",
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Docnine Commands" },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: [
                  "`/docnine ask [question]` : Ask about this codebase",
                  "`/docnine audit` : Run a security audit",
                  "`/docnine security` : Show critical/high findings",
                  "`/docnine diff` : Show documentation changes",
                  "`/docnine docs [topic]` : Search documentation",
                  "`/docnine help` : Show this help message",
                ].join("\n"),
              },
            },
          ],
        };
        break;
      }

      default: {
        response = {
          response_type: "ephemeral",
          text: `Unknown subcommand \`${subcommand}\`. Type \`/docnine help\` for available commands.`,
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




export async function handleSlackEvent(req, res) {
  try {
    const { type, challenge, event, team_id } = req.body;


    let signingSecret = SLACK_SIGNING_SECRET;

    if (team_id) {

      const integration = await SlackIntegration.findOne({
        workspaceId: team_id,
        isActive: true,
      });

      if (integration?.isCustomApp) {
        signingSecret = await integration.getDecryptedSigningSecret();
      }
    }


    if (!verifySlackSignature(req, signingSecret)) {
      return res.status(403).json({ error: "Invalid signature" });
    }


    if (type === "url_verification") {
      return res.json({ challenge });
    }


    if (type === "event_callback") {
      handleEventAsync(event).catch((err) => {
        console.error(`[slack] Event handler error: ${err.message}`);
      });
    }


    res.json({});
  } catch (err) {
    console.error("[slack] Event subscription error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
}

async function handleEventAsync(event) {

  console.log(`[slack] Event: ${event.type}`);
}




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

      if (integration?.isCustomApp && integration?.slackClientIdEncrypted) {
        let clientIdLast4 = "";
        let signingSecretLast4 = "";
        try {
          const clientId = await integration.getDecryptedClientId();
          clientIdLast4 = clientId ? clientId.slice(-4) : "";
        } catch {  }
        try {
          const signingSecret = await integration.getDecryptedSigningSecret();
          signingSecretLast4 = signingSecret ? signingSecret.slice(-4) : "";
        } catch {  }
        return ok(res, {
          configured: false,
          pendingCustomApp: true,
          clientIdLast4,
          signingSecretLast4,
        });
      }
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


export async function disconnectSlack(req, res) {
  try {
    const { projectId } = req.params;

    const integration = await SlackIntegration.findOneAndDelete({
      projectId,
      userId: req.user.userId,
    });

    if (integration) {
      NotificationService.create({
        userId: req.user.userId,
        type: "SLACK_DISCONNECTED",
        projectId,
        actionUrl: `/projects/${projectId}/settings`,
        metadata: {},
      });
    }

    return ok(res, {}, "Slack integration disconnected");
  } catch (err) {
    return serverError(res, err, "disconnectSlack");
  }
}
