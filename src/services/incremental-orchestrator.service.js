// ===================================================================
// Incremental Sync Pipeline — Enhanced
// ===================================================================

import { getAdapter } from "./provider.adapter.js";
import { decrypt } from "../utils/crypto.util.js";

import { repoScannerAgent } from "../agents/repo-scanner.agent.js";
import { apiExtractorAgent } from "../agents/api-extractor.agent.js";
import { schemaAnalyserAgent } from "../agents/schema-analyser.agent.js";
import { componentMapperAgent } from "../agents/component-mapper.agent.js";
import { securityAuditorAgent } from "../agents/security-auditor.agent.js";

import {
  analyseChanges,
  mergeAgentOutputs,
  updateFileManifest,
} from "./diff.service.js";

import { DocumentVersion } from "../models/DocumentVersion.js";

// ─── Configuration ────────────────────────────────────────────────

const TIMEOUTS = {
  fetch: 45_000,
  scan: 90_000,
  api: 60_000,
  schema: 60_000,
  components: 60_000,
  security: 90_000,
  docs: 120_000,
};

// If more than this many files changed → full run
// Large diffs make incremental merging unreliable
const FULL_RUN_THRESHOLD = 80;

// Sections that can be rebuilt statically (no LLM call)
const STATIC_SECTIONS = new Set([
  "apiReference",
  "schemaDocs",
  "securityReport",
  "remediationReport",
  "componentIndex",
]);

// Sections that require an LLM call
const LLM_SECTIONS = new Set(["readme", "internalDocs", "componentRef"]);

const SEVERITY_WEIGHT = { CRITICAL: 25, HIGH: 15, MEDIUM: 7, LOW: 2 };
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const SEVERITY_EMOJI = { CRITICAL: "🔴", HIGH: "🟠", MEDIUM: "🟡", LOW: "🔵" };

// ─── Lazy doc writer ──────────────────────────────────────────────

let _docWriterAgent = null;
async function getDocWriter() {
  if (_docWriterAgent) return _docWriterAgent;
  const m = await import("../agents/doc-writer.agent.js");
  _docWriterAgent = m.docWriterAgent;
  return _docWriterAgent;
}

/**
 * Resolve the correct git service and decrypted access token for a project.
 * GitHub uses the server-level GITHUB_TOKEN env var (accessToken = null).
 * GitLab uses the per-user token stored encrypted on the project document.
 */
function resolveGit(project) {
  const provider = project.provider || "github";
  const git = getAdapter(provider);
  const accessToken = project.providerToken
    ? decrypt(project.providerToken)
    : null; // GitHub: null — github.service.js reads GITHUB_TOKEN internally
  return { git, accessToken };
}

// ─── Timeout + cancellation ───────────────────────────────────────

/**
 * Wrap any async fn with a hard timeout.
 * Returns { result } on success, { error, timedOut } on failure.
 * Never throws.
 */
async function withTimeout(fn, ms, label) {
  let handle;
  const timeoutPromise = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(handle);
    return { result };
  } catch (err) {
    clearTimeout(handle);
    return { error: err, timedOut: err.message.includes("timed out") };
  }
}

// ─── Agent runner ─────────────────────────────────────────────────

/**
 * Run a single agent with timeout, error isolation, and timing.
 * Always returns a valid object — never throws.
 */
async function runAgent({ label, step, fn, timeout, fallback, emit }) {
  const start = Date.now();
  emit(step, "running", `Running ${label}…`);

  const { result, error, timedOut } = await withTimeout(fn, timeout, label);
  const duration = Date.now() - start;

  if (error) {
    const reason = timedOut
      ? `${label} timed out after ${timeout / 1000}s`
      : error.message;
    emit(step, "error", `${label} failed — using fallback`, reason);
    console.error(
      `[sync:${step}:error] ${label}:`,
      error.stack ?? error.message,
    );
    return { ...fallback, _failed: true, _error: reason, _duration: duration };
  }

  emit(step, "done", `${label} complete`, `${(duration / 1000).toFixed(1)}s`);
  return { ...result, _duration: duration };
}

// ─── Pure helpers ─────────────────────────────────────────────────

function parseOwnerRepo(project) {
  const provider = project.provider || "github";
  const git = getAdapter(provider);
  const { owner, repo } = git.parseRepoUrl(project.repoUrl);
  return { owner, repoName: repo };
}

function categoriseWebhookFiles(webhookFiles) {
  const added = [],
    modified = [],
    removed = [];
  for (const f of webhookFiles) {
    const entry = { path: f.path || f, status: f.status || "modified" };
    if (entry.status === "added") added.push(entry);
    else if (entry.status === "removed") removed.push(entry);
    else modified.push(entry);
  }
  return { added, modified, removed };
}

/**
 * Filter changedFiles to only those listed in agentFileList.
 * Uses a pre-built Set for O(1) lookups.
 */
function filterFilesForAgent(changedFiles, agentFileList, removedPathSet) {
  const pathSet = new Set(agentFileList.map((f) => f.path));
  return changedFiles.filter(
    (f) => pathSet.has(f.path) && !removedPathSet.has(f.path),
  );
}

/**
 * Merge changed-file projectMap with stored projectMap.
 * Changed + removed paths are replaced; everything else is kept.
 */
function mergeProjectMap(existingProjectMap, freshProjectMap, changedPathSet) {
  return [
    ...(existingProjectMap ?? []).filter((p) => !changedPathSet.has(p.path)),
    ...(freshProjectMap ?? []),
  ];
}

