import { repoScannerAgent } from "../../../agents/repo-scanner.agent.js";
import { apiExtractorAgent } from "../../../agents/api-extractor.agent.js";
import { schemaAnalyserAgent } from "../../../agents/schema-analyser.agent.js";
import { componentMapperAgent } from "../../../agents/component-mapper.agent.js";
import { securityAuditorAgent } from "../../../agents/security-auditor.agent.js";
import { docWriterAgent } from "../../../agents/doc-writer.agent.js";
import { Project } from "../../../models/Project.js";
import {
  chat,
  createChatSession,
  ensureSession,
  getSuggestedQuestions,
} from "../../../services/chat.service.js";

function domainError(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function normalizeFiles(inputFiles = []) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
    throw domainError("files must be a non-empty array.", "VALIDATION_ERROR", 422);
  }

  const dedup = new Map();
  for (const item of inputFiles) {
    const filePath = normalizePath(item?.path);
    const content = typeof item?.content === "string" ? item.content : "";

    if (!filePath) continue;
    dedup.set(filePath, {
      path: filePath,
      content: content.slice(0, 300000),
    });
  }

  const files = Array.from(dedup.values());
  if (!files.length) {
    throw domainError("No valid files were provided.", "VALIDATION_ERROR", 422);
  }

  return files.slice(0, 2000);
}

function roleCount(structure, roles) {
  return roles.reduce((sum, role) => sum + (structure?.[role]?.length || 0), 0);
}

function mapSecurityFinding(item) {
  return {
    id: item.id || null,
    severity: item.severity || "LOW",
    title: item.title || item.description || "Security finding",
    file: item.file || "",
    line: item.line ? String(item.line) : "",
    advice: item.advice || "",
    source: item.source === "static" ? "static" : "llm",
  };
}

function mapDocOutput(writeDocs = {}, security = {}) {
  return {
    readme: writeDocs.readme || "",
    internalDocs: writeDocs.internalDocs || "",
    apiReference: writeDocs.apiReference || "",
    schemaDocs: writeDocs.schemaDocs || "",
    securityReport: security.reportMarkdown || "",
    componentRef: writeDocs.componentRef || "",
    componentIndex: writeDocs.componentIndex || "",
    remediationReport: security.remediationMarkdown || "",
  };
}

async function findOwnedProject({ projectId, userId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) {
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  }
  return project;
}

function buildStats({ files, endpoints, models, relationships, components }) {
  return {
    filesAnalysed: files.length,
    endpoints: endpoints.length,
    models: models.length,
    relationships: relationships.length,
    components: components.length,
  };
}

