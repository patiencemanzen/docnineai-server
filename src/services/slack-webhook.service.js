import { Project } from "../models/Project.js";
import { SlackIntegration } from "../models/SlackIntegration.js";
import { sendSecurityAlert } from "./slack.service.js";

export async function triggerSecurityAlerts(projectId, securityData) {
  try {
    const integrations = await SlackIntegration.find({
      projectId,
      isActive: true,
      $or: [{ enableCriticalAlerts: true }, { enableHighAlerts: true }],
    });

    if (integrations.length === 0) {
      console.log(`[slack-webhook] No active Slack integrations for project ${projectId}`);
      return;
    }

    const critical = securityData.findings.filter((f) => f.severity === "CRITICAL");
    const high = securityData.findings.filter((f) => f.severity === "HIGH");

    if (critical.length === 0 && high.length === 0) {
      console.log(`[slack-webhook] No CRITICAL/HIGH findings for project ${projectId}`);
      return;
    }

    for (const integration of integrations) {
      try {
        const shouldAlertCritical = integration.enableCriticalAlerts && critical.length > 0;
        const shouldAlertHigh = integration.enableHighAlerts && high.length > 0;

        if (!shouldAlertCritical && !shouldAlertHigh) {
          continue;
        }

        await sendSecurityAlert(projectId, integration.userId, securityData);

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
        await integration.recordEvent("error", `Failed to send alert: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(
      `[slack-webhook] Error triggering security alerts for ${projectId}:`,
      err.message,
    );
  }
}

export async function checkSlackHealthStatus() {
  try {
    const integrations = await SlackIntegration.find({
      isActive: true,
    });

    for (const integration of integrations) {
      try {
        const token = await integration.getDecryptedToken();

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

        await integration.recordEvent("error", `Health check failed: ${err.message}`);
      }
    }

    console.log("[slack-health] Health checks completed");
  } catch (err) {
    console.error("[slack-health] Error checking Slack health:", err.message);
  }
}