function buildStructure(projectMap) {
  return (projectMap ?? []).reduce((acc, f) => {
    const role = f.role || "other";
    (acc[role] ??= []).push(f.path);
    return acc;
  }, {});
}

function buildLayerMap(projectMap) {
  return (projectMap ?? []).reduce((acc, f) => {
    const layer = f.layer || "other";
    (acc[layer] ??= []).push(f.path);
    return acc;
  }, {});
}

function hasValidStoredState(project) {
  return (
    (project.agentOutputs?.projectMap?.length ?? 0) > 0 &&
    (project.fileManifest?.length ?? 0) > 0
  );
}

/**
 * Check if a full run is required and return the reason if so.
 * Returns null if incremental sync can proceed.
 */
function requiresFullRun(project, changedFileEntries, analysis, options) {
  if (options.forceFullRun) return "forceFullRun requested";
  if (!hasValidStoredState(project)) return "no stored baseline";
  if (analysis.needsFullRun)
    return analysis.fullRunReason ?? "manifest changed";
  if (changedFileEntries.length > FULL_RUN_THRESHOLD)
    return `${changedFileEntries.length} files exceed threshold (${FULL_RUN_THRESHOLD})`;
  return null;
}

async function updateCommitSha(project, sha) {
  const { Project } = await import("../models/Project.js");
  await Project.findByIdAndUpdate(project._id, {
    lastDocumentedCommit: sha,
    "stats.lastChecked": new Date(),
  });
}

// ─── Security helpers ─────────────────────────────────────────────

function recomputeSecurityScore(findings) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings ?? []) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const criticalDeduct =
    Math.min(counts.CRITICAL, 3) * 25 + Math.max(0, counts.CRITICAL - 3) * 10;
  const highDeduct =
    Math.min(counts.HIGH, 5) * 15 + Math.max(0, counts.HIGH - 5) * 5;
  const mediumDeduct =
    Math.min(counts.MEDIUM, 8) * 7 + Math.max(0, counts.MEDIUM - 8) * 2;
  const lowDeduct = counts.LOW * 2;

  const score = Math.max(
    0,
    Math.min(
      100,
      100 - (criticalDeduct + highDeduct + mediumDeduct + lowDeduct),
    ),
  );
  const grade =
    score >= 90
      ? "A"
      : score >= 80
        ? "B"
        : score >= 65
          ? "C"
          : score >= 45
            ? "D"
            : "F";

  return { score, grade, counts };
}

function buildSecurityReport(
  findings,
  score,
  grade,
  counts,
  categoryCounts = {},
) {
  let md = `# 🔒 Security Audit Report\n\n`;
  md += `## Summary\n\n| Metric | Value |\n|--------|-------|\n`;
  md += `| **Score** | ${score}/100 |\n| **Grade** | **${grade}** |\n`;
  md += `| **Total Findings** | ${findings?.length ?? 0} |\n\n`;

  md += `## Severity Breakdown\n\n| Severity | Count |\n|----------|-------|\n`;
  for (const sev of SEVERITY_ORDER)
    md += `| ${SEVERITY_EMOJI[sev]} **${sev}** | ${counts[sev] ?? 0} |\n`;
  md += "\n";

  if (Object.keys(categoryCounts).length) {
    md += `## OWASP Category Breakdown\n\n| Category | Findings |\n|----------|----------|\n`;
    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, n]) => (md += `| ${cat} | ${n} |\n`));
    md += "\n";
  }

  if (!findings?.length) {
    md += "✅ No issues detected.\n";
    return md;
  }

  md += `## Findings\n\n`;
  for (const sev of SEVERITY_ORDER) {
    const group = (findings ?? []).filter((f) => f.severity === sev);
    if (!group.length) continue;
    md += `### ${SEVERITY_EMOJI[sev]} ${sev} (${group.length})\n\n`;
    group.forEach((f) => {
      md += `#### [${f.id}] ${f.title}\n\n`;
      md += `**File:** \`${f.file}\``;
      if (f.cwe) md += ` · **${f.cwe}**`;
      if (f.category) md += ` · ${f.category}`;
      md += "\n\n";
      if (f.line)
        md += `**Detected:**\n\`\`\`\n${f.line.replace(/`/g, "'")}\n\`\`\`\n\n`;
      if (f.description) md += `**Description:** ${f.description}\n\n`;
      if (f.impact) md += `**Impact:** ${f.impact}\n\n`;
      md += `**Fix:** ${f.advice}\n\n---\n\n`;
    });
  }
  return md;
}

function buildRemediationPlan(findings) {
  const effort = {
    CRITICAL: "Immediate",
    HIGH: "This sprint",
    MEDIUM: "Next sprint",
    LOW: "Backlog",
  };
  let md = `# 🔧 Remediation Plan\n\n> Address in order: Critical → High → Medium → Low\n\n`;
  for (const sev of SEVERITY_ORDER) {
    const group = (findings ?? []).filter((f) => f.severity === sev);
    if (!group.length) continue;
    md += `## ${SEVERITY_EMOJI[sev]} ${sev} — ${effort[sev]}\n\n`;
    group.forEach((f, idx) => {
      md += `${idx + 1}. **[${f.id}] ${f.title}**\n`;
      md += `   - File: \`${f.file}\`\n`;
      md += `   - Fix: ${f.advice}\n`;
      if (f.cwe)
        md += `   - Reference: https://cwe.mitre.org/data/definitions/${f.cwe.replace("CWE-", "")}.html\n`;
      md += "\n";
    });
  }
  return md;
}