async function runFullCliPipeline({ files, project, agentsOnly = [] }) {
  const meta = {
    ...(project.meta || {}),
    name: project.meta?.name || project.repoName,
    description: project.meta?.description || "",
    language: project.meta?.language || "unknown",
    defaultBranch: project.meta?.defaultBranch || "main",
  };

  const scan = await repoScannerAgent({ files, meta });
  const projectMap = scan.projectMap || [];
  const structure = scan.structure || {};

  const routeFiles = roleCount(structure, ["route", "controller", "entry"]);
  const schemaFiles = roleCount(structure, ["model", "schema", "migration", "entity"]);
  const componentFiles = roleCount(
    structure,
    ["service", "middleware", "utility", "helper", "hook", "component", "store", "config", "guard", "provider"],
  );

  const wantsSecurityOnly =
    Array.isArray(agentsOnly) &&
    agentsOnly.length === 1 &&
    String(agentsOnly[0]).toLowerCase() === "security";

  const [
    apiRes,
    schemaRes,
    componentRes,
    securityRes,
  ] = await Promise.all([
    !wantsSecurityOnly && routeFiles > 0
      ? apiExtractorAgent({ files, projectMap })
      : Promise.resolve({ endpoints: [] }),
    !wantsSecurityOnly && schemaFiles > 0
      ? schemaAnalyserAgent({ files, projectMap })
      : Promise.resolve({ models: [], relationships: [] }),
    !wantsSecurityOnly && componentFiles > 0
      ? componentMapperAgent({ files, projectMap, structure })
      : Promise.resolve({ components: [] }),
    securityAuditorAgent({ files, projectMap }),
  ]);

  const endpoints = apiRes.endpoints || [];
  const models = schemaRes.models || [];
  const relationships = schemaRes.relationships || [];
  const components = componentRes.components || [];
  const security = {
    findings: (securityRes.findings || []).map(mapSecurityFinding),
    score: securityRes.score ?? 100,
    grade: securityRes.grade || "A",
    counts: securityRes.counts || { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    reportMarkdown: securityRes.reportMarkdown || "",
    remediationMarkdown: securityRes.remediationMarkdown || "",
  };

  if (wantsSecurityOnly) {
    return {
      techStack: scan.techStack || [],
      stats: buildStats({ files, endpoints: [], models: [], relationships: [], components: [] }),
      security,
      output: null,
      agentOutputs: {
        projectMap,
        endpoints: [],
        models: [],
        relationships: [],
        components: [],
        findings: security.findings,
      },
      scan,
    };
  }

  const docs = await docWriterAgent({
    meta,
    techStack: scan.techStack || [],
    structure,
    endpoints,
    models,
    relationships,
    components,
    entryPoints: scan.entryPoints || [],
    owner: project.repoOwner,
    repo: project.repoName,
  });

  return {
    techStack: scan.techStack || [],
    stats: buildStats({ files, endpoints, models, relationships, components }),
    security,
    output: mapDocOutput(docs, security),
    agentOutputs: {
      projectMap,
      endpoints,
      models,
      relationships,
      components,
      findings: security.findings,
    },
    scan,
  };
}

async function ensureProjectChatSession(project, outputOverride = null) {
  const effectiveOutput = outputOverride || {
    readme: project.editedOutput?.readme || project.output?.readme || "",
    internalDocs: project.editedOutput?.internalDocs || project.output?.internalDocs || "",
    apiReference: project.editedOutput?.apiReference || project.output?.apiReference || "",
    schemaDocs: project.editedOutput?.schemaDocs || project.output?.schemaDocs || "",
    securityReport: project.editedOutput?.securityReport || project.output?.securityReport || "",
  };

  const sessionId = project.chatSessionId || `cli-${project._id}-${Date.now()}`;
  if (project.chatSessionId) {
    ensureSession({ jobId: sessionId, output: effectiveOutput, meta: project.meta || {} });
  } else {
    createChatSession({ jobId: sessionId, output: effectiveOutput, meta: project.meta || {} });
    project.chatSessionId = sessionId;
  }

  return { sessionId, effectiveOutput };
}

export async function generateFromCli({ userId, projectId, files, agentsOnly = [] }) {
  const project = await findOwnedProject({ projectId, userId });
  const normalizedFiles = normalizeFiles(files);

  project.status = "running";
  project.errorMessage = null;
  await project.save();

  try {
    const result = await runFullCliPipeline({
      files: normalizedFiles,
      project,
      agentsOnly,
    });

    project.techStack = result.techStack;
    project.stats = result.stats;
    project.security = {
      ...project.security,
      score: result.security.score,
      grade: result.security.grade,
      counts: result.security.counts,
      findings: result.security.findings,
    };
    project.agentOutputs = result.agentOutputs;
    project.status = "done";
    project.errorMessage = null;
    project.search_language = "english";

    let chat = null;

    if (result.output) {
      project.output = {
        ...project.output,
        readme: result.output.readme,
        internalDocs: result.output.internalDocs,
        apiReference: result.output.apiReference,
        schemaDocs: result.output.schemaDocs,
        securityReport: result.output.securityReport,
      };

      const { sessionId } = await ensureProjectChatSession(project, {
        readme: result.output.readme,
        internalDocs: result.output.internalDocs,
        apiReference: result.output.apiReference,
        schemaDocs: result.output.schemaDocs,
        securityReport: result.output.securityReport,
      });

      chat = {
        sessionId,
        suggestedQuestions: getSuggestedQuestions({
          readme: result.output.readme,
          internalDocs: result.output.internalDocs,
          apiReference: result.output.apiReference,
          schemaDocs: result.output.schemaDocs,
          securityReport: result.output.securityReport,
        }),
      };
    }

    await project.save();

    // Log pipeline completion to changelog
    try {
      const { logProjectChange } = await import("../../../services/changelog.service.js");
      await logProjectChange(project._id, project.userId, "pipeline_completed", {
        details: "Analysis pipeline completed successfully",
        affectedCount: 5, // readme, api, schema, internal, security
      });
    } catch (err) {
      console.warn("[changelog] Failed to log pipeline completion:", err.message);
    }

    return {
      output: result.output,
      security: result.security,
      stats: result.stats,
      techStack: result.techStack,
      chat,
    };
  } catch (err) {
    project.status = "error";
    project.errorMessage = err.message || "CLI generation failed.";
    await project.save();

    // Log pipeline failure to changelog
    try {
      const { logProjectChange } = await import("../../../services/changelog.service.js");
      await logProjectChange(project._id, project.userId, "pipeline_failed", {
        details: `Pipeline failed: ${err.message || "unknown error"}`,
      });
    } catch (logErr) {
      console.warn("[changelog] Failed to log pipeline failure:", logErr.message);
    }
    throw err;
  }
}

export async function chatFromCli({ userId, projectId, question }) {
  const project = await findOwnedProject({ projectId, userId });
  const trimmedQuestion = String(question || "").trim();
  if (!trimmedQuestion) {
    throw domainError("question is required.", "VALIDATION_ERROR", 422);
  }

  const { sessionId } = await ensureProjectChatSession(project);
  if (!project.chatSessionId) {
    await project.save();
  }

  const result = await chat({
    jobId: sessionId,
    message: trimmedQuestion,
  });

  return {
    answer: result.reply || "",
    sources: [],
  };
}

// ── Helpers for diff / export ─────────────────────────────────

const CHANGETYPE_TO_DIFF = {
  section_edited: "modified",
  section_accepted: "modified",
  pipeline_completed: "added",
  pipeline_started: "modified",
  pipeline_failed: "removed",
  custom_tab_created: "added",
  custom_tab_updated: "modified",
  custom_tab_deleted: "removed",
};

function mapChangeLogEntry(entry) {
  const change = CHANGETYPE_TO_DIFF[entry.changeType] || "modified";
  const section = entry.section || entry.tabName || null;
  const docPath = section ? `docs/${section}` : `docs/pipeline`;
  const detail = entry.details || entry.changeType;
  return { change, path: docPath, detail };
}

function mergeEffectiveOutput(project) {
  const base = project.output?.toObject?.() || project.output || {};
  const edited = project.editedOutput?.toObject?.() || project.editedOutput || {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(edited)) {
    if (value) merged[key] = value;
  }
  return merged;
}

function buildOpenApiSpec(spec, project) {
  const endpoints = Array.isArray(spec?.endpoints) ? spec.endpoints : [];
  const paths = {};
  for (const ep of endpoints) {
    const method = String(ep?.method || "GET").toLowerCase();
    const routePath = String(ep?.path || "/").trim() || "/";
    if (!paths[routePath]) paths[routePath] = {};
    paths[routePath][method] = {
      summary: ep?.summary || "",
      description: ep?.description || "",
      operationId: ep?.operationId || undefined,
      tags: Array.isArray(ep?.tags) ? ep.tags : [],
      deprecated: Boolean(ep?.deprecated),
      parameters: Array.isArray(ep?.parameters)
        ? ep.parameters.filter((p) => String(p?.in || "").toLowerCase() !== "body")
        : [],
      requestBody: ep?.requestBody || undefined,
      responses: ep?.responses && typeof ep.responses === "object"
        ? ep.responses
        : { default: { description: "No response schema provided." } },
      security: ep?.security || undefined,
    };
  }
  const info = spec?.info || {};
  return {
    openapi: "3.0.0",
    info: {
      title: info.title || project?.meta?.name || "API Export",
      version: info.version || "1.0.0",
      description: info.description || "Generated by Docnine.",
    },
    servers: Array.isArray(spec?.servers) ? spec.servers : [],
    tags: Array.isArray(spec?.tags) ? spec.tags : [],
    paths,
    components: {
      schemas: spec?.schemas || {},
      securitySchemes: spec?.securitySchemes || {},
    },
  };
}

function buildOpenApiFromDocs(project, output) {
  const title = project.meta?.name ||
    (project.repoOwner && project.repoName ? `${project.repoOwner}/${project.repoName}` : "API Export");
  const text = `${output?.apiReference || ""}\n${output?.internalDocs || ""}`;
  const endpointRegex =
    /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+((?:\/|https?:\/\/)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%{}]+)\b/g;
  const paths = {};
  const seen = new Set();
  let match = endpointRegex.exec(text);
  while (match) {
    const method = String(match[1] || "GET").toLowerCase();
    let rawPath = String(match[2] || "/").trim();
    if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
      try { rawPath = new URL(rawPath).pathname || "/"; } catch { rawPath = "/"; }
    }
    if (!rawPath.startsWith("/")) rawPath = `/${rawPath}`;
    const key = `${method}:${rawPath}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (!paths[rawPath]) paths[rawPath] = {};
      paths[rawPath][method] = {
        summary: `${match[1]} ${rawPath}`,
        responses: { default: { description: "Extracted from generated API documentation." } },
      };
    }
    match = endpointRegex.exec(text);
  }
  return {
    openapi: "3.0.0",
    info: { title, version: "1.0.0", description: "Generated from Docnine API reference." },
    paths,
    components: { schemas: {}, securitySchemes: {} },
  };
}

function buildPostmanCollection(openapi) {
  const items = Object.keys(openapi.paths || {}).map((pathKey) => ({
    name: pathKey,
    item: Object.entries(openapi.paths[pathKey] || {}).map(([method, operation]) => ({
      name: operation?.summary || `${method.toUpperCase()} ${pathKey}`,
      request: {
        method: method.toUpperCase(),
        header: [],
        url: {
          raw: `{{baseUrl}}${pathKey}`,
          host: ["{{baseUrl}}"],
          path: pathKey.split("/").filter(Boolean),
        },
        description: operation?.description || "",
      },
    })),
  }));
  return {
    info: {
      name: openapi.info?.title || "Docnine Postman Export",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      description: "Generated by Docnine CLI",
    },
    variable: [{ key: "baseUrl", value: "" }],
    item: items,
  };
}

export async function diffFromCli({ userId, projectId, since }) {
  const project = await findOwnedProject({ projectId, userId });
  const { ProjectChangeLog } = await import("../../../models/ProjectChangeLog.js");

  const query = { projectId, userId };
  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      query.createdAt = { $gte: sinceDate };
    }
  }

  const changelog = await ProjectChangeLog
    .find(query)
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  const changes = changelog.map(mapChangeLogEntry);

  return {
    changes,
    since: project.lastDocumentedCommit || null,
    lastDocumentedAt: project.updatedAt?.toISOString?.() || null,
    mode: "server",
  };
}

export async function exportFromCli({ userId, projectId, format }) {
  const VALID_FORMATS = ["openapi", "postman", "markdown"];
  if (!VALID_FORMATS.includes(format)) {
    throw domainError("Unsupported format. Use: openapi, postman, markdown", "INVALID_FORMAT", 400);
  }

  const project = await findOwnedProject({ projectId, userId });
  if (project.status !== "done") {
    throw domainError("Documentation not ready. Pipeline has not completed yet.", "PROJECT_NOT_READY", 409);
  }

  const output = mergeEffectiveOutput(project);

  if (format === "markdown") {
    const sections = [
      output.readme && `# README\n\n${output.readme}`,
      output.apiReference && `# API Reference\n\n${output.apiReference}`,
      output.internalDocs && `# Internal Docs\n\n${output.internalDocs}`,
      output.schemaDocs && `# Schema Docs\n\n${output.schemaDocs}`,
      output.securityReport && `# Security Report\n\n${output.securityReport}`,
    ].filter(Boolean);
    return sections.join("\n\n---\n\n");
  }

  const { ApiSpec } = await import("../../../models/ApiSpec.js");
  const spec = await ApiSpec.findOne({ projectId }).lean();

  const openapi = spec
    ? buildOpenApiSpec(spec, project)
    : buildOpenApiFromDocs(project, output);

  if (format === "openapi") return openapi;
  return buildPostmanCollection(openapi);
}

