// ===================================================================
// Slack Service
// Handles all Slack API communication, message formatting, and alerts
// ===================================================================

import axios from "axios";
import crypto from "crypto";
import { SlackIntegration } from "../models/SlackIntegration.js";

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Initialize Slack client with bot token.
 * Token is decrypted on-demand for security.
 */
class SlackClient {
  constructor(botToken) {
    this.token = botToken;
    this.client = axios.create({
      baseURL: SLACK_API_BASE,
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  /**
   * Call any Slack API method.
   * @param {string} method - Slack API method (e.g., chat.postMessage)
   * @param {object} payload - Request payload
   * @returns {Promise<object>} Slack API response
   */
  async call(method, payload = {}) {
    try {
      const response = await this.client.post(`/${method}`, payload);
      if (!response.data.ok) {
        throw new Error(`Slack API error: ${response.data.error || "Unknown"}`);
      }
      return response.data;
    } catch (err) {
      console.error(`[slack:${method}] Error:`, err.message);
      throw err;
    }
  }

  /**
   * Post a message to a channel.
   */
  async postMessage(channelId, { text, blocks, threadTs = null }) {
    return this.call("chat.postMessage", {
      channel: channelId,
      text, // fallback
      blocks,
      thread_ts: threadTs,
    });
  }

  /**
   * Update an existing message.
   */
  async updateMessage(channelId, ts, { text, blocks }) {
    return this.call("chat.update", {
      channel: channelId,
      ts,
      text,
      blocks,
    });
  }

  /**
   * Open a modal (rarely used, but available).
   */
  async openModal(triggerId, { title, blocks, submit }) {
    return this.call("views.open", {
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "docnine_modal",
        title: { type: "plain_text", text: title },
        blocks,
        submit: { type: "plain_text", text: submit },
      },
    });
  }

  /**
   * Get user info.
   */
  async getUserInfo(userId) {
    return this.call("users.info", { user: userId });
  }

  /**
   * Get channel info.
   */
  async getChannelInfo(channelId) {
    return this.call("conversations.info", { channel: channelId });
  }
}

// ─────────────────────────────────────────────────────────────────
// Message Builders
// ─────────────────────────────────────────────────────────────────

/**
 * Build Slack blocks for a documentation answer.
 * Called by /docnine ask slash command.
 */
export function buildAnswerBlocks(answer, fileReferences = []) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Documentation Answer*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: answer,
      },
    },
  ];

  if (fileReferences.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*File References:*\n${fileReferences.map((f) => `• \`${f}\``).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Powered by Docnine MCP • <https://docnineai.com|Docs>`,
      },
    ],
  });

  return blocks;
}

/**
 * Build Slack blocks for security audit summary.
 */
export function buildSecurityAuditBlocks(audit) {
  const { score, grade, counts, findings } = audit;

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Security Audit Report`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Grade:* ${grade}`,
        },
        {
          type: "mrkdwn",
          text: `*Score:* ${score}/100`,
        },
        {
          type: "mrkdwn",
          text: `*CRITICAL:* ${counts.CRITICAL}`,
        },
        {
          type: "mrkdwn",
          text: `*HIGH:* ${counts.HIGH}`,
        },
        {
          type: "mrkdwn",
          text: `*MEDIUM:* ${counts.MEDIUM}`,
        },
        {
          type: "mrkdwn",
          text: `*LOW:* ${counts.LOW}`,
        },
      ],
    },
  ];

  // Top 5 findings
  if (findings.length > 0) {
    const topFindings = findings.slice(0, 5);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Top Findings:*\n" +
          topFindings
            .map((f) => `• ${f.severity}: ${f.title} - ${f.description}`)
            .join("\n"),
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Updated at ${new Date().toLocaleString()} • Powered by Docnine`,
      },
    ],
  });

  return blocks;
}

/**
 * Build alert blocks for critical/high findings.
 */
export function buildSecurityAlertBlocks(alerts, grade, score) {
  const iconMap = {
    CRITICAL: "🔴",
    HIGH: "🟠",
  };

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `⚠️ Security Alert - Grade ${grade} (${score}/100)`,
      },
    },
  ];

  for (const alert of alerts) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${iconMap[alert.severity]} *${alert.severity}*\n${alert.title}\n${alert.description}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Docnine Security Audit • Action required`,
      },
    ],
  });

  return blocks;
}

