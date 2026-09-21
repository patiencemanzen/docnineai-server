import { getAdapter, detectProvider, createRepoAdapter } from "../adapters/provider.adapter.js";

import { repoScannerAgent } from "../agents/repo-scanner.agent.js";
import { apiExtractorAgent } from "../agents/api-extractor.agent.js";
import { schemaAnalyserAgent } from "../agents/schema-analyser.agent.js";
import { componentMapperAgent } from "../agents/component-mapper.agent.js";
import {
  docWriterAgent,
  buildApiReference,
  buildSchemaDocs,
  buildComponentIndex,
} from "../agents/doc-writer.agent.js";
import { securityAuditorAgent } from "../agents/security-auditor.agent.js";
import { createChatSession, getSuggestedQuestions } from "./chat.service.js";
import { updateFileManifest } from "./diff.service.js";

const isVercel = !!process.env.VERCEL;
const isProduction = process.env.NODE_ENV === "production";

const fastMode = isVercel && isProduction;

const TIMEOUTS = fastMode
  ? {
      fetch: 15_000,
      scan: 5_000,
      api: 5_000,
      schema: 5_000,
      components: 5_000,
      security: 5_000,
      write: 30_000,
      chat: 10_000,
    }
  : {
      fetch: 120_000,
      scan: 240_000,
      api: 180_000,
      schema: 180_000,
      components: 180_000,
      security: 240_000,
      write: 300_000,
      chat: 30_000,
    };

const ROUTING = {
  minRouteFiles: 1,

  minSchemaFiles: 1,

  minComponentFiles: 1,

  minCodeFiles: 3,

  minDocumentableItems: 1,
};

async function withTimeout(fn, ms, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timeoutHandle);
    return { result };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return { error: err, timedOut: err.message.includes("timed out") };
  }
}

