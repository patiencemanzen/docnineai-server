// ===================================================================
// Slack Security Alert Webhook
// Triggered after pipeline completes with security audit results
// ===================================================================

import { Project } from "../models/Project.js";
import { SlackIntegration } from "../models/SlackIntegration.js";
import { sendSecurityAlert } from "./slack.service.js";

/**
 * Called after pipeline completes successfully.
 * Checks for new CRITICAL/HIGH findings and sends Slack alerts.
 *
 * This is integrated into project.service.js runPipeline() completion.
 */
export async function triggerSecurityAlerts(projectId, securityData) {
  try {
    const integrations = await SlackIntegration.find({
      projectId,
      isActive: true,
      $or: [{ enableCriticalAlerts: true }, { enableHighAlerts: true }],
    });

    if (integrations.length === 0) {
      console.log(
        `[slack-webhook] No active Slack integrations for project ${projectId}`,
      );
      return;
    }

    const critical = securityData.findings.filter(
      (f) => f.severity === "CRITICAL",
    );
    const high = securityData.findings.filter((f) => f.severity === "HIGH");

    // Alert only if there are findings to report
    if (critical.length === 0 && high.length === 0) {
      console.log(
        `[slack-webhook] No CRITICAL/HIGH findings for project ${projectId}`,
      );
      return;
    }

    // Send alert to each configured workspace
    for (const integration of integrations) {
      try {
        // Check if we should alert based on current config
        const shouldAlertCritical =
          integration.enableCriticalAlerts && critical.length > 0;
        const shouldAlertHigh = integration.enableHighAlerts && high.length > 0;

        if (!shouldAlertCritical && !shouldAlertHigh) {
          continue; // Skip this integration
        }

        await sendSecurityAlert(projectId, integration.userId, securityData);

        // Update last alert timestamp
        integration.lastAlertSentAt = new Date();
        integration.lastAlertedCriticalCount = critical.length;
        integration.lastAlertedHighCount = high.length;
        integration.lastAlertedSecurityScore = securityData.score;
        await integration.save();

        console.log(
          `[slack-webhook] Alert sent to ${integration.workspaceName} (critical: ${critical.length}, high: ${high.length})`,
        );
      } catch (err) {
        console.error(
          `[slack-webhook] Failed to send alert to ${integration.workspaceName}:`,
          err.message,
        );
        await integration.recordEvent(
          "error",
          `Failed to send alert: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[slack-webhook] Error triggering security alerts for ${projectId}:`,
      err.message,
    );
  }
}

/**
 * Health check Slack tokens periodically.
 * Called from cron job to ensure tokens are still valid.
 */
export async function checkSlackHealthStatus() {
  try {
    const integrations = await SlackIntegration.find({
      isActive: true,
    });

    for (const integration of integrations) {
      try {
        const token = await integration.getDecryptedToken();
        // Simple health check: authenticate with Slack
        const response = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const data = await response.json();

        if (data.ok) {
          integration.healthStatus = "healthy";
          integration.healthMessage = "Token valid";
        } else {
          integration.healthStatus = "warning";
          integration.healthMessage = `API error: ${data.error}`;
        }

        integration.lastHealthCheck = new Date();
        await integration.save();
      } catch (err) {
        integration.healthStatus = "error";
        integration.healthMessage = err.message;
        integration.lastHealthCheck = new Date();
        await integration.save();

        await integration.recordEvent(
          "error",
          `Health check failed: ${err.message}`,
        );
      }
    }

    console.log("[slack-health] Health checks completed");
  } catch (err) {
    console.error("[slack-health] Error checking Slack health:", err.message);
  }
}