function buildApiReference(endpoints) {
  if (!endpoints?.length)
    return "# API Reference\n\nNo API endpoints detected.\n";

  const authCount = endpoints.filter((e) => e.auth?.required || e.auth).length;
  const methodCount = endpoints.reduce((acc, e) => {
    acc[e.method] = (acc[e.method] ?? 0) + 1;
    return acc;
  }, {});

  let md = "# API Reference\n\n";
  md += `> **${endpoints.length} endpoints** · **${authCount} require auth** · `;
  md += Object.entries(methodCount)
    .map(([m, n]) => `${n} ${m}`)
    .join(" · ");
  md += "\n\n";

  const grouped = {};
  for (const ep of endpoints) {
    const tag =
      ep.tags?.[0] ||
      ep.path?.split("/")?.[2] ||
      ep.path?.split("/")?.[1] ||
      "root";
    (grouped[tag] ??= []).push(ep);
  }

  for (const [group, eps] of Object.entries(grouped).sort()) {
    md += `## ${group.charAt(0).toUpperCase() + group.slice(1)}\n\n`;
    for (const ep of eps) {
      const deprecated = ep.deprecated ? " ⚠️ *Deprecated*" : "";
      md += `### \`${ep.method} ${ep.path}\`${deprecated}\n\n`;
      if (ep.description) md += `${ep.description}\n\n`;

      const authRequired = ep.auth?.required ?? ep.auth ?? false;
      const authType = ep.auth?.type || (authRequired ? "required" : "none");
      const authRoles = ep.auth?.roles || [];
      md += `**Auth:** ${authRequired ? `✅ \`${authType}\`` : "❌ Public"}`;
      if (authRoles.length)
        md += ` · Roles: ${authRoles.map((r) => `\`${r}\``).join(", ")}`;
      md += "\n\n";

      if (ep.request?.params?.length) {
        md += `**Parameters:**\n\n| Name | In | Type | Required | Description |\n|------|-----|------|----------|-------------|\n`;
        ep.request.params.forEach(
          (p) =>
            (md += `| \`${p.name}\` | ${p.in} | \`${p.type || "string"}\` | ${p.required ? "✅" : "❌"} | ${p.description || "—"} |\n`),
        );
        md += "\n";
      }

      if (ep.request?.body_schema)
        md += `**Body:** \`${ep.request.body_schema}\`\n\n`;

      if (ep.response?.success) {
        md += `**Response \`${ep.response.success.status}\`:** ${ep.response.success.description || "Success"}`;
        if (ep.response.success.schema)
          md += ` · \`${ep.response.success.schema}\``;
        md += "\n\n";
      }

      if (ep.response?.errors?.length) {
        md += `**Errors:**\n\n| Status | Description |\n|--------|-------------|\n`;
        ep.response.errors.forEach(
          (e) => (md += `| \`${e.status}\` | ${e.description} |\n`),
        );
        md += "\n";
      }

      if (ep.notes) md += `> ⚠️ ${ep.notes}\n\n`;
      md += "---\n\n";
    }
  }
  return md;
}

function buildSchemaDocs(models, relationships) {
  if (!models?.length) return "# Data Models\n\nNo data models detected.\n";

  let md = "# Data Models\n\n";
  md += `> **${models.length} models** · **${relationships?.length ?? 0} relationships**\n\n`;
  md +=
    models.map((m) => `- [${m.name}](#${m.name.toLowerCase()})`).join("\n") +
    "\n\n";

  for (const m of models) {
    md += `## ${m.name}\n\n`;
    if (m.description) md += `${m.description}\n\n`;
    if (m.file) md += `**File:** \`${m.file}\`\n\n`;
    if (m.orm) md += `**ORM:** \`${m.orm}\``;
    if (m.table) md += ` · **Table:** \`${m.table}\``;
    if (m.orm || m.table) md += "\n\n";

    if (m.fields?.length) {
      md += `### Fields\n\n| Field | Type | Required | Unique | Default |\n|-------|------|----------|--------|----------|\n`;
      m.fields.forEach(
        (f) =>
          (md += `| \`${f.name}\` | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${f.unique ? "✅" : "❌"} | ${f.default || "—"} |\n`),
      );
      md += "\n";
    }

    if (m.indexes?.length) {
      md += `### Indexes\n\n| Name | Fields | Unique |\n|------|--------|--------|\n`;
      m.indexes.forEach(
        (idx) =>
          (md += `| \`${idx.name || "—"}\` | \`${(idx.fields ?? []).join(", ")}\` | ${idx.unique ? "✅" : "❌"} |\n`),
      );
      md += "\n";
    }

    const modelRels = (relationships ?? []).filter(
      (r) => r.from === m.name || r.to === m.name,
    );
    if (modelRels.length) {
      md += `### Relationships\n\n| Direction | Model | Type | Via |\n|-----------|-------|------|-----|\n`;
      modelRels.forEach((r) => {
        const dir = r.from === m.name ? "→ out" : "← in";
        const other = r.from === m.name ? r.to : r.from;
        md += `| ${dir} | ${other} | \`${r.type}\` | ${r.through || "—"} |\n`;
      });
      md += "\n";
    }

    md += "---\n\n";
  }

  if (relationships?.length) {
    md += `## Relationship Overview\n\n| From | Type | To | Via |\n|------|------|----|-----|\n`;
    relationships.forEach(
      (r) =>
        (md += `| ${r.from} | \`${r.type}\` | ${r.to} | ${r.through || "—"} |\n`),
    );
  }

  return md;
}