async function runAgent({ label, step, fn, timeout, emit, fallback }) {
  const start = Date.now();
  emit(step, "running", `Starting ${label}…`);

  const { result, error, timedOut } = await withTimeout(fn, timeout, label);

  const duration = Date.now() - start;

  if (error) {
    const reason = timedOut ? `${label} timed out after ${timeout / 1000}s` : error.message;

    emit(step, "error", `${label} failed : using fallback`, reason);

    if (!timedOut) {
      console.error(`[${step}:error] ${label} full details:`, {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
    }
    console.error(`[${step}:error] ${label}:`, error);

    return { ...fallback, _failed: true, _error: reason, _duration: duration };
  }

  emit(step, "done", `${label} complete`, `${(duration / 1000).toFixed(1)}s`);
  return { ...result, _duration: duration };
}

const ROUTING_PATH_PATTERNS = {
  route:
    /route[s]?\/|controller[s]?\/|handler[s]?\/|endpoint[s]?\/|\.route\.[jt]sx?$|\.controller\.[jt]sx?$|pages\/api\/|app\/api\//i,
  schema:
    /model[s]?\/|schema[s]?\/|entit(?:y|ies)\/|migration[s]?\/|database\/|db\/|orm\/|\.model\.[jt]sx?$|\.schema\.[jt]sx?$|\.entity\.[jt]sx?$/i,
  component:
    /service[s]?\/|middleware[s]?\/|util[s]?\/|helper[s]?\/|hook[s]?\/|config[s]?\/|provider[s]?\/|store[s]?\//i,
};

function computeRouting(projectMap, structure, files) {
  const roles = Object.fromEntries(
    Object.entries(structure).map(([role, paths]) => [role, paths.length]),
  );

  const routeFileCount = (roles.route ?? 0) + (roles.controller ?? 0) + (roles.entry ?? 0);
  const schemaFileCount =
    (roles.model ?? 0) + (roles.schema ?? 0) + (roles.migration ?? 0) + (roles.entity ?? 0);
  const componentFileCount =
    (roles.service ?? 0) +
    (roles.middleware ?? 0) +
    (roles.hook ?? 0) +
    (roles.component ?? 0) +
    (roles.utility ?? 0) +
    (roles.helper ?? 0) +
    (roles.store ?? 0) +
    (roles.guard ?? 0) +
    (roles.provider ?? 0);

  const codeFileCount = files.filter(
    (f) => !/\.(md|yaml|yml|txt|svg|png|jpg|json|lock)$/i.test(f.path),
  ).length;

  let pathRouteCount = 0;
  let pathSchemaCount = 0;
  let pathComponentCount = 0;

  if (projectMap.length === 0 && files.length > 0) {
    const isTestPath = /test|spec|__mock|fixture/i;
    pathRouteCount = files.filter(
      (f) => ROUTING_PATH_PATTERNS.route.test(f.path) && !isTestPath.test(f.path),
    ).length;
    pathSchemaCount = files.filter(
      (f) => ROUTING_PATH_PATTERNS.schema.test(f.path) && !isTestPath.test(f.path),
    ).length;
    pathComponentCount = files.filter(
      (f) => ROUTING_PATH_PATTERNS.component.test(f.path) && !isTestPath.test(f.path),
    ).length;
  }

  const effectiveRouteCount = routeFileCount + pathRouteCount;
  const effectiveSchemaCount = schemaFileCount + pathSchemaCount;
  const effectiveComponentCount = componentFileCount + pathComponentCount;

  const runApi = effectiveRouteCount >= ROUTING.minRouteFiles;
  const runSchema = effectiveSchemaCount >= ROUTING.minSchemaFiles;
  const runComponents = effectiveComponentCount >= ROUTING.minComponentFiles;
  const runSecurity = codeFileCount >= ROUTING.minCodeFiles;

  return {
    runApi,
    runSchema,
    runComponents,
    runSecurity,
    reasons: {
      api: runApi ? null : `Only ${effectiveRouteCount} route/controlleer files found`,
      schema: runSchema ? null : `Only ${effectiveSchemaCount} model/schema files found`,
      components: runComponents
        ? null
        : `Only ${effectiveComponentCount} component/service files found`,
      security: runSecurity ? null : `Only ${codeFileCount} code files : below threshold`,
    },
    counts: {
      routeFiles: effectiveRouteCount,
      schemaFiles: effectiveSchemaCount,
      componentFiles: effectiveComponentCount,
      codeFiles: codeFileCount,
    },
  };
}

const FALLBACKS = {
  scan: {
    projectMap: [],
    techStack: [],
    testFrameworks: [],
    entryPoints: [],
    keyFiles: [],
    structure: {},
    layerMap: {},
    flagsSummary: {},
    architectureHint: "unknown",
    summary: {},
  },
  api: {
    endpoints: [],
    summary: {
      total: 0,
      authRequired: 0,
      deprecated: 0,
      byMethod: {},
      tags: [],
    },
  },
  schema: {
    models: [],
    relationships: [],
    summary: {},
  },
  components: {
    components: [],
    summary: {},
  },
  security: {
    findings: [],
    score: 100,
    grade: "A",
    counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    categoryCounts: {},
    affectedFiles: [],
    summary: {},
    reportMarkdown: "# Security Audit\n\nAgent did not run.\n",
    remediationMarkdown: "# Remediation Plan\n\nNo findings.\n",
  },
  write: {
    readme: "# README\n\nDocumentation could not be generated.\n",
    internalDocs: "# Internal Docs\n\nDocumentation could not be generated.\n",

    apiReference: "",
    schemaDocs: "",
    componentRef: "# Component Reference\n\nNo data available.\n",
    componentIndex: "",
    summary: {},
  },
};

function buildPipelineReport(steps) {
  const totalDuration = steps.reduce((s, step) => s + (step.duration ?? 0), 0);
  const failed = steps.filter((s) => s.status === "error");
  const skipped = steps.filter((s) => s.status === "skipped");
  const succeeded = steps.filter((s) => s.status === "done");

  let md = `# Pipeline Execution Report\n\n`;
  md += `| Step | Status | Duration | Detail |\n`;
  md += `|------|--------|----------|--------|\n`;

  for (const step of steps) {
    const statusEmoji =
      {
        done: "✅",
        error: "❌",
        skipped: "⏭️",
        running: "⏳",
      }[step.status] || ":";

    const dur = step.duration != null ? `${(step.duration / 1000).toFixed(1)}s` : ":";
    md += `| **${step.label}** | ${statusEmoji} ${step.status} | ${dur} | ${step.detail || ":"} |\n`;
  }

  md += `\n**Total duration:** ${(totalDuration / 1000).toFixed(1)}s`;
  md += ` · **${succeeded.length} succeeded**`;
  if (skipped.length) md += ` · **${skipped.length} skipped**`;
  if (failed.length) md += ` · **${failed.length} failed**`;
  md += "\n";

  return { md, failed, skipped, succeeded, totalDuration };
}

export async function orchestrate(repoUrl, onProgress, authContext = {}) {
  const pipelineStart = Date.now();
  const pipelineSteps = [];
  const agentErrors = [];

  const emit = (step, status, msg, detail = null, duration = null) => {
    const event = { step, status, msg, detail, ts: Date.now(), duration };
    console.log(
      `[${step}:${status}] ${msg}${detail ? " : " + detail : ""}${duration ? ` (${(duration / 1000).toFixed(1)}s)` : ""}`,
    );
    if (onProgress) onProgress(event);
  };

  const trackStep = (label, status, detail = null, duration = null) => {
    pipelineSteps.push({ label, status, detail, duration });
  };

  let meta, files, owner, repo;

  const isPrefetched = typeof repoUrl === "object" && repoUrl !== null && repoUrl.files;

  if (isPrefetched) {
    emit("fetch", "running", "Using pre-extracted files…");
    const fetchStart = Date.now();
    ({ meta, files, owner, repo } = repoUrl);
    const fetchDuration = Date.now() - fetchStart;
    emit(
      "fetch",
      "done",
      `${files.length} pre-extracted files ready`,
      `${owner}/${repo}`,
      fetchDuration,
    );
    trackStep("Fetch Repo", "done", `${files.length} files (pre-extracted)`, fetchDuration);
  } else {
    const provider = authContext.provider || detectProvider(repoUrl);
    const adapter = getAdapter(provider);
    emit("fetch", "running", `Connecting to ${provider}…`);
    const fetchStart = Date.now();

    try {
      const fetched = await Promise.race([
        adapter.fetchRepoFilesWithProgress(
          repoUrl,
          (msg) => emit("fetch", "running", msg),
          authContext.token,
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Repository fetch timed out")), TIMEOUTS.fetch),
        ),
      ]);
      ({ meta, files, owner, repo } = fetched);
    } catch (err) {
      emit("fetch", "error", "Failed to fetch repository", err.message);
      return { success: false, error: err.message, phase: "fetch" };
    }

    const fetchDuration = Date.now() - fetchStart;
    emit("fetch", "done", `${files.length} files downloaded`, `${owner}/${repo}`, fetchDuration);
    trackStep("Fetch Repo", "done", `${files.length} files`, fetchDuration);
  }

  let currentCommitSha = repoUrl.lastCommitSha || null;
  let treeWithSha = repoUrl.fileTree || [];

  if (!isPrefetched) {
    const provider = authContext.provider || detectProvider(repoUrl);
    const ra = createRepoAdapter(provider, repoUrl);
    [currentCommitSha, treeWithSha] = await Promise.all([
      ra.getCommitSha(meta.defaultBranch, authContext.token).catch(() => null),
      ra.getFileTreeWithSha(meta.defaultBranch, authContext.token).catch(() => []),
    ]);
  }

  emit("scan", "running", "Classifying and analysing repository…", "Agent : Repo Scanner");
  const scanStart = Date.now();

  let scanResult;
  const { result: scanRes, error: scanErr } = await withTimeout(
    () =>
      repoScannerAgent({
        files,
        meta,
        fastMode,
        emit: (msg, detail) => emit("scan", "running", msg, detail),
      }),
    TIMEOUTS.scan,
    "Repo Scanner",
  );

  if (scanErr) {
    emit(
      "scan",
      "error",
      "Repo Scanner timed out : running heuristic fallback classification",
      scanErr.message,
    );
    agentErrors.push({ agent: "scan", error: scanErr.message });

    try {
      scanResult = await repoScannerAgent({
        files,
        meta,
        fastMode: true,
        emit: (msg, detail) => emit("scan", "running", msg, detail),
      });
      emit(
        "scan",
        "running",
        `Heuristic fallback complete : ${scanResult.projectMap.length} files classified`,
        "Pipeline will continue with heuristic classifications",
      );
    } catch (fallbackErr) {
      emit("scan", "error", "Heuristic fallback also failed", fallbackErr.message);
      scanResult = FALLBACKS.scan;
    }
  } else {
    scanResult = scanRes;
  }

  const scanDuration = Date.now() - scanStart;
  const {
    projectMap,
    techStack,
    testFrameworks,
    entryPoints,
    keyFiles,
    structure,
    layerMap,
    flagsSummary,
    architectureHint,
    summary: scanSummary,
  } = scanResult;

  emit(
    "scan",
    scanErr ? "error" : "done",
    `${projectMap.length} files classified`,
    [techStack.join(" · ") || "Stack unknown", architectureHint || ""].filter(Boolean).join(" · "),
    scanDuration,
  );
  trackStep("Repo Scanner", scanErr ? "error" : "done", architectureHint, scanDuration);

  const routing = computeRouting(projectMap, structure, files);

  emit(
    "routing",
    "done",
    "Pipeline routing determined",
    [
      routing.runApi ? "✅ API Extractor" : `⏭️  API Extractor (${routing.reasons.api})`,
      routing.runSchema ? "✅ Schema Analyser" : `⏭️  Schema Analyser (${routing.reasons.schema})`,
      routing.runComponents
        ? "✅ Component Mapper"
        : `⏭️  Component Mapper (${routing.reasons.components})`,
      routing.runSecurity
        ? "✅ Security Auditor"
        : `⏭️  Security Auditor (${routing.reasons.security})`,
    ].join(" | "),
  );

  for (const [key, reason] of Object.entries(routing.reasons)) {
    if (reason) {
      emit(key, "skipped", `Skipped : ${reason}`);
      trackStep(
        {
          api: "API Extractor",
          schema: "Schema Analyser",
          components: "Component Mapper",
          security: "Security Auditor",
        }[key],
        "skipped",
        reason,
      );
    }
  }

  emit("parallel", "running", "Running analysis agents in parallel…", "Agents 2, 3, 4, 6");

  const parallelStart = Date.now();

  const [apiResult, schemaResult, componentResult, securityResult] = await Promise.all([
    routing.runApi
      ? runAgent({
          label: "API Extractor",
          step: "api",
          timeout: TIMEOUTS.api,
          fallback: FALLBACKS.api,
          emit,
          fn: () =>
            apiExtractorAgent({
              files,
              projectMap,
              fastMode,
              emit: (msg, detail) => emit("api", "running", msg, detail),
            }),
        })
      : Promise.resolve({ ...FALLBACKS.api, _skipped: true }),

    routing.runSchema
      ? runAgent({
          label: "Schema Analyser",
          step: "schema",
          timeout: TIMEOUTS.schema,
          fallback: FALLBACKS.schema,
          emit,
          fn: () =>
            schemaAnalyserAgent({
              files,
              projectMap,
              fastMode,
              emit: (msg, detail) => emit("schema", "running", msg, detail),
            }),
        })
      : Promise.resolve({ ...FALLBACKS.schema, _skipped: true }),

    routing.runComponents
      ? runAgent({
          label: "Component Mapper",
          step: "components",
          timeout: TIMEOUTS.components,
          fallback: FALLBACKS.components,
          emit,
          fn: () =>
            componentMapperAgent({
              files,
              projectMap,
              structure,
              fastMode,
              emit: (msg, detail) => emit("components", "running", msg, detail),
            }),
        })
      : Promise.resolve({ ...FALLBACKS.components, _skipped: true }),

    routing.runSecurity
      ? runAgent({
          label: "Security Auditor",
          step: "security",
          timeout: TIMEOUTS.security,
          fallback: FALLBACKS.security,
          emit,
          fn: () =>
            securityAuditorAgent({
              files,
              projectMap,
              fastMode,
              emit: (msg, detail) => emit("security", "running", msg, detail),
            }),
        })
      : Promise.resolve({ ...FALLBACKS.security, _skipped: true }),
  ]);

  const parallelDuration = Date.now() - parallelStart;

  const {
    endpoints,
    summary: apiSummary,
    _failed: apiFailed,
    _skipped: apiSkipped,
    _duration: apiDuration,
  } = apiResult;

  const {
    models,
    relationships,
    summary: schemaSummary,
    _failed: schemaFailed,
    _skipped: schemaSkipped,
    _duration: schemaDuration,
  } = schemaResult;

  const {
    components,
    summary: componentSummary,
    _failed: componentFailed,
    _skipped: componentSkipped,
    _duration: componentDuration,
  } = componentResult;

  const {
    findings,
    score: securityScore,
    grade: securityGrade,
    counts: securityCounts,
    categoryCounts,
    affectedFiles,
    summary: securitySummary,
    reportMarkdown: securityReport,
    remediationMarkdown: remediationReport,
    _failed: securityFailed,
    _skipped: securitySkipped,
    _duration: securityDuration,
  } = securityResult;

  if (apiFailed) agentErrors.push({ agent: "api", error: apiResult._error });
  if (schemaFailed) agentErrors.push({ agent: "schema", error: schemaResult._error });
  if (componentFailed) agentErrors.push({ agent: "components", error: componentResult._error });
  if (securityFailed) agentErrors.push({ agent: "security", error: securityResult._error });

  if (!apiSkipped)
    trackStep(
      "API Extractor",
      apiFailed ? "error" : "done",
      `${endpoints?.length ?? 0} endpoints`,
      apiDuration,
    );
  if (!schemaSkipped)
    trackStep(
      "Schema Analyser",
      schemaFailed ? "error" : "done",
      `${models?.length ?? 0} models`,
      schemaDuration,
    );
  if (!componentSkipped)
    trackStep(
      "Component Mapper",
      componentFailed ? "error" : "done",
      `${components?.length ?? 0} components`,
      componentDuration,
    );
  if (!securitySkipped)
    trackStep(
      "Security Auditor",
      securityFailed ? "error" : "done",
      `${securityScore}/100 (${securityGrade})`,
      securityDuration,
    );

  emit(
    "parallel",
    "done",
    "All parallel agents complete",
    [
      `${endpoints?.length ?? 0} endpoints`,
      `${models?.length ?? 0} models`,
      `${relationships?.length ?? 0} relationships`,
      `${components?.length ?? 0} components`,
      `Security: ${securityScore}/100 (${securityGrade})`,
      `${(parallelDuration / 1000).toFixed(1)}s total`,
    ].join(" · "),
  );

  const staticApiReference = buildApiReference(endpoints ?? []);
  const staticSchemaDocs = buildSchemaDocs(models ?? [], relationships ?? []);
  const staticComponentIndex = buildComponentIndex(components ?? []);

  emit("write", "running", "Generating documentation…", "Agent 5 : Doc Writer");
  const writeStart = Date.now();

  const writeResult = await runAgent({
    label: "Doc Writer",
    step: "write",
    timeout: TIMEOUTS.write,
    fallback: FALLBACKS.write,
    emit,
    fn: () =>
      docWriterAgent({
        meta,
        techStack,
        structure,
        endpoints: endpoints ?? [],
        models: models ?? [],
        relationships: relationships ?? [],
        components: components ?? [],
        entryPoints: entryPoints ?? [],
        owner,
        repo,
        layerMap,
        flagsSummary,
        architectureHint,
        keyFiles,
        testFrameworks,
        securitySummary: {
          score: securityScore,
          grade: securityGrade,
          counts: securityCounts,
          topFindings: (findings ?? [])
            .filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
            .slice(0, 10),
        },
        fastMode,
        emit: (msg, detail) => emit("write", "running", msg, detail),
      }),
  });

  const writeDuration = Date.now() - writeStart;

  const {
    readme,
    internalDocs,
    apiReference,
    schemaDocs,
    componentRef,
    componentIndex,
    summary: writeSummary,
    _failed: writeFailed,
  } = writeResult;

  if (writeFailed) agentErrors.push({ agent: "write", error: writeResult._error });
  trackStep(
    "Doc Writer",
    writeFailed ? "error" : "done",
    `${writeSummary?.totalLines ?? 0} lines generated`,
    writeDuration,
  );

  emit("chat", "running", "Setting up chat session…");
  const chatStart = Date.now();

  const docOutput = {
    readme,
    internalDocs,
    componentRef,

    apiReference: apiReference || staticApiReference,
    schemaDocs: schemaDocs || staticSchemaDocs,
    componentIndex: componentIndex || staticComponentIndex,

    securityReport,
    remediationReport,
  };

  let sessionId, suggestedQuestions;
  try {
    const chatResult = await Promise.race([
      (async () => {
        const sid = `${owner}-${repo}-${Date.now()}`;
        createChatSession({ jobId: sid, output: docOutput, meta });
        return {
          sessionId: sid,
          suggestedQuestions: getSuggestedQuestions(docOutput),
        };
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Chat setup timed out")), TIMEOUTS.chat),
      ),
    ]);
    sessionId = chatResult.sessionId;
    suggestedQuestions = chatResult.suggestedQuestions;
  } catch (err) {
    emit("chat", "error", "Chat setup failed : docs still available", err.message);
    agentErrors.push({ agent: "chat", error: err.message });
    sessionId = `${owner}-${repo}-${Date.now()}`;
    suggestedQuestions = [];
  }

  const chatDuration = Date.now() - chatStart;
  emit("chat", "done", "Chat ready : ask anything about this codebase", null, chatDuration);
  trackStep(
    "Chat Session",
    "done",
    `${suggestedQuestions?.length ?? 0} suggested questions`,
    chatDuration,
  );

  let fileManifest = [];
  try {
    fileManifest = updateFileManifest([], treeWithSha, projectMap);
  } catch (err) {
    agentErrors.push({ agent: "manifest", error: err.message });
  }

  const totalDuration = Date.now() - pipelineStart;

  const stats = {
    filesAnalysed: files.length,
    filesClassified: projectMap.length,
    endpoints: endpoints?.length ?? 0,
    models: models?.length ?? 0,
    relationships: relationships?.length ?? 0,
    components: components?.length ?? 0,
    securityFindings: findings?.length ?? 0,
    docsGenerated: Object.keys(docOutput).length,
    agentErrors: agentErrors.length,
    totalDuration,
  };

  const { md: pipelineReportMd, ...pipelineReportStats } = buildPipelineReport(pipelineSteps);

  emit(
    "done",
    "done",
    "Documentation pipeline complete 🎉",
    [
      `${files.length} files`,
      `${endpoints?.length ?? 0} endpoints`,
      `${models?.length ?? 0} models`,
      `${components?.length ?? 0} components`,
      `Security: ${securityScore}/100`,
      `${(totalDuration / 1000).toFixed(1)}s`,
      agentErrors.length ? `⚠ ${agentErrors.length} agent error(s)` : "✅ no errors",
    ].join(" · "),
    null,
    totalDuration,
  );

  return {
    success: true,
    repoUrl,
    owner,
    repo,
    meta,

    techStack,
    testFrameworks,
    architectureHint,
    entryPoints,
    keyFiles,
    layerMap,
    flagsSummary,

    output: docOutput,

    security: {
      score: securityScore,
      grade: securityGrade,
      counts: securityCounts,
      categoryCounts,
      affectedFiles,
      findings: (findings ?? []).slice(0, 50),
    },

    chat: { sessionId, suggestedQuestions },

    stats,

    pipelineReport: {
      markdown: pipelineReportMd,
      steps: pipelineSteps,
      ...pipelineReportStats,
    },

    agentErrors: agentErrors.length > 0 ? agentErrors : undefined,

    routing,

    lastDocumentedCommit: currentCommitSha,
    fileManifest,
    agentOutputs: {
      projectMap,
      endpoints: endpoints ?? [],
      models: models ?? [],
      relationships: relationships ?? [],
      components: components ?? [],
      findings: (findings ?? []).slice(0, 200),

      summaries: {
        scan: scanSummary,
        api: apiSummary,
        schema: schemaSummary,
        components: componentSummary,
        security: securitySummary,
        write: writeSummary,
      },
    },
  };
}
