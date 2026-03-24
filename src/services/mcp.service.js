import { Project } from "../models/Project.js";
import MCPController from "../api/controllers/project/mcp.controller.js";

/**
 * Slack integration needs an MCP-like facade, but it cannot use the public
 * MCP HTTP endpoints because it doesn't have Docnine API tokens available.
 *
 * This service calls the MCP controller in-process and maps outputs to the
 * legacy Slack controller expectations (field names/shapes).
 */
async function assertUserCanAccessProject(project, userId) {
  if (!project) {
    const err = new Error("Project not found");
    err.statusCode = 404;
    throw err;
  }

  // Check ownership
  const userIdStr = userId.toString();
  const isOwner = project.userId?.toString() === userIdStr;

  if (isOwner) {
    return; // Owner has access
  }

  // Check if user is a shared member
  const { ProjectShare } = await import("../models/ProjectShare.js");
  const share = await ProjectShare.findOne({
    projectId: project._id,
    inviteeUserId: userId,
    status: "accepted",
  });

  if (!share) {
    const err = new Error(
      "Access denied. You do not have permission to access this project."
    );
    err.statusCode = 403;
    throw err;
  }
}

async function getProjectOrThrow({ projectId, userId }) {
  const project = await Project.findById(projectId);
  await assertUserCanAccessProject(project, userId);
  return project;
}

function mapAskCodebaseToSlackShape(mcpResult) {
  // MCPController.askCodebase returns { answer: string, context: {...}, ... }
  return {
    response: mcpResult?.answer ?? "",
  };
}

function mapSecurityAuditToSlackShape(mcpResult) {
  // MCPController.getSecurityAudit returns { audit: {...}, summary: {...} }
  const audit = mcpResult?.audit ?? {};
  const summary = mcpResult?.summary ?? {};

  return {
    grade: audit.grade ?? "A",
    score: audit.score ?? 100,
    findings: audit.findings ?? [],
    counts: {
      CRITICAL: summary.critical ?? 0,
      HIGH: summary.high ?? 0,
      MEDIUM: summary.medium ?? 0,
      LOW: summary.low ?? 0,
    },
  };
}

function mapSecurityScoreToSlackShape(mcpResult) {
  // MCPController.getSecurityScore returns { score: { value, grade }, ... }
  const score = mcpResult?.score ?? {};
  return {
    grade: score.grade ?? "A",
    value: score.value ?? 100,
    breakdown: mcpResult?.breakdown ?? {},
  };
}

function mapDiffToSlackShape(mcpResult) {
  // Legacy Slack UI expects { added: string[], modified: string[] }
  const beforeSection = mcpResult?.recentChanges?.before?.section;
  const afterSection = mcpResult?.recentChanges?.after?.section;

  const modifiedSet = new Set();
  if (beforeSection) modifiedSet.add(beforeSection);
  if (afterSection) modifiedSet.add(afterSection);

  return {
    added: [],
    modified: Array.from(modifiedSet),
    deleted: [],
  };
}

function mapSearchDocsToSlackShape(mcpResult) {
  // MCPController.searchDocs returns { results: [{ section, preview }, ...] }
  const results = mcpResult?.results ?? [];
  return results.map((r) => ({
    title: r.section ?? "",
    excerpt: r.preview ?? "",
  }));
}

export async function getMcpService({ userId } = {}) {
  if (!userId) {
    throw new Error("getMcpService({ userId }) requires userId");
  }

  return {
    async ask_codebase({ projectId, question }) {
      const project = await getProjectOrThrow({ projectId, userId });
      const mcpResult = await MCPController.invokeTool(
        "ask_codebase",
        { question },
        project,
        userId,
      );
      return mapAskCodebaseToSlackShape(mcpResult);
    },

    async search_docs({ projectId, query }) {
      const project = await getProjectOrThrow({ projectId, userId });
      const mcpResult = await MCPController.invokeTool(
        "search_docs",
        { query },
        project,
        userId,
      );
      return mapSearchDocsToSlackShape(mcpResult);
    },

    async get_security_audit({ projectId }) {
      const project = await getProjectOrThrow({ projectId, userId });
      const mcpResult = await MCPController.invokeTool(
        "get_security_audit",
        {},
        project,
        userId,
      );
      return mapSecurityAuditToSlackShape(mcpResult);
    },

    async get_critical_findings({ projectId }) {
      const project = await getProjectOrThrow({ projectId, userId });
      const mcpResult = await MCPController.invokeTool(
        "get_critical_findings",
        {},
        project,
        userId,
      );
      return {
        findings: mcpResult?.findings ?? [],
        summary: mcpResult?.summary ?? {},
      };
    },

    async get_security_score({ projectId }) {
      const project = await getProjectOrThrow({ projectId, userId });
      const mcpResult = await MCPController.invokeTool(
        "get_security_score",
        {},
        project,
        userId,
      );
      return mapSecurityScoreToSlackShape(mcpResult);
    },

    async get_diff({ projectId }) {
      const project = await getProjectOrThrow({ projectId, userId });
      const mcpResult = await MCPController.invokeTool(
        "get_diff",
        {},
        project,
        userId,
      );
      return mapDiffToSlackShape(mcpResult);
    },
  };
}