function buildComponentIndex(components) {
  if (!components?.length)
    return "# Component Index\n\nNo components documented.\n";

  const TYPE_ORDER = [
    "service",
    "middleware",
    "guard",
    "hook",
    "store",
    "context",
    "provider",
    "component",
    "utility",
    "config",
    "helper",
    "decorator",
    "interceptor",
    "constant",
    "type",
    "other",
  ];

  let md = `# Component Index\n\n> **${components.length} components**\n\n`;

  const grouped = components.reduce((acc, c) => {
    (acc[c.type || "other"] ??= []).push(c);
    return acc;
  }, {});

  for (const type of TYPE_ORDER) {
    const group = grouped[type];
    if (!group?.length) continue;
    md += `## ${type.charAt(0).toUpperCase() + type.slice(1)}s\n\n`;
    md += `| Name | File | Async | Complexity | Description |\n|------|------|-------|------------|-------------|\n`;
    group
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const dep = c.deprecated ? " ⚠️" : "";
        const cplx =
          { low: "🟢", medium: "🟡", high: "🔴" }[c.complexity] || "—";
        const desc = c.description
          ? c.description.slice(0, 70) + (c.description.length > 70 ? "…" : "")
          : "—";
        md += `| \`${c.name}\`${dep} | \`${c.file}\` | ${c.async ? "✅" : "❌"} | ${cplx} | ${desc} |\n`;
      });
    md += "\n";
  }
  return md;
}

/**
 * Determine which doc sections need regenerating based on which agents ran.
 * Returns { all, static, llm }.
 */
function determineSectionsToRegenerate(agentsRun, analysis) {
  const sections = new Set(analysis.sectionsAffected ?? []);

  if (agentsRun.has("apiExtractor")) sections.add("apiReference");
  if (agentsRun.has("schemaAnalyser")) {
    sections.add("schemaDocs");
    sections.add("internalDocs");
  }
  if (agentsRun.has("componentMapper")) {
    sections.add("componentRef");
    sections.add("componentIndex");
  }
  if (agentsRun.has("securityAuditor")) {
    sections.add("securityReport");
    sections.add("remediationReport");
  }
  if (agentsRun.has("repoScanner")) sections.add("internalDocs");
  if (agentsRun.size > 0) sections.add("readme");

  return {
    all: [...sections],
    static: [...sections].filter((s) => STATIC_SECTIONS.has(s)),
    llm: [...sections].filter((s) => LLM_SECTIONS.has(s)),
  };
}

/**
 * Build the complete MongoDB $set payload from sync results.
 * Single source of truth — no fields can be silently dropped.
 */
function buildMongoUpdate({
  newOutput,
  currentSha,
  newManifest,
  mergedOutputs,
  securitySummary,
  updatedEditedSections,
  totalDuration,
}) {
  return {
    // Documentation output
    "output.readme": newOutput.readme,
    "output.internalDocs": newOutput.internalDocs,
    "output.apiReference": newOutput.apiReference,
    "output.schemaDocs": newOutput.schemaDocs,
    "output.securityReport": newOutput.securityReport,
    "output.remediationReport": newOutput.remediationReport,
    "output.componentRef": newOutput.componentRef,
    "output.componentIndex": newOutput.componentIndex,
    // Sync state
    lastDocumentedCommit: currentSha,
    fileManifest: newManifest,
    agentOutputs: mergedOutputs,
    // Security aggregate
    security: securitySummary,
    // Edited sections with stale flags
    editedSections: updatedEditedSections,
    // Stats
    stats: {
      filesAnalysed: newManifest.length,
      endpoints: mergedOutputs.endpoints.length,
      models: mergedOutputs.models.length,
      relationships: (mergedOutputs.relationships ?? []).length,
      components: mergedOutputs.components.length,
      securityScore: securitySummary.score,
      lastSyncedAt: new Date(),
      lastSyncDuration: totalDuration,
    },
  };
}

// ─── Main Entry Point ─────────────────────────────────────────────

/**
 * Run the incremental sync pipeline for a project.
 *
 * @param {Object}   project
 * @param {Function} onProgress            — SSE progress emitter
 * @param {Object}   options
 * @param {Array}    [options.webhookChangedFiles]
 * @param {boolean}  [options.forceFullRun]
 * @returns {Object} syncResult
 */