/**
 * Build diff blocks showing documentation changes.
 */
export function buildDiffBlocks(changes) {
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📝 Documentation Changes`,
      },
    },
  ];

  if (changes.added.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Added:*\n${changes.added.map((s) => `✅ ${s}`).join("\n")}`,
      },
    });
  }

  if (changes.modified.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Modified:*\n${changes.modified.map((s) => `🔄 ${s}`).join("\n")}`,
      },
    });
  }

  if (changes.deleted.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Deleted:*\n${changes.deleted.map((s) => `❌ ${s}`).join("\n")}`,
      },
    });
  }

  return blocks;
}

// ─────────────────────────────────────────────────────────────────
// Slack Service Functions
// ─────────────────────────────────────────────────────────────────

/**
 * Get active Slack integration for a project.
 */
export async function getSlackIntegration(projectId, userId) {
  const integration = await SlackIntegration.findOne({
    projectId,
    userId,
    isActive: true,
  }).select("+botTokenEncrypted");

  if (!integration) {
    throw new Error("Slack integration not found or inactive");
  }

  return integration;
}

/**
 * Get Slack client for a project.
 */
export async function getSlackClient(projectId, userId) {
  const integration = await getSlackIntegration(projectId, userId);
  const botToken = await integration.getDecryptedToken();
  return new SlackClient(botToken);
}

/**
 * Send a security alert to Slack.
 * Called by webhook when new CRITICAL/HIGH findings are detected.
 */
export async function sendSecurityAlert(projectId, userId, auditData) {
  try {
    const integration = await getSlackIntegration(projectId, userId);

    if (!integration.alertChannelId) {
      console.warn(
        `[slack] Alert channel not configured for project ${projectId}`,
      );
      return;
    }

    const client = await getSlackClient(projectId, userId);

    // Extract critical/high findings
    const critical = auditData.findings.filter(
      (f) => f.severity === "CRITICAL",
    );
    const high = auditData.findings.filter((f) => f.severity === "HIGH");

    const allAlerts = [...critical, ...high];

    if (allAlerts.length === 0) {
      return; // No alerts to send
    }

    const blocks = buildSecurityAlertBlocks(
      allAlerts,
      auditData.grade,
      auditData.score,
    );

    const text = `Security Alert: ${critical.length} CRITICAL, ${high.length} HIGH findings detected`;

    // Send with @channel ping if there are CRITICAL items and enabled
    const payload = {
      text,
      blocks,
    };

    if (critical.length > 0 && integration.pingOnCritical) {
      payload.blocks.unshift({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "<!channel> Immediate action required due to CRITICAL security findings",
        },
      });
    }

    await client.postMessage(integration.alertChannelId, payload);

    // Record the alert
    await integration.recordEvent(
      "alert_sent",
      `Alert sent: ${critical.length} CRITICAL, ${high.length} HIGH`,
    );

    console.log(
      `[slack] Alert sent to ${integration.alertChannelName} (${integration.workspaceName})`,
    );
  } catch (err) {
    console.error(
      `[slack] Failed to send security alert for project ${projectId}:`,
      err.message,
    );
  }
}

/**
 * Send a Slack message for a slash command response.
 */
export async function sendSlashCommandResponse(
  projectId,
  userId,
  respondUrl,
  response,
) {
  try {
    await axios.post(respondUrl, response, {
      timeout: 5000,
    });
  } catch (err) {
    console.error(
      `[slack] Failed to send slash command response: ${err.message}`,
    );
  }
}

/**
 * Verify Slack request signature.
 * Slack sends X-Slack-Request-Timestamp and X-Slack-Signature headers.
 */
export function verifySlackSignature(req, signingSecret) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];

  if (!timestamp || !signature) {
    return false;
  }

  // Ignore requests older than 5 minutes
  const requestTime = Math.floor(Date.now() / 1000);
  if (Math.abs(requestTime - parseInt(timestamp)) > 300) {
    return false;
  }

  // Get raw body as string
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const baseString = `v0:${timestamp}:${rawBody}`;

  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const expectedSignature = `v0=${hmac.digest("hex")}`;

  if (signature.length !== expectedSignature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(signature, "utf8"),
    Buffer.from(expectedSignature, "utf8"),
  );
}

export { SlackClient };