export async function incrementalSync(project, onProgress, options = {}) {
  const syncStart = Date.now();
  const syncErrors = [];

  // Structured emitter — always logs + fires SSE
  const emit = (step, status, msg, detail = null, duration = null) => {
    const event = { step, status, msg, detail, ts: Date.now(), duration };
    console.log(
      `[sync:${step}:${status}] ${msg}` +
        (detail ? ` — ${detail}` : "") +
        (duration ? ` (${(duration / 1000).toFixed(1)}s)` : ""),
    );
    onProgress?.(event);
  };

  const { owner, repoName: repo } = parseOwnerRepo(project);
  const { git, accessToken } = resolveGit(project);

  try {
    emit("sync", "running", "Starting incremental sync…", `${owner}/${repo}`);

    // ── PHASE 1 + 2 concurrent: resolve state & compute diff ──────
    // Kick off meta + SHA fetch immediately; start diff computation
    // as soon as we have the SHA. Both can overlap where possible.

    emit("sync:fetch", "running", "Resolving repo state and computing diff…");
    const fetchStart = Date.now();

    let meta, currentSha;
    try {
      [meta, currentSha] = await Promise.all([
        git.getRepoMeta(owner, repo, accessToken),
        git.getCommitSha(
          owner,
          repo,
          project.meta?.defaultBranch || "main",
          accessToken,
        ),
      ]);
    } catch (err) {
      emit("sync:fetch", "error", "Failed to fetch repo metadata", err.message);
      return { success: false, error: err.message, phase: "fetch" };
    }

    // Nothing has changed since last sync
    if (
      currentSha &&
      currentSha === project.lastDocumentedCommit &&
      !options.forceFullRun
    ) {
      emit(
        "sync",
        "done",
        "Repository unchanged — no sync needed",
        `SHA: ${currentSha.slice(0, 8)}`,
      );
      return {
        success: true,
        skipped: true,
        reason: "no_changes",
        currentCommit: currentSha,
      };
    }

    // ── PHASE 2: Compute what changed ─────────────────────────────

    let added = [],
      modified = [],
      removed = [],
      currentTree = [];
    let changedFileEntries = [];

    if (options.webhookChangedFiles?.length) {
      emit(
        "sync:diff",
        "running",
        `Using ${options.webhookChangedFiles.length} files from webhook`,
      );
      ({ added, modified, removed } = categoriseWebhookFiles(
        options.webhookChangedFiles,
      ));
      changedFileEntries = [...added, ...modified, ...removed];
      // Fetch tree in background — needed for manifest update in Phase 8
      // We don't await here; it runs concurrently with the agent phase
      currentTree = await git
        .getFileTreeWithSha(owner, repo, meta.defaultBranch, accessToken)
        .catch(() => []);
    } else {
      try {
        const diffResult = await git.computeFileDiff(
          owner,
          repo,
          meta.defaultBranch,
          project.fileManifest,
          accessToken,
        );
        added = diffResult.added ?? [];
        modified = diffResult.modified ?? [];
        removed = diffResult.removed ?? [];
        currentTree = diffResult.currentTree ?? [];
        changedFileEntries = [...added, ...modified, ...removed];
      } catch (err) {
        syncErrors.push({ phase: "diff", error: err.message });
        emit(
          "sync:diff",
          "error",
          "Diff computation failed — falling back to full run",
          err.message,
        );
        return fullSyncFallback(
          project,
          owner,
          repo,
          meta,
          currentSha,
          onProgress,
        );
      }
    }

    emit(
      "sync:diff",
      "done",
      `${added.length} added · ${modified.length} modified · ${removed.length} removed`,
      `${changedFileEntries.length} total · ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`,
    );

    // No eligible files changed (SHA moved but only ignored files)
    if (changedFileEntries.length === 0) {
      await updateCommitSha(project, currentSha);
      emit(
        "sync",
        "done",
        "No eligible files changed — commit SHA updated",
        `→ ${currentSha.slice(0, 8)}`,
      );
      return {
        success: true,
        skipped: true,
        reason: "no_eligible_changes",
        currentCommit: currentSha,
      };
    }

    // ── Routing analysis (memoised — computed once, used everywhere) ──
    const analysis = analyseChanges(changedFileEntries, project.fileManifest);
    const agentsNeeded = analysis.agentsNeeded; // Set<string>

    // Check if a full run is required
    const fullRunReason = requiresFullRun(
      project,
      changedFileEntries,
      analysis,
      options,
    );
    if (fullRunReason) {
      emit("sync:diff", "running", `Full re-run: ${fullRunReason}`);
      return fullSyncFallback(
        project,
        owner,
        repo,
        meta,
        currentSha,
        onProgress,
      );
    }

    emit(
      "sync:routing",
      "done",
      `Agents needed: ${[...agentsNeeded].join(", ") || "none"}`,
      `${changedFileEntries.filter((f) => f.status !== "removed").length} files to re-analyse`,
    );

    // ── PHASE 3: Determine files to fetch then fetch them ─────────
    // Compute required paths from routing analysis BEFORE fetching
    // so we only download exactly what each agent needs.

    const removedPathSet = new Set(removed.map((r) => r.path));

    const changedPathsToFetch = [
      ...new Set([
        ...analysis.changedByAgent.repoScanner.map((f) => f.path),
        ...analysis.changedByAgent.apiExtractor.map((f) => f.path),
        ...analysis.changedByAgent.schemaAnalyser.map((f) => f.path),
        ...analysis.changedByAgent.componentMapper.map((f) => f.path),
        ...analysis.changedByAgent.securityAuditor.map((f) => f.path),
      ]),
    ].filter((p) => !removedPathSet.has(p));

    emit(
      "sync:fetch",
      "running",
      `Fetching ${changedPathsToFetch.length} changed files…`,
    );

    const { result: fetchResult, error: fetchErr } = await withTimeout(
      () =>
        git.fetchFileContents(
          owner,
          repo,
          changedPathsToFetch,
          (msg) => emit("sync:fetch", "running", msg), // onProgress (4th param)
          accessToken, // token (5th param)
        ),
      TIMEOUTS.fetch,
      "File fetch",
    );

    if (fetchErr) {
      syncErrors.push({ phase: "fetch_files", error: fetchErr.message });
      emit(
        "sync:fetch",
        "error",
        "File fetch failed — falling back to full run",
        fetchErr.message,
      );
      return fullSyncFallback(
        project,
        owner,
        repo,
        meta,
        currentSha,
        onProgress,
      );
    }

    const changedFiles = fetchResult ?? [];
    emit("sync:fetch", "done", `${changedFiles.length} files downloaded`);

    // ── PHASE 4: Parallel Agent Execution ─────────────────────────
    // Pre-compute shared values once — used by all agents
    const existingProjectMap = project.agentOutputs?.projectMap ?? [];
    const changedPathSet = new Set(changedPathsToFetch);

    // Merge project map once — shared as read-only reference by all agent closures
    // (agents that re-scan will override their portion via mergeProjectMap in Phase 5)
    const baselineProjectMap = mergeProjectMap(
      existingProjectMap,
      [],
      changedPathSet,
    );

    emit(
      "sync:agents",
      "running",
      `Running ${agentsNeeded.size} agent(s) in parallel…`,
    );
    const agentsStart = Date.now();

    // Kick off tree fetch concurrently with agent execution (webhook path only)
    // so its latency is hidden behind the agent run time
    const treePromise =
      currentTree.length === 0
        ? git
            .getFileTreeWithSha(owner, repo, meta.defaultBranch, accessToken)
            .catch(() => [])
        : Promise.resolve(currentTree);

    const [
      scanResult,
      apiResult,
      schemaResult,
      componentResult,
      securityResult,
    ] = await Promise.all([
      // ── Agent 1: Repo Scanner ──────────────────────────────────
      agentsNeeded.has("repoScanner") && changedFiles.length > 0
        ? runAgent({
            label: "Repo Scanner",
            step: "sync:scan",
            timeout: TIMEOUTS.scan,
            fallback: { projectMap: [] },
            emit,
            fn: () =>
              repoScannerAgent({
                files: changedFiles,
                meta,
                emit: (msg, d) => emit("sync:scan", "running", msg, d),
              }),
          })
        : Promise.resolve({ projectMap: [], _skipped: true }),

      // ── Agent 2: API Extractor ─────────────────────────────────
      agentsNeeded.has("apiExtractor")
        ? runAgent({
            label: "API Extractor",
            step: "sync:api",
            timeout: TIMEOUTS.api,
            fallback: { endpoints: [], summary: {} },
            emit,
            fn: () => {
              const routeFiles = filterFilesForAgent(
                changedFiles,
                analysis.changedByAgent.apiExtractor,
                removedPathSet,
              );
              if (!routeFiles.length)
                return Promise.resolve({ endpoints: [], _skipped: true });
              return apiExtractorAgent({
                files: routeFiles,
                projectMap: baselineProjectMap,
                emit: (msg, d) => emit("sync:api", "running", msg, d),
              });
            },
          })
        : Promise.resolve({ endpoints: [], _skipped: true }),

      // ── Agent 3: Schema Analyser ───────────────────────────────
      agentsNeeded.has("schemaAnalyser")
        ? runAgent({
            label: "Schema Analyser",
            step: "sync:schema",
            timeout: TIMEOUTS.schema,
            fallback: { models: [], relationships: undefined },
            emit,
            fn: () => {
              const schemaFiles = filterFilesForAgent(
                changedFiles,
                analysis.changedByAgent.schemaAnalyser,
                removedPathSet,
              );
              if (!schemaFiles.length)
                return Promise.resolve({
                  models: [],
                  relationships: undefined,
                });
              return schemaAnalyserAgent({
                files: schemaFiles,
                projectMap: baselineProjectMap,
                emit: (msg, d) => emit("sync:schema", "running", msg, d),
              });
            },
          })
        : Promise.resolve({
            models: [],
            relationships: undefined,
            _skipped: true,
          }),

      // ── Agent 4: Component Mapper ──────────────────────────────
      agentsNeeded.has("componentMapper")
        ? runAgent({
            label: "Component Mapper",
            step: "sync:components",
            timeout: TIMEOUTS.components,
            fallback: { components: [], summary: {} },
            emit,
            fn: () => {
              const serviceFiles = filterFilesForAgent(
                changedFiles,
                analysis.changedByAgent.componentMapper,
                removedPathSet,
              );
              if (!serviceFiles.length)
                return Promise.resolve({ components: [] });
              return componentMapperAgent({
                files: serviceFiles,
                projectMap: baselineProjectMap,
                structure: buildStructure(baselineProjectMap),
                emit: (msg, d) => emit("sync:components", "running", msg, d),
              });
            },
          })
        : Promise.resolve({ components: [], _skipped: true }),

      // ── Agent 6: Security Auditor ──────────────────────────────
      // Receives full baselineProjectMap so it can use has_auth flags
      // for LLM file prioritisation
      agentsNeeded.has("securityAuditor") && changedFiles.length > 0
        ? runAgent({
            label: "Security Auditor",
            step: "sync:security",
            timeout: TIMEOUTS.security,
            fallback: {
              findings: [],
              score: null,
              grade: null,
              counts: null,
              categoryCounts: {},
              remediationMarkdown: "",
            },
            emit,
            fn: () =>
              securityAuditorAgent({
                files: changedFiles,
                projectMap: baselineProjectMap,
                emit: (msg, d) => emit("sync:security", "running", msg, d),
              }),
          })
        : Promise.resolve({ findings: [], _skipped: true }),
    ]);

    const agentsDuration = Date.now() - agentsStart;

    // Collect agent errors
    for (const [agent, r] of [
      ["scan", scanResult],
      ["api", apiResult],
      ["schema", schemaResult],
      ["components", componentResult],
      ["security", securityResult],
    ]) {
      if (r._failed) syncErrors.push({ agent, error: r._error });
    }

    emit(
      "sync:agents",
      "done",
      `${agentsNeeded.size} agent(s) complete`,
      `${(agentsDuration / 1000).toFixed(1)}s · ${syncErrors.length ? `⚠ ${syncErrors.length} error(s)` : "✅ clean"}`,
    );

    // ── PHASE 5: Merge outputs ─────────────────────────────────────
    // Build final merged projectMap (fresh scan results replace changed paths)
    const mergedProjectMap = mergeProjectMap(
      existingProjectMap,
      scanResult.projectMap ?? [],
      changedPathSet,
    );

    const mergedOutputs = mergeAgentOutputs(
      project.agentOutputs,
      {
        endpoints: apiResult.endpoints ?? [],
        models: schemaResult.models ?? [],
        relationships: schemaResult.relationships, // undefined = not re-run → keep stored
        components: componentResult.components ?? [],
        findings: securityResult.findings ?? [],
        projectMap: scanResult.projectMap ?? [],
      },
      changedPathsToFetch,
      [...removedPathSet],
    );

    // ── PHASE 6: Recompute security from full merged findings ──────
    let securitySummary;
    if (agentsNeeded.has("securityAuditor")) {
      const { score, grade, counts } = recomputeSecurityScore(
        mergedOutputs.findings,
      );
      const categoryCounts = securityResult.categoryCounts ?? {};
      securitySummary = {
        score,
        grade,
        counts,
        categoryCounts,
        affectedFiles: securityResult.affectedFiles ?? [],
        findings: mergedOutputs.findings.slice(0, 50),
        reportMarkdown: buildSecurityReport(
          mergedOutputs.findings,
          score,
          grade,
          counts,
          categoryCounts,
        ),
        remediationMarkdown: buildRemediationPlan(mergedOutputs.findings),
      };
    } else {
      // Security didn't run — carry forward stored values
      securitySummary = project.security ?? {
        score: 100,
        grade: "A",
        counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        findings: [],
      };
    }

    // ── PHASE 7: Regenerate doc sections ──────────────────────────
    emit(
      "sync:docs",
      "running",
      "Regenerating affected documentation sections…",
    );
    const docsStart = Date.now();
    const sectionsInfo = determineSectionsToRegenerate(agentsNeeded, analysis);

    const regenerated = [];
    const skipped = [];
    const docErrors = [];

    const newOutput = {
      ...(project.output?.toObject?.() ?? { ...project.output }),
    };

    // Build shared context for doc writer — computed once
    const docContext = {
      meta,
      techStack: project.techStack ?? [],
      structure: buildStructure(mergedProjectMap),
      endpoints: mergedOutputs.endpoints,
      models: mergedOutputs.models,
      relationships:
        mergedOutputs.relationships ??
        project.agentOutputs?.relationships ??
        [],
      components: mergedOutputs.components,
      entryPoints: mergedProjectMap
        .filter((f) => f.role === "entry")
        .map((f) => f.path),
      owner,
      repo,
      layerMap: buildLayerMap(mergedProjectMap),
      architectureHint: project.architectureHint ?? "",
      securitySummary: {
        score: securitySummary.score,
        grade: securitySummary.grade,
        counts: securitySummary.counts,
        topFindings: mergedOutputs.findings
          .filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
          .slice(0, 10),
      },
    };

    // Build a Set of user-edited section names for O(1) lookup
    const editedSectionNames = new Set(
      (project.editedSections ?? []).map((s) => s.section),
    );

    // ── Static sections — parallel rebuild (no LLM cost) ──────────
    const staticResults = await Promise.allSettled(
      sectionsInfo.static.map(async (section) => {
        switch (section) {
          case "apiReference":
            return [section, buildApiReference(mergedOutputs.endpoints)];
          case "schemaDocs":
            return [
              section,
              buildSchemaDocs(
                mergedOutputs.models,
                mergedOutputs.relationships ??
                  project.agentOutputs?.relationships ??
                  [],
              ),
            ];
          case "securityReport":
            return [section, securitySummary.reportMarkdown];
          case "remediationReport":
            return [section, securitySummary.remediationMarkdown];
          case "componentIndex":
            return [section, buildComponentIndex(mergedOutputs.components)];
          default:
            throw new Error(`Unknown static section: ${section}`);
        }
      }),
    );

    for (const settled of staticResults) {
      if (settled.status === "rejected") {
        const err = settled.reason;
        docErrors.push({ section: "static", error: err.message });
        syncErrors.push({ agent: "docs_static", error: err.message });
        continue;
      }
      const [section, content] = settled.value;
      newOutput[section] = content;
      regenerated.push(section);
      if (editedSectionNames.has(section)) {
        skipped.push({ section, reason: "user_edit_preserved_as_stale" });
      }
    }

    // ── LLM sections — single batched doc writer call ──────────────
    const llmSectionsNeeded = sectionsInfo.llm;
    if (llmSectionsNeeded.length > 0) {
      emit(
        "sync:docs",
        "running",
        `Regenerating ${llmSectionsNeeded.length} LLM section(s)…`,
        llmSectionsNeeded.join(", "),
      );

      const { result: docResult, error: docErr } = await withTimeout(
        async () => {
          const docWriter = await getDocWriter();
          return docWriter({
            ...docContext,
            emit: (msg, d) => emit("sync:docs", "running", msg, d),
          });
        },
        TIMEOUTS.docs,
        "Doc Writer",
      );

      if (docErr) {
        docErrors.push(
          ...llmSectionsNeeded.map((s) => ({
            section: s,
            error: docErr.message,
          })),
        );
        syncErrors.push({ agent: "docs_llm", error: docErr.message });
        emit(
          "sync:docs",
          "error",
          "LLM doc generation failed — existing content preserved",
          docErr.message,
        );
      } else {
        for (const section of llmSectionsNeeded) {
          if (docResult?.[section]) {
            newOutput[section] = docResult[section];
            regenerated.push(section);
            if (editedSectionNames.has(section)) {
              skipped.push({ section, reason: "user_edit_preserved_as_stale" });
            }
          }
        }
      }
    }

    const docsDuration = Date.now() - docsStart;
    emit(
      "sync:docs",
      "done",
      `${regenerated.length} sections updated · ${skipped.length} user-edits marked stale`,
      `${(docsDuration / 1000).toFixed(1)}s`,
    );

    // ── PHASE 8: Update file manifest ─────────────────────────────
    // Await the background tree fetch (started during agent execution)
    const resolvedTree = await treePromise;
    const newManifest = updateFileManifest(
      project.fileManifest,
      resolvedTree,
      mergedProjectMap,
    );

    // ── PHASE 9: Version history (parallel writes) ─────────────────
    await Promise.all(
      regenerated.map((section) =>
        DocumentVersion.createVersion({
          projectId: project._id,
          section,
          content: newOutput[section] ?? "",
          source: "ai_incremental",
          meta: {
            commitSha: currentSha,
            previousSha: project.lastDocumentedCommit,
            changedFiles: changedPathsToFetch.slice(0, 20),
            agentsRun: [...agentsNeeded],
            changeSummary: `Incremental sync ${project.lastDocumentedCommit?.slice(0, 8) ?? "initial"} → ${currentSha.slice(0, 8)}`,
          },
        }).catch((err) => {
          syncErrors.push({
            agent: "version_history",
            section,
            error: err.message,
          });
        }),
      ),
    );

    // ── PHASE 10: Build MongoDB update payload ─────────────────────
    // Mark user-edited sections as stale if their content was regenerated
    const regeneratedSet = new Set(regenerated);
    const updatedEditedSections = (project.editedSections ?? []).map((es) => ({
      ...(es.toObject?.() ?? es),
      stale: regeneratedSet.has(es.section) ? true : es.stale,
    }));

    const totalDuration = Date.now() - syncStart;
    const mongoUpdate = buildMongoUpdate({
      newOutput,
      currentSha,
      newManifest,
      mergedOutputs,
      securitySummary,
      updatedEditedSections,
      totalDuration,
    });

    emit(
      "sync",
      "done",
      `Sync complete — ${regenerated.length} sections updated`,
      [
        `${project.lastDocumentedCommit?.slice(0, 8) ?? "initial"} → ${currentSha.slice(0, 8)}`,
        `${changedPathsToFetch.length} files · ${(totalDuration / 1000).toFixed(1)}s`,
        syncErrors.length
          ? `⚠ ${syncErrors.length} non-fatal error(s)`
          : "✅ clean",
      ].join(" · "),
      totalDuration,
    );

    return {
      success: true,
      skipped: false,
      isFullRun: false,
      currentCommit: currentSha,
      previousCommit: project.lastDocumentedCommit,
      sectionsRegenerated: regenerated,
      sectionsSkipped: skipped,
      agentsRun: [...agentsNeeded],
      changedFileCount: changedPathsToFetch.length,
      removedFileCount: removedPathSet.size,
      totalDuration,
      errors: syncErrors.length > 0 ? syncErrors : undefined,
      // Diagnostics — per-agent timings for monitoring
      _diagnostics: {
        scan: scanResult._duration,
        api: apiResult._duration,
        schema: schemaResult._duration,
        components: componentResult._duration,
        security: securityResult._duration,
        docs: docsDuration,
        total: totalDuration,
      },
      // Caller (project.service.js) persists this via $set
      _update: mongoUpdate,
    };
  } catch (err) {
    console.error("❌ Incremental sync crashed:", err);
    emit("sync:error", "error", err.message, err.stack?.split("\n")[1]?.trim());
    return { success: false, error: err.message, errors: syncErrors };
  }
}

// ─── Full Sync Fallback ───────────────────────────────────────────

/**
 * Called when incremental sync cannot proceed.
 * Runs the full orchestrator pipeline and maps to incremental return format.
 */
async function fullSyncFallback(
  project,
  owner,
  repo,
  meta,
  currentSha,
  onProgress,
) {
  const emit = (step, status, msg, detail = null) =>
    onProgress?.({ step, status, msg, detail, ts: Date.now() });

  emit("sync:full", "running", "Running full pipeline…", `${owner}/${repo}`);

  const { orchestrate } = await import("./orchestrator.service.js");
  const result = await orchestrate(project.repoUrl, onProgress);

  if (!result.success) return { success: false, error: result.error };

  // Use the adapter pattern (consistent with rest of incremental sync)
  const { git: gitFallback, accessToken: fallbackToken } = resolveGit(project);
  const currentTree = await gitFallback
    .getFileTreeWithSha(owner, repo, meta?.defaultBranch || "main", fallbackToken)
    .catch(() => []);

  const ALL_SECTIONS = [
    "readme",
    "internalDocs",
    "apiReference",
    "schemaDocs",
    "securityReport",
    "remediationReport",
    "componentRef",
    "componentIndex",
  ];

  return {
    success: true,
    skipped: false,
    isFullRun: true,
    currentCommit: currentSha ?? result.lastDocumentedCommit,
    previousCommit: project.lastDocumentedCommit,
    sectionsRegenerated: ALL_SECTIONS,
    sectionsSkipped: [],
    agentsRun: [
      "repoScanner",
      "apiExtractor",
      "schemaAnalyser",
      "componentMapper",
      "securityAuditor",
      "docWriter",
    ],
    changedFileCount: currentTree.length,
    removedFileCount: 0,
    totalDuration: null,
    errors: result.agentErrors,
    _fullResult: result,
    _freshTree: currentTree,
  };
}
