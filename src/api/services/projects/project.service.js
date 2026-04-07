// ===================================================================
// Project Service (Improved)
// ===================================================================
//
// Project management + full/incremental pipeline operations.
//
// Aligned with all improved agents:
//   - Orchestrator  v4: routing, pipelineReport, agentErrors,
//                       architectureHint, layerMap, flagsSummary,
//                       keyFiles, testFrameworks, richer security
//   - Doc Writer    v2: componentRef, componentIndex, remediationReport
//   - Security      v2: categoryCounts, affectedFiles, remediationMarkdown
//   - Repo Scanner  v2: layerMap, flagsSummary, architectureHint,
//                       keyFiles, testFrameworks
//
// Pipeline lifecycle:
//   queued → running → done | error → (archived)
//   error | done → running  (via retryProject or syncProject)
//
// Operations:
//   createProject      — start full pipeline for a new repo
//   retryProject       — re-run full pipeline on an existing project
//   syncProject        — incremental or forced full re-run
//   listProjects       — paginated project list with filtering/sorting
//   getProjectById     — owner or shared-member access
//   getProjectEvents   — SSE event log
//   deleteProject      — owner-only hard delete
//   updateProject      — archive or soft update
//   editDocSection     — save user edit for one doc section
//   revertDocSection   — restore latest AI content, clear user edit
//   acceptAISection    — accept AI regeneration (clears stale flag)
//   listVersions       — paginated version history
//   getVersion         — single version with full content
//   restoreVersion     — restore a historical version as current edit
//   recoverOrphanedJobs — startup recovery for interrupted pipelines
// ===================================================================

import { randomUUID, randomBytes, createHash } from "crypto";

import { Project } from "../../../models/Project.js";
import ActivityLogService from "../../../services/activity-log.service.js";
import { NotificationService } from "../../../services/notification.service.js";
import { DocumentVersion, SECTIONS } from "../../../models/DocumentVersion.js";
import { ProjectShare } from "../../../models/ProjectShare.js";
import { User } from "../../../models/User.js";

import {
  registerJob,
  pushEvent,
  finishJob,
  failJob,
  recoverLostJob,
} from "../../../services/job-registry.service.js";

import {
  detectProvider,
  parseRepoUrl as adapterParseRepoUrl,
  normaliseRepoUrl,
} from "../../../adapters/provider.adapter.js";

// ─── All known output sections ────────────────────────────────────
// Superset of SECTIONS from the model — includes new sections added
// by the improved Doc Writer and Security Auditor.
// The model's SECTIONS constant is the source of truth for validation;
// this list is used for iteration in pipeline persistence.

const ALL_OUTPUT_SECTIONS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "componentRef", // new — LLM-written component reference
  "componentIndex", // new — static component index table
  "securityReport",
  "remediationReport", // new — prioritised remediation checklist
];

// ─── Lazy loaders ─────────────────────────────────────────────────
// Lazy imports avoid circular dependencies and reduce startup time.

let _orchestrate = null;
let _incrementalSync = null;

async function getOrchestrate() {
  if (_orchestrate) return _orchestrate;
  const m = await import("../../../services/orchestrator.service.js");
  _orchestrate = m.orchestrate;
  return _orchestrate;
}

async function getIncrementalSync() {
  if (_incrementalSync) return _incrementalSync;
  const m =
    await import("../../../services/incremental-orchestrator.service.js");
  _incrementalSync = m.incrementalSync;
  return _incrementalSync;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Parse any supported git provider URL.
 * Auto-detects provider from the URL host.
 * Returns { owner, repoName, normalised, provider }.
 *
 * Note: Azure DevOps requires special handling as it returns
 * { owner, project, repo } instead of { owner, repo }
 */
function parseRepoUrl(raw) {
  const provider = detectProvider(raw);
  try {
    const parsed = adapterParseRepoUrl(provider, raw);

    // Extract repoName based on provider
    let repoName, owner;
    if (provider === "azure") {
      owner = parsed.owner;
      repoName = parsed.repo;
      // For Azure: owner is org, repo is the repository name
      // project is the Azure DevOps project name
    } else {
      owner = parsed.owner;
      repoName = parsed.repo;
    }

    return {
      owner,
      repoName,
      normalised: normaliseRepoUrl(provider, raw),
      provider,
    };
  } catch (err) {
    const message = `Cannot parse repository URL: "${raw}"`;
    console.error(`[parseRepoUrl] ${message}`, {
      provider: detectProvider(raw),
      error: err.message,
    });
    const error = new Error(message);
    error.code = "INVALID_REPO_URL";
    error.status = 400;
    throw error;
  }
}

/**
 * Create a typed domain error with code and HTTP status.
 */
function domainError(msg, code, status = 400) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

/**
 * Assert that userId is the owner of projectId.
 * Returns the project document or throws PROJECT_NOT_FOUND.
 */
async function assertOwnership(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return project;
}

/**
 * Assert that userId has at least the given role on the project.
 * Supports: owner, editor, viewer.
 */
async function assertAccess(projectId, userId, requiredRole = "viewer") {
  // Check owner first
  const ownedProject = await Project.findOne({ _id: projectId, userId });
  if (ownedProject) {
    ownedProject._shareRole = "owner";
    return ownedProject;
  }

  // Check shared access
  const project = await Project.findById(projectId);
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  const user = await User.findById(userId).select("email").lean();
  const share = await ProjectShare.findOne({
    projectId,
    status: "accepted",
    $or: [
      { inviteeUserId: userId },
      ...(user?.email ? [{ inviteeEmail: user.email }] : []),
    ],
  }).lean();

  if (!share) throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  // Role hierarchy: owner > editor > viewer
  const ROLE_RANK = { owner: 3, editor: 2, viewer: 1 };
  if ((ROLE_RANK[share.role] ?? 0) < (ROLE_RANK[requiredRole] ?? 0)) {
    throw domainError(
      `This action requires ${requiredRole} access.`,
      "INSUFFICIENT_PERMISSIONS",
      403,
    );
  }

  project._shareRole = share.role;
  return project;
}

/**
 * Parse a sort query string param into a Mongoose sort object.
 * Whitelists allowed fields to prevent injection.
 */
function parseSortParam(sort = "-createdAt") {
  const ALLOWED = new Set([
    "createdAt",
    "updatedAt",
    "repoName",
    "status",
    "security.score",
  ]);
  const desc = sort.startsWith("-");
  const field = desc ? sort.slice(1) : sort;
  if (!ALLOWED.has(field)) return { createdAt: -1 };
  return { [field]: desc ? -1 : 1 };
}

/**
 * Normalise the security object from the improved Security Auditor.
 * Handles both old schema (no categoryCounts) and new schema.
 */
function normaliseSecurity(security) {
  if (!security) return {};
  return {
    score: security.score ?? 100,
    grade: security.grade ?? "A",
    counts: security.counts ?? { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    categoryCounts: security.categoryCounts ?? {},
    affectedFiles: (security.affectedFiles ?? []).slice(0, 10),
    findings: (security.findings ?? []).slice(0, 50),
  };
}

/**
 * Normalise stats from the improved Orchestrator.
 * Handles both old schema (fewer fields) and new schema.
 */
function normaliseStats(stats, result) {
  return {
    filesAnalysed: stats?.filesAnalysed ?? 0,
    filesClassified: stats?.filesClassified ?? 0,
    endpoints: stats?.endpoints ?? 0,
    models: stats?.models ?? 0,
    relationships: stats?.relationships ?? 0,
    components: stats?.components ?? 0,
    securityFindings: stats?.securityFindings ?? 0,
    docsGenerated: stats?.docsGenerated ?? 0,
    totalDuration: stats?.totalDuration ?? null,
    lastFullRunAt: new Date(),
  };
}

/**
 * Build a file manifest from a tree + projectMap.
 * Used when full sync returns a fresh tree.
 */
function buildManifestFromTree(tree, projectMap) {
  const roleMap = new Map((projectMap || []).map((p) => [p.path, p.role]));
  const layerMap = new Map((projectMap || []).map((p) => [p.path, p.layer]));
  return (tree || []).map((f) => ({
    path: f.path,
    sha: f.sha || "",
    role: roleMap.get(f.path) || "",
    layer: layerMap.get(f.path) || "",
  }));
}

/**
 * Build the SSE progress handler.
 * Pushes events to the in-memory job registry AND persists
 * the last 200 events to MongoDB (capped slice) for recovery.
 *
 * IMPROVED: Adds checkpoint tracking to detect progress stalls.
 */
function makeProgressHandler(projectId, jobId) {
  let lastCheckpointTime = Date.now();

  return async (event) => {
    // Always push to in-memory registry (instant SSE delivery)
    pushEvent(jobId, event);

    // Track checkpoint for stall detection
    if (
      event.status === "done" ||
      event.status === "error" ||
      event.status === "running"
    ) {
      lastCheckpointTime = Date.now();
    }

    // Persist to DB — non-critical, swallow errors
    try {
      await Project.updateOne(
        { _id: projectId },
        {
          $push: {
            events: { $each: [event], $slice: -200 }, // Keep last 200 events
          },
          // Update metadata for monitoring
          "meta.lastProgressAt": new Date(),
          "meta.lastProgressStep": event.step,
        },
      );
    } catch {
      /* non-critical — SSE still delivered via in-memory registry */
    }
  };
}

/**
 * Create initial DocumentVersion entries for all sections after
 * a full pipeline run. Runs in parallel for speed.
 */
async function createInitialVersions(projectId, output, commitSha) {
  const promises = ALL_OUTPUT_SECTIONS.map(async (section) => {
    const content = output?.[section];
    if (!content) return;
    try {
      await DocumentVersion.createVersion({
        projectId,
        section,
        content,
        source: "ai_full",
        meta: {
          commitSha,
          agentsRun: [
            "repoScanner",
            "apiExtractor",
            "schemaAnalyser",
            "componentMapper",
            "securityAuditor",
            "docWriter",
          ],
          changeSummary: "Initial full pipeline run",
        },
      });
    } catch (err) {
      // Version history failure is non-fatal
      console.warn(
        `[versions] Failed to create version for ${section}:`,
        err.message,
      );
    }
  });
  await Promise.all(promises);
}

/**
 * Build the full project update payload from a successful orchestrate result.
 * Centralises all field mapping in one place so runPipeline and runSync
 * (full fallback path) are consistent.
 */
function buildFullRunUpdate(result, commitSha, freshTree) {
  return {
    status: "done",
    techStack: result.techStack || [],
    testFrameworks: result.testFrameworks || [],
    architectureHint: result.architectureHint || "",
    entryPoints: result.entryPoints || [],
    keyFiles: result.keyFiles || [],
    stats: normaliseStats(result.stats, result),
    meta: result.meta || {},
    output: result.output || {},
    chatSessionId: result.chat?.sessionId || null,
    security: normaliseSecurity(result.security),
    lastDocumentedCommit: commitSha || result.lastDocumentedCommit || null,
    fileManifest: freshTree
      ? buildManifestFromTree(freshTree, result.agentOutputs?.projectMap || [])
      : result.fileManifest || [],
    agentOutputs: result.agentOutputs || {},
    // New fields from improved agents
    "agentOutputs.summaries": result.agentOutputs?.summaries || {},
    routing: result.routing || null,
    pipelineReport: result.pipelineReport?.markdown || null,
    agentErrors: result.agentErrors || [],
    search_language: "english",
  };
}

// ─── Startup Recovery ─────────────────────────────────────────────

/**
 * Startup Recovery (Improved)
 * Called once at server startup.
 * Finds projects stuck in "running" or "queued" state (server crash),
 * marks them as "error", and registers synthetic lost jobs.
 *
 * Also checks for Vercel-timeout scenarios where the pipeline timed out
 * but the backend job might still be running. For those, uses a more
 * lenient recovery message to avoid false positives.
 */
export async function recoverOrphanedJobs() {
  try {
    const { jobs, isVercelTimedOut, getStaleJobs } =
      await import("../../../services/job-registry.service.js");

    const orphans = await Project.find({
      status: { $in: ["running", "queued"] },
    }).select("_id jobId status repoName createdAt");

    if (orphans.length === 0) return;

    const { staleJobs } = getStaleJobs();
    const RECOVERY_MSG = "Pipeline was interrupted. Please retry.";
    const TIMEOUT_RECOVERY_MSG =
      "Pipeline hit the 60s timeout on Vercel. It may still be running in the background. Please retry.";

    const orphanIds = [];
    let recovered = 0;

    for (const p of orphans) {
      // Skip if already registered — genuine in-flight pipeline
      if (p.jobId && jobs.has(p.jobId)) {
        console.log(`[recovery] Job ${p.jobId} still in memory, not orphaned`);
        continue;
      }

      if (p.jobId) {
        const isVercelTimeout = await isVercelTimedOut(p.jobId);
        const msg = isVercelTimeout ? TIMEOUT_RECOVERY_MSG : RECOVERY_MSG;
        recoverLostJob(p.jobId, msg);
        recovered++;
        console.log(
          `[recovery] Registered lost job ${p.jobId} ${isVercelTimeout ? "(Vercel timeout)" : "(server restart)"}`,
        );
      }
      orphanIds.push(p._id);
    }

    if (orphanIds.length > 0) {
      await Project.updateMany(
        { _id: { $in: orphanIds } },
        {
          status: "error",
          errorMessage: RECOVERY_MSG,
          "meta.recoveredAt": new Date(),
        },
      );

      console.log(
        `[recovery] Marked ${orphanIds.length} orphaned project(s) as error (recovered: ${recovered}).`,
        orphans
          .filter((p) => orphanIds.some((id) => id.equals(p._id)))
          .map(
            (p) =>
              `${p.repoName} (${p.jobId}) · age: ${Date.now() - p.createdAt.getTime()}ms`,
          )
          .join(", "),
      );
    }
  } catch (err) {
    console.error("[recovery] Failed to recover orphaned jobs:", err.message);
  }
}

// ─── Project CRUD ─────────────────────────────────────────────────

/**
 * Create a new project and start the full documentation pipeline.
 * Returns immediately with the project document — pipeline runs async.
 */
/**
 * Create a new documentation project for a GitHub/GitLab/Azure DevOps repository.
 * Logs the project creation to changelog.
 *
 * Process:
 * 1. Parse and validate repository URL
 * 2. Check for duplicate pipelines
 * 3. For GitLab: fetch and encrypt access token
 * 4. For Azure DevOps: fetch and encrypt access token
 * 5. Create project document
 * 6. Register async pipeline job
 */
export async function createProject({ userId, repoUrl }) {
  try {
    // provider is auto-detected from the URL (github.com vs gitlab.com vs dev.azure.com)
    const { owner, repoName, normalised, provider } = parseRepoUrl(repoUrl);

    console.log("[createProject] Parsed repo URL", {
      provider,
      owner,
      repoName,
      repoUrl: normalised,
    });

    // Prevent duplicate pipelines for the same repo
    const active = await Project.findOne({
      userId,
      repoOwner: owner,
      repoName,
      status: { $in: ["queued", "running"] },
    });
    if (active) {
      console.warn("[createProject] Duplicate pipeline detected", {
        userId,
        owner,
        repoName,
      });
      throw domainError(
        `A pipeline for ${owner}/${repoName} is already in progress.`,
        "DUPLICATE_PROJECT",
        409,
      );
    }

    // For GitLab: look up the user's stored access token so the pipeline
    // can authenticate against the GitLab API.
    let providerToken = null;
    if (provider === "gitlab") {
      const user = await User.findById(userId).select("+gitlabTokenEncrypted");
      if (!user?.gitlabTokenEncrypted) {
        console.warn("[createProject] GitLab token not found", { userId });
        throw domainError(
          "GitLab account not connected. Connect via Settings → GitLab.",
          "GITLAB_NOT_CONNECTED",
          400,
        );
      }
      // Decrypt once here; re-encrypt and store on the project so the
      // pipeline can use it without another DB round-trip.
      const { encrypt, decrypt } =
        await import("../../../utils/crypto.util.js");
      providerToken = encrypt(decrypt(user.gitlabTokenEncrypted));
      console.log("[createProject] GitLab token prepared for project");
    }

    // For Azure DevOps: look up the user's stored access token
    if (provider === "azure") {
      const user = await User.findById(userId).select(
        "+azureDevOpsTokenEncrypted",
      );
      if (!user?.azureDevOpsTokenEncrypted) {
        console.warn("[createProject] Azure DevOps token not found", {
          userId,
        });
        throw domainError(
          "Azure DevOps account not connected. Connect via Settings → Azure DevOps.",
          "AZURE_NOT_CONNECTED",
          400,
        );
      }
      // Decrypt once here; re-encrypt and store on the project
      const { encrypt, decrypt } =
        await import("../../../utils/crypto.util.js");
      providerToken = encrypt(decrypt(user.azureDevOpsTokenEncrypted));
      console.log("[createProject] Azure DevOps token prepared for project");
    }

    // For Bitbucket: look up the user's stored access token
    if (provider === "bitbucket") {
      const user = await User.findById(userId).select(
        "+bitbucketTokenEncrypted",
      );
      if (!user?.bitbucketTokenEncrypted) {
        console.warn("[createProject] Bitbucket token not found", { userId });
        throw domainError(
          "Bitbucket account not connected. Connect via Settings → Bitbucket.",
          "BITBUCKET_NOT_CONNECTED",
          400,
        );
      }
      const { encrypt, decrypt } =
        await import("../../../utils/crypto.util.js");
      providerToken = encrypt(decrypt(user.bitbucketTokenEncrypted));
      console.log("[createProject] Bitbucket token prepared for project");
    }

    // For GitHub: look up the user's stored access token from GitHubToken collection
    if (provider === "github") {
      const { GitHubToken } =
        await import("../../../models/GitHubToken.js");
      const githubToken = await GitHubToken.findOne({ userId }).select(
        "+accessTokenEncrypted",
      );
      if (githubToken?.accessTokenEncrypted) {
        // Decrypt once here; re-encrypt and store on the project so the
        // pipeline can use it without another DB round-trip.
        const { encrypt, decrypt } =
          await import("../../../utils/crypto.util.js");
        providerToken = encrypt(decrypt(githubToken.accessTokenEncrypted));
        console.log("[createProject] GitHub token prepared for project");
      } else {
        console.warn("[createProject] GitHub token not found for user", {
          userId,
        });
        // GitHub token is optional — public repos can be accessed without it
        // but rate limits are much lower (60 req/hour vs 5000 req/hour with token)
        console.log("[createProject] Proceeding without GitHub token (rate limits will apply)");
      }
    }

    const jobId = randomUUID();
    const webhookSecret = randomBytes(32).toString("hex");

    const project = await Project.create({
      userId,
      repoUrl: normalised,
      repoOwner: owner,
      repoName,
      provider,
      providerToken,
      jobId,
      status: "running",
      search_language: "english",
      webhookSecret,
      webhookEnabled: true,
    });

    console.log("[createProject] Project created successfully", {
      projectId: project._id,
      provider,
      owner,
      repoName,
    });

    registerJob(jobId);

    ActivityLogService.log({
      userId,
      action: "PROJECT_CREATED",
      projectId: project._id,
      projectName: `${owner}/${repoName}`,
      metadata: { provider, owner, repoName, repoUrl: normalised },
    });

    // Log project creation to changelog
    try {
      const { logProjectChange } =
        await import("../../../services/changelog.service.js");
      await logProjectChange(project._id, userId, "pipeline_started", {
        details: `Analysis pipeline started for ${owner}/${repoName}`,
      });
    } catch (err) {
      console.warn("[changelog] Failed to log project creation:", err.message);
    }

    runPipeline({ project, normalised, jobId }).catch((err) =>
      console.error(`❌ Pipeline crash [${jobId}]:`, err.message),
    );

    return project;
  } catch (err) {
    console.error("[createProject] Error creating project", {
      error: err.code || err.message,
      repoUrl,
    });
    throw err;
  }
}

/**
 * Create a blank "from scratch" project.
 * No repository, no pipeline — just an empty documentation project.
 */
export async function createFromScratchProject({ userId, projectName }) {
  if (!projectName || projectName.trim().length === 0) {
    throw domainError("Project name is required.", "INVALID_PROJECT_NAME", 400);
  }

  // Use project name as both owner and repo name for pseudo-URL
  const cleanName = projectName.trim().replace(/\s+/g, "-").toLowerCase();

  // Check for duplicates with same name
  const existing = await Project.findOne({
    userId,
    repoName: cleanName,
    sourceType: "manual",
    status: { $ne: "archived" },
  });

  if (existing) {
    throw domainError(
      `A project named "${projectName}" already exists.`,
      "DUPLICATE_PROJECT",
      409,
    );
  }

  const project = await Project.create({
    userId,
    repoUrl: `manual://${cleanName}`, // pseudo-URL for manual projects
    repoOwner: "manual",
    repoName: cleanName,
    provider: "github", // default provider (unused for manual projects)
    sourceType: "manual", // marks as from-scratch
    status: "done", // no pipeline needed
    meta: {
      name: projectName,
      description: `Manual documentation for ${projectName}`,
    },
    output: {
      readme: `# ${projectName}\n\nProject documentation created from scratch. Start editing!`,
      internalDocs: "",
      apiReference: "",
      schemaDocs: "",
      securityReport: "",
    },
    editedOutput: {},
    editedSections: [],
    stats: {
      filesAnalysed: 0,
      endpoints: 0,
      models: 0,
      relationships: 0,
      components: 0,
    },
  });

  return project;
}

//  * Clears all stored outputs so the run starts from a clean state.
export async function retryProject({ projectId, userId }) {
  const project = await assertOwnership(projectId, userId);

  if (project.status === "running" || project.status === "queued")
    throw domainError("Pipeline is already running.", "PROJECT_RUNNING", 409);
  if (project.status === "archived")
    throw domainError(
      "Cannot retry an archived project.",
      "PROJECT_ARCHIVED",
      409,
    );

  const jobId = randomUUID();

  // Clear all outputs before retry to ensure a clean state
  await Project.findByIdAndUpdate(project._id, {
    $set: {
      jobId,
      status: "running",
      errorMessage: null,
      techStack: [],
      testFrameworks: [],
      architectureHint: "",
      entryPoints: [],
      keyFiles: [],
      stats: {},
      security: {},
      output: {},
      agentOutputs: {},
      routing: null,
      pipelineReport: null,
      agentErrors: [],
      chatSessionId: null,
      archivedAt: null,
      lastDocumentedCommit: null,
      fileManifest: [],
      events: [],
      editedSections: [],
      editedOutput: {},
    },
  });

  registerJob(jobId);

  runPipeline({ project, normalised: project.repoUrl, jobId }).catch((err) =>
    console.error(`❌ Retry crash [${jobId}]:`, err.message),
  );

  return Project.findById(project._id);
}

/**
 * List projects for a user with pagination, filtering, and sorting.
 */
export async function listProjects({
  userId,
  page = 1,
  limit = 20,
  status,
  sort = "-createdAt",
  search,
}) {
  const query = { userId };
  if (status) query.status = status;
  if (search) query.$text = { $search: search };

  const sortObj = parseSortParam(sort);

  const [projects, total] = await Promise.all([
    Project.find(query)
      .sort(sortObj)
      .skip((page - 1) * limit)
      .limit(limit)
      // Exclude large fields from list queries
      .select(
        "-output -events -editedOutput -fileManifest -agentOutputs -pipelineReport",
      ),
    Project.countDocuments(query),
  ]);

  return {
    projects,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get a project by ID.
 * Accessible to the owner or any user with an accepted share invitation.
 * Attaches _shareRole to the document for downstream permission checks.
 */
export async function getProjectById({ projectId, userId }) {
  return assertAccess(projectId, userId, "viewer");
}

/**
 * Return the pipeline event log.
 * Accessible to owners and shared members (viewer+).
 */
export async function getProjectEvents({ projectId, userId }) {
  await assertAccess(projectId, userId, "viewer");

  const project = await Project.findById(projectId).select(
    "status jobId events",
  );
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  return {
    events: project.events || [],
    status: project.status,
    jobId: project.jobId,
  };
}

/**
 * Hard-delete a project and all its version history.
 * Owner-only.
 */
export async function deleteProject({ projectId, userId }) {
  const project = await assertOwnership(projectId, userId);

  if (project.status === "running" || project.status === "queued")
    throw domainError(
      "Cannot delete a running project.",
      "PROJECT_RUNNING",
      409,
    );

  await Promise.all([
    Project.findByIdAndDelete(projectId),
    DocumentVersion.deleteMany({ projectId }),
  ]);
}

/**
 * Soft-update a project (currently: archive only).
 * Owner-only.
 */
export async function updateProject({ projectId, userId, updates }) {
  const project = await assertOwnership(projectId, userId);
  let didUpdate = false;

  if (typeof updates?.name === "string") {
    const name = updates.name.trim();
    if (!name) {
      throw domainError(
        "Project name is required.",
        "INVALID_PROJECT_NAME",
        422,
      );
    }
    if (name.length > 80) {
      throw domainError(
        "Project name must be 80 characters or fewer.",
        "INVALID_PROJECT_NAME",
        422,
      );
    }
    project.meta = project.meta || {};
    project.meta.name = name;
    didUpdate = true;
  }

  if (typeof updates?.description === "string") {
    const description = updates.description.trim();
    project.meta = project.meta || {};
    project.meta.description = description.length ? description : null;
    didUpdate = true;
  }

  if (updates.status === "archived") {
    if (project.status === "running" || project.status === "queued")
      throw domainError(
        "Cannot archive a running project.",
        "PROJECT_RUNNING",
        409,
      );

    project.status = "archived";
    project.archivedAt = new Date();
    didUpdate = true;
  }

  if (didUpdate) {
    await project.save();
  }

  return project;
}

// ─── Incremental Sync ─────────────────────────────────────────────

/**
 * Check for new commits and run only the affected pipeline segments.
 * Falls back to a full run if:
 *   - No stored baseline exists
 *   - A manifest file changed
 *   - forceFullRun = true
 *   - Changed file count exceeds FULL_RUN_THRESHOLD
 *
 * Accessible to owner only — sync mutates project state.
 *
 * @param {{ projectId, userId, forceFullRun, webhookChangedFiles }}
 * @returns {{ project, streamUrl }}
 */
/**
 * Sync a project — check for new commits and re-document.
 * Logs the sync operation to changelog.
 */
export async function syncProject({
  projectId,
  userId,
  forceFullRun = false,
  webhookChangedFiles = null,
}) {
  // Load with extra fields needed for incremental sync
  const project = await Project.findOne({ _id: projectId, userId }).select(
    "+agentOutputs +fileManifest +events",
  );

  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);

  if (project.status === "running" || project.status === "queued")
    throw domainError("A pipeline is already running.", "PROJECT_RUNNING", 409);
  if (project.status === "archived")
    throw domainError(
      "Cannot sync an archived project.",
      "PROJECT_ARCHIVED",
      409,
    );
  if (project.status !== "done" && project.status !== "error")
    throw domainError(
      "Project must be in done or error state to sync.",
      "PROJECT_NOT_READY",
      409,
    );

  const jobId = randomUUID();
  project.jobId = jobId;
  project.status = "running";
  project.errorMessage = null;
  await project.save();

  registerJob(jobId);

  // Log sync operation to changelog
  try {
    const { logProjectChange } =
      await import("../../../services/changelog.service.js");
    await logProjectChange(projectId, userId, "pipeline_started", {
      details: forceFullRun
        ? "Full re-analysis started"
        : "Incremental sync started",
    });
  } catch (err) {
    console.warn("[changelog] Failed to log sync:", err.message);
  }

  // Fire-and-forget — caller streams progress via SSE
  runSync({ project, jobId, forceFullRun, webhookChangedFiles }).catch((err) =>
    console.error(`❌ Sync crash [${jobId}]:`, err.message),
  );

  return {
    project,
    streamUrl: `/projects/${project._id}/stream`,
  };
}

// ─── Document Editing ─────────────────────────────────────────────

/**
 * Save a user edit for one documentation section.
 * Requires editor or owner access.
 *
 * Flow:
 *   1. Snapshot current effective content as a version
 *   2. Write new content to editedOutput
 *   3. Mark section in editedSections
 *   4. Create version entry for the new edit
 */
export async function editDocSection({ projectId, userId, section, content }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  const project = await assertAccess(projectId, userId, "editor");

  if (project.status !== "done")
    throw domainError(
      "Can only edit documentation for completed projects.",
      "PROJECT_NOT_READY",
      409,
    );

  // Snapshot current content before overwriting
  const currentContent =
    project.editedOutput?.[section] || project.output?.[section] || "";

  const snapshotSource = project.editedSections?.some(
    (s) => s.section === section,
  )
    ? "user"
    : "ai_full";

  if (currentContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section,
      content: currentContent,
      source: snapshotSource,
      meta: { changeSummary: "Snapshot before user edit" },
    }).catch((err) => console.warn("[versions] Snapshot failed:", err.message));
  }

  // Apply the edit
  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== section,
  );
  editedSections.push({ section, editedAt: new Date(), stale: false });

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${section}`]: content,
    editedSections,
  });

  // Record the new edit as a version
  await DocumentVersion.createVersion({
    projectId: project._id,
    section,
    content,
    source: "user",
    meta: { changeSummary: "User edit" },
  }).catch((err) =>
    console.warn("[versions] Version save failed:", err.message),
  );

  // Log the change to changelog
  try {
    const { logSectionEdit } =
      await import("../../../services/changelog.service.js");
    await logSectionEdit(projectId, userId, section, currentContent, content);
  } catch (err) {
    console.warn("[changelog] Failed to log section edit:", err.message);
  }

  return getProjectById({ projectId, userId });
}

/**
 * Revert a section to its latest AI-generated content.
 * Clears editedOutput and editedSections entry for this section.
 * Requires editor or owner access.
 */
export async function revertDocSection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  await assertAccess(projectId, userId, "editor");

  const editedSections =
    (
      await Project.findById(projectId).select("editedSections").lean()
    )?.editedSections?.filter((s) => s.section !== section) || [];

  await Project.findByIdAndUpdate(projectId, {
    [`editedOutput.${section}`]: "",
    editedSections,
  });

  return getProjectById({ projectId, userId });
}

/**
 * Accept the new AI-generated content for a stale section.
 * Semantically identical to revertDocSection — clears the user edit
 * and the stale flag, making the AI version the active content.
 * Requires editor or owner access.
 */
export async function acceptAISection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  // Save a version of the user's content before discarding it
  const project = await assertAccess(projectId, userId, "editor");
  const userContent = project.editedOutput?.[section];

  if (userContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section,
      content: userContent,
      source: "user",
      meta: { changeSummary: "Snapshot before accepting AI regeneration" },
    }).catch((err) => console.warn("[versions] Snapshot failed:", err.message));
  }

  // Log the change to changelog
  try {
    const { logSectionAccept } =
      await import("../../../services/changelog.service.js");
    await logSectionAccept(projectId, userId, section);
  } catch (err) {
    console.warn("[changelog] Failed to log section accept:", err.message);
  }

  return revertDocSection({ projectId, userId, section });
}

// ─── Version History ──────────────────────────────────────────────

/**
 * List version history for a section — newest first.
 * Content is excluded from list results (too large); use getVersion for full content.
 * Accessible to owner and shared members (viewer+).
 */
export async function listVersions({
  projectId,
  userId,
  section,
  page = 1,
  limit = 20,
}) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );

  await assertAccess(projectId, userId, "viewer");

  const [versions, total] = await Promise.all([
    DocumentVersion.find({ projectId, section })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-content"),
    DocumentVersion.countDocuments({ projectId, section }),
  ]);

  return { versions, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/**
 * Fetch a single version with full content.
 * Accessible to owner and shared members (viewer+).
 */
export async function getVersion({ projectId, userId, versionId }) {
  await assertAccess(projectId, userId, "viewer");

  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);

  return version;
}

/**
 * Restore a historical version as the current user edit.
 * Snapshots current content first, then applies restore.
 * Requires editor or owner access.
 */
export async function restoreVersion({ projectId, userId, versionId }) {
  const project = await assertAccess(projectId, userId, "editor");
  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);

  if (project.status !== "done")
    throw domainError(
      "Can only restore versions for completed projects.",
      "PROJECT_NOT_READY",
      409,
    );

  // Snapshot current effective content before restore
  const currentContent =
    project.editedOutput?.[version.section] ||
    project.output?.[version.section] ||
    "";

  if (currentContent) {
    await DocumentVersion.createVersion({
      projectId: project._id,
      section: version.section,
      content: currentContent,
      source: "user",
      meta: {
        changeSummary: `Snapshot before restore to version ${version._id}`,
      },
    }).catch((err) => console.warn("[versions] Snapshot failed:", err.message));
  }

  // Apply the restored content as a user edit
  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== version.section,
  );
  editedSections.push({
    section: version.section,
    editedAt: new Date(),
    stale: false,
  });

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${version.section}`]: version.content,
    editedSections,
  });

  // Record the restore as a version
  await DocumentVersion.createVersion({
    projectId: project._id,
    section: version.section,
    content: version.content,
    source: "user",
    meta: {
      changeSummary: `Restored from version ${version._id} (${version.source} · ${version.createdAt.toISOString()})`,
    },
  }).catch((err) =>
    console.warn("[versions] Restore version save failed:", err.message),
  );

  return getProjectById({ projectId, userId });
}

// ─── Internal Pipeline Runners ────────────────────────────────────

/**
 * Run the full 6-agent documentation pipeline.
 * Called by createProject and retryProject.
 * Persists the complete result to MongoDB and finishes the job.
 */
/**
 * Run the full pipeline asynchronously.
 * On Vercel, if the HTTP request is going to timeout (60s), we don't want
 * to leave the job in limbo. Instead, we detect timeout and flag it so that
 * retry works properly. The job continues in the background.
 */
async function runPipeline({ project, normalised, jobId }) {
  const orchestrate = await getOrchestrate();
  const onProgress = makeProgressHandler(project._id, jobId);
  const isVercel =
    !!process.env.VERCEL && process.env.NODE_ENV === "production";

  // Decrypt the provider token if it exists (GitHub, GitLab, or Azure DevOps)
  let providerTokenDecrypted = null;
  if (project.providerToken) {
    const { decrypt } = await import("../../../utils/crypto.util.js");
    try {
      providerTokenDecrypted = decrypt(project.providerToken);
    } catch (err) {
      console.warn("[runPipeline] Failed to decrypt provider token:", err.message);
    }
  }

  try {
    ActivityLogService.log({
      userId: project.userId,
      action: "PIPELINE_STARTED",
      projectId: project._id,
      projectName: `${project.repoOwner}/${project.repoName}`,
      metadata: { jobId, provider: project.provider },
    });

    // On Vercel, wrap orchestrate with a timeout detector (55s for safety margin)
    let result;
    if (isVercel) {
      result = await Promise.race([
        orchestrate(normalised, onProgress, {
          provider: project.provider,
          token: providerTokenDecrypted,
        }),
        new Promise(
          (_, reject) =>
            setTimeout(() => reject(new Error("VERCEL_HTTP_TIMEOUT")), 55_000), // 55s timeout on Vercel
        ),
      ]);
    } else {
      result = await orchestrate(normalised, onProgress, {
        provider: project.provider,
        token: providerTokenDecrypted,
      });
    }

    if (!result.success) {
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: result.error || "Unknown pipeline error",
      });
      ActivityLogService.log({
        userId: project.userId,
        action: "PIPELINE_FAILED",
        projectId: project._id,
        projectName: `${project.repoOwner}/${project.repoName}`,
        metadata: { jobId, error: result.error || "Unknown pipeline error" },
      });
      NotificationService.create({
        userId: project.userId,
        type: "PIPELINE_FAILED",
        projectId: project._id,
        actionUrl: `/projects/${project._id}`,
        metadata: { projectName: `${project.repoOwner}/${project.repoName}`, reason: result.error || "an unexpected error" },
      });
      failJob(jobId, new Error(result.error || "Unknown pipeline error"));
      return;
    }

    // Build and persist the full update
    const update = buildFullRunUpdate(
      result,
      result.lastDocumentedCommit,
      null,
    );
    await Project.findByIdAndUpdate(project._id, { $set: update });

    // Create version history for all generated sections (parallel)
    await createInitialVersions(
      project._id,
      result.output,
      result.lastDocumentedCommit,
    );

    // Log non-fatal agent errors to console (they're also stored in agentErrors field)
    if (result.agentErrors?.length) {
      console.warn(
        `[pipeline:${jobId}] ${result.agentErrors.length} non-fatal agent error(s):`,
        result.agentErrors.map((e) => `${e.agent}: ${e.error}`).join("; "),
      );
    }

    ActivityLogService.log({
      userId: project.userId,
      action: "PIPELINE_COMPLETED",
      projectId: project._id,
      projectName: `${project.repoOwner}/${project.repoName}`,
      metadata: {
        jobId,
        stats: result.stats,
        agentErrorCount: result.agentErrors?.length ?? 0,
      },
    });
    NotificationService.create({
      userId: project.userId,
      type: "PIPELINE_COMPLETED",
      projectId: project._id,
      actionUrl: `/projects/${project._id}`,
      metadata: { projectName: `${project.repoOwner}/${project.repoName}` },
    });

    finishJob(jobId, {
      success: true,
      stats: result.stats,
      security: result.security,
      agentErrors: result.agentErrors,
      routing: result.routing,
    });

    // ── Trigger Slack Security Alerts ──────────────────────────────
    // After pipeline completes, send alerts to Slack if configured
    try {
      const { triggerSecurityAlerts } =
        await import("../../../services/slack-webhook.service.js");
      await triggerSecurityAlerts(project._id, result.security);
    } catch (err) {
      console.warn(
        `[pipeline:${jobId}] Slack alert trigger failed (non-fatal):`,
        err.message,
      );
    }

    // ── Security finding notifications ─────────────────────────────
    if (result.security?.findings?.length) {
      const projectName = `${project.repoOwner}/${project.repoName}`;
      const criticals = result.security.findings.filter((f) => f.severity === "critical");
      const highs = result.security.findings.filter((f) => f.severity === "high");
      for (const finding of criticals) {
        NotificationService.create({
          userId: project.userId,
          type: "SECURITY_CRITICAL_FINDING",
          projectId: project._id,
          actionUrl: `/projects/${project._id}#security`,
          metadata: { projectName, finding: finding.title ?? finding.rule ?? "a critical vulnerability" },
        });
      }
      for (const finding of highs) {
        NotificationService.create({
          userId: project.userId,
          type: "SECURITY_HIGH_FINDING",
          projectId: project._id,
          actionUrl: `/projects/${project._id}#security`,
          metadata: { projectName, finding: finding.title ?? finding.rule ?? "a high-severity vulnerability" },
        });
      }
      NotificationService.create({
        userId: project.userId,
        type: "SECURITY_REPORT_READY",
        projectId: project._id,
        actionUrl: `/projects/${project._id}#security`,
        metadata: { projectName },
      });
    }
  } catch (err) {
    // Detect Vercel timeout scenario
    if (err.message === "VERCEL_HTTP_TIMEOUT") {
      console.warn(`[pipeline:${jobId}] Vercel 55s timeout — marking project as error (retryable).`);
      const { flagVercelTimeout } =
        await import("../../../services/job-registry.service.js");
      flagVercelTimeout(jobId);
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: "Pipeline timed out. Click retry to continue.",
        "meta.vercelTimedOut": true,
        "meta.vercelTimeoutAt": new Date(),
      }).catch(() => {});
      ActivityLogService.log({
        userId: project.userId,
        action: "PIPELINE_TIMEOUT",
        projectId: project._id,
        projectName: `${project.repoOwner}/${project.repoName}`,
        metadata: { jobId },
      });
      NotificationService.create({
        userId: project.userId,
        type: "PIPELINE_TIMEOUT",
        projectId: project._id,
        actionUrl: `/projects/${project._id}`,
        metadata: { projectName: `${project.repoOwner}/${project.repoName}` },
      });
      return;
    }

    // Real error — mark as failed
    console.error(`[pipeline:${jobId}] Fatal error:`, err);
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    ActivityLogService.log({
      userId: project.userId,
      action: "PIPELINE_FAILED",
      projectId: project._id,
      projectName: `${project.repoOwner}/${project.repoName}`,
      metadata: { jobId, error: err.message },
    });
    NotificationService.create({
      userId: project.userId,
      type: "PIPELINE_FAILED",
      projectId: project._id,
      actionUrl: `/projects/${project._id}`,
      metadata: { projectName: `${project.repoOwner}/${project.repoName}`, reason: err.message },
    });
    failJob(jobId, err);
  }
}

/**
 * Run the incremental sync pipeline.
 * Called by syncProject.
 * Handles three outcomes: skipped, full run fallback, incremental success.
 */
async function runSync({ project, jobId, forceFullRun, webhookChangedFiles }) {
  const incrementalSync = await getIncrementalSync();
  const onProgress = makeProgressHandler(project._id, jobId);

  // Decrypt the provider token if it exists
  let providerTokenDecrypted = null;
  if (project.providerToken) {
    const { decrypt } = await import("../../../utils/crypto.util.js");
    try {
      providerTokenDecrypted = decrypt(project.providerToken);
    } catch (err) {
      console.warn("[runSync] Failed to decrypt provider token:", err.message);
    }
  }

  console.log(
    `[sync:${jobId}] 🚀 runSync async execution starting immediately · job should be in memory now`,
  );

  try {
    console.log(
      `[sync:${jobId}] Starting incremental sync for ${project.repoUrl} · forceFullRun=${forceFullRun} · webhookFiles=${webhookChangedFiles?.length || 0}`,
    );

    const syncResult = await incrementalSync(project, onProgress, {
      forceFullRun,
      webhookChangedFiles,
      provider: project.provider,
      token: providerTokenDecrypted,
    });

    console.log(`[sync:${jobId}] Sync result: `, {
      success: syncResult.success,
      skipped: syncResult.skipped,
      isFullRun: syncResult.isFullRun,
      error: syncResult.error,
    });

    // ── Outcome: sync failed ──────────────────────────────────
    if (!syncResult.success) {
      const errorMsg = syncResult.error || "Sync failed";
      console.error(`[sync:${jobId}] Sync failed: ${errorMsg}`);
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: errorMsg,
      });
      failJob(jobId, new Error(errorMsg));
      return;
    }

    // ── Outcome: skipped (no changes / already up-to-date) ────
    if (syncResult.skipped) {
      console.log(
        `[sync:${jobId}] Sync skipped (${syncResult.reason}), marking done`,
      );
      await Project.findByIdAndUpdate(project._id, {
        status: "done",
        lastDocumentedCommit: syncResult.currentCommit,
        "stats.lastChecked": new Date(),
      });
      finishJob(jobId, {
        success: true,
        skipped: true,
        reason: syncResult.reason,
      });
      return;
    }

    // ── Outcome: full run fallback ────────────────────────────
    if (syncResult.isFullRun) {
      console.log(
        `[sync:${jobId}] Fell back to full run — applying full pipeline result`,
      );
      const result = syncResult._fullResult;

      if (!result?.success) {
        const errorMsg = result?.error || "Full sync failed";
        console.error(`[sync:${jobId}] Full sync failed: ${errorMsg}`);
        await Project.findByIdAndUpdate(project._id, {
          status: "error",
          errorMessage: errorMsg,
        });
        failJob(jobId, new Error(errorMsg));
        return;
      }

      const update = buildFullRunUpdate(
        result,
        syncResult.currentCommit || result.lastDocumentedCommit,
        syncResult._freshTree,
      );

      await Project.findByIdAndUpdate(project._id, { $set: update });

      // Create version history for all sections (parallel)
      await createInitialVersions(
        project._id,
        result.output,
        syncResult.currentCommit,
      );

      finishJob(jobId, {
        success: true,
        isFullRun: true,
        stats: result.stats,
        security: result.security,
        agentErrors: result.agentErrors || syncResult.errors,
      });
      return;
    }

    // ── Outcome: incremental success ──────────────────────────
    // The incremental sync returns a pre-built _update object ready
    // for direct MongoDB application.

    const { _update, ...syncMeta } = syncResult;

    if (!_update) {
      // Shouldn't happen — guard against malformed sync result
      const errorMsg = "Sync returned no update payload";
      console.error(`[sync:${jobId}] ${errorMsg}`);
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: errorMsg,
      });
      failJob(jobId, new Error(errorMsg));
      return;
    }

    console.log(
      `[sync:${jobId}] Incremental sync successful · ${syncResult.sectionsRegenerated?.length || 0} sections updated`,
    );

    await Project.findByIdAndUpdate(project._id, {
      $set: {
        ..._update,
        status: "done",
        search_language: "english",
        // Carry forward non-mutated fields from original result
        techStack: project.techStack || _update.techStack || [],
        testFrameworks: project.testFrameworks || [],
        architectureHint:
          project.architectureHint || _update.architectureHint || "",
      },
    });

    // Log non-fatal errors
    if (syncResult.errors?.length) {
      console.warn(
        `[sync:${jobId}] ${syncResult.errors.length} non-fatal error(s):`,
        syncResult.errors
          .map((e) => `${e.agent ?? e.phase}: ${e.error}`)
          .join("; "),
      );
    }

    finishJob(jobId, {
      success: true,
      isFullRun: false,
      sectionsRegenerated: syncMeta.sectionsRegenerated,
      sectionsSkipped: syncMeta.sectionsSkipped,
      agentsRun: syncMeta.agentsRun,
      changedFileCount: syncMeta.changedFileCount,
      removedFileCount: syncMeta.removedFileCount,
      totalDuration: syncMeta.totalDuration,
      errors: syncResult.errors,
    });
  } catch (err) {
    console.error(`[sync:${jobId}] Fatal error:`, err);
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}

/**
 * Run the full pipeline for a ZIP-uploaded project.
 * Normalizes extracted files similar to Git projects and runs orchestrator.
 * Called by ZIP upload controller.
 */
export async function runZipPipeline({ project, jobId }) {
  const orchestrate = await getOrchestrate();
  const onProgress = makeProgressHandler(project._id, jobId);

  console.log(
    `[zip-pipeline:${jobId}] 🚀 Starting ZIP pipeline for ${project.repoUrl}`,
  );

  try {
    // Extract files from project zipMetadata
    const { extractedFiles = [] } = project.zipMetadata || {};

    if (!extractedFiles.length) {
      throw new Error("No extracted files found in ZIP metadata");
    }

    console.log(
      `[zip-pipeline:${jobId}] Processing ${extractedFiles.length} extracted files`,
    );

    // Normalize ZIP files into the same format as Git providers
    const normalised = {
      owner: project.repoOwner || "local",
      repo: project.repoName || "zip-project",
      branch: "main",
      commits: [],
      files: extractedFiles.map((f) => ({
        path: f.path,
        type: "blob",
        lastModified: project.zipMetadata.uploadedAt,
      })),
      fileTree: buildFileTree(extractedFiles),
      fileManifest: extractedFiles.reduce((acc, f) => {
        acc[f.path] = {
          path: f.path,
          size: f.content.length,
          modified: project.zipMetadata.uploadedAt,
          hash: createHash("sha256").update(f.content).digest("hex"),
        };
        return acc;
      }, {}),
      lastCommitSha: randomBytes(16).toString("hex"),
      lastCommitDate: new Date(),
      lastDocumentedCommit: null,
      description: project.meta?.description || "",
      language: project.meta?.language || "unknown",
      topics: project.meta?.topics || [],
      isArchived: false,
      isFork: false,
      README:
        extractedFiles.find((f) => /^README/i.test(f.path))?.content || "",
    };

    console.log(
      `[zip-pipeline:${jobId}] Normalised ZIP project: ${extractedFiles.length} files, languages: ${normalised.language}`,
    );

    // Run the full orchestrator pipeline
    const result = await orchestrate(normalised, onProgress);

    if (!result.success) {
      await Project.findByIdAndUpdate(project._id, {
        status: "error",
        errorMessage: result.error || "Unknown pipeline error",
      });
      failJob(jobId, new Error(result.error || "Unknown pipeline error"));
      return;
    }

    console.log(`[zip-pipeline:${jobId}] Pipeline completed successfully`);

    // Build and persist the full update
    const update = buildFullRunUpdate(result, normalised.lastCommitSha, null);
    await Project.findByIdAndUpdate(project._id, { $set: update });

    // Create version history for all generated sections (parallel)
    await createInitialVersions(
      project._id,
      result.output,
      normalised.lastCommitSha,
    );

    // Log non-fatal agent errors
    if (result.agentErrors?.length) {
      console.warn(
        `[zip-pipeline:${jobId}] ${result.agentErrors.length} non-fatal agent error(s):`,
        result.agentErrors.map((e) => `${e.agent}: ${e.error}`).join("; "),
      );
    }

    finishJob(jobId, {
      success: true,
      stats: result.stats,
      security: result.security,
      agentErrors: result.agentErrors,
      routing: result.routing,
    });

    console.log(
      `[zip-pipeline:${jobId}] ✅ ZIP pipeline successfully completed`,
    );
  } catch (err) {
    console.error(`[zip-pipeline:${jobId}] Fatal error:`, err.message);
    await Project.findByIdAndUpdate(project._id, {
      status: "error",
      errorMessage: err.message,
    });
    failJob(jobId, err);
  }
}

/**
 * Build a tree structure from extracted files for manifests.
 */
function buildFileTree(files) {
  const tree = {};
  for (const file of files) {
    const parts = file.path.split("/");
    let current = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = { type: "blob" };
      } else {
        current[part] = current[part] || { type: "tree" };
        current = current[part];
      }
    }
  }
  return tree;
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM TABS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new custom tab for a project.
 * Requires editor or owner access.
 */
export async function createCustomTab({
  projectId,
  userId,
  name,
  description,
  content = "",
}) {
  const project = await assertAccess(projectId, userId, "editor");

  // Validate tab name — must be unique per project
  if (!name || name.trim().length === 0) {
    throw domainError("Tab name cannot be empty", "VALIDATION_ERROR", 422);
  }

  const trimmedName = name.trim();

  // Check for duplicates (case-insensitive)
  const isDuplicate = project.customTabs?.some(
    (t) => t.name.toLowerCase() === trimmedName.toLowerCase(),
  );

  if (isDuplicate) {
    throw domainError(
      `A tab named "${trimmedName}" already exists`,
      "DUPLICATE_TAB",
      409,
    );
  }

  // Calculate order (add to end)
  const maxOrder =
    project.customTabs?.length > 0
      ? Math.max(...project.customTabs.map((t) => t.order))
      : 0;

  const newTab = {
    name: trimmedName,
    description: description?.trim() || "",
    content: content?.trim() || "",
    order: (maxOrder || 0) + 1,
    isNative: false,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const updated = await Project.findByIdAndUpdate(
    projectId,
    { $push: { customTabs: newTab } },
    { new: true },
  );

  return getProjectById({ projectId, userId });
}

/**
 * Update a custom tab's name, description, or content.
 * Requires editor or owner access.
 * Cannot update "Other Docs" (reserved tab).
 */
export async function updateCustomTab({
  projectId,
  userId,
  tabId,
  name,
  description,
  content,
}) {
  const project = await assertAccess(projectId, userId, "editor");

  const tab = project.customTabs?.find(
    (t) => t._id?.toString() === tabId?.toString(),
  );

  if (!tab) {
    throw domainError("Tab not found", "TAB_NOT_FOUND", 404);
  }

  // Build update object
  const updates = { updatedAt: new Date() };

  // Validate and update name
  if (name !== undefined && name !== null) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw domainError("Tab name cannot be empty", "VALIDATION_ERROR", 422);
    }

    // Check for duplicate names (excluding this tab)
    const isDuplicate = project.customTabs?.some(
      (t) =>
        t._id?.toString() !== tabId?.toString() &&
        t.name.toLowerCase() === trimmedName.toLowerCase(),
    );

    if (isDuplicate) {
      throw domainError(
        `A tab named "${trimmedName}" already exists`,
        "DUPLICATE_TAB",
        409,
      );
    }

    updates.name = trimmedName;
  }

  // Update description
  if (description !== undefined) {
    updates.description = description?.trim() || "";
  }

  // Update content (with versioning)
  if (content !== undefined) {
    const oldContent = tab.content;
    updates.content = content?.trim() || "";

    // Create version snapshot if content changed
    if (oldContent !== updates.content) {
      const snapshotSource = project.editedCustomTabs?.some(
        (e) => e.tabId?.toString() === tabId?.toString(),
      )
        ? "user"
        : "ai_full";

      if (oldContent) {
        await DocumentVersion.createVersion({
          projectId: project._id,
          section: `custom_${tab.name.toLowerCase().replace(/\s+/g, "_")}`,
          content: oldContent,
          source: snapshotSource,
          meta: { changeSummary: "Snapshot before content edit" },
        }).catch((err) =>
          console.warn("[versions] Custom tab snapshot failed:", err.message),
        );
      }

      // Record new version
      await DocumentVersion.createVersion({
        projectId: project._id,
        section: `custom_${tab.name.toLowerCase().replace(/\s+/g, "_")}`,
        content: updates.content,
        source: "user",
        meta: { changeSummary: "Custom tab edit" },
      }).catch((err) =>
        console.warn("[versions] Custom tab version save failed:", err.message),
      );

      // Mark as edited
      let editedCustomTabs = (project.editedCustomTabs || []).filter(
        (e) => e.tabId?.toString() !== tabId?.toString(),
      );
      editedCustomTabs.push({
        tabId,
        editedAt: new Date(),
        stale: false,
      });
      await Project.findByIdAndUpdate(projectId, { editedCustomTabs });
    }
  }

  // Apply updates to the specific tab
  await Project.updateOne(
    { _id: projectId, "customTabs._id": tabId },
    {
      $set: {
        "customTabs.$": { ...(tab.toObject?.() || tab), ...updates },
      },
    },
  );

  return getProjectById({ projectId, userId });
}

/**
 * Delete a custom tab.
 * Requires owner access (stricter than editor).
 * Cannot delete "Other Docs" (reserved tab).
 */
export async function deleteCustomTab({ projectId, userId, tabId }) {
  const project = await assertAccess(projectId, userId, "owner");

  const tab = project.customTabs?.find(
    (t) => t._id?.toString() === tabId?.toString(),
  );

  if (!tab) {
    throw domainError("Tab not found", "TAB_NOT_FOUND", 404);
  }

  // Remove the tab
  await Project.findByIdAndUpdate(projectId, {
    $pull: { customTabs: { _id: tabId } },
  });

  // Remove related edited tracking
  await Project.findByIdAndUpdate(projectId, {
    $pull: { editedCustomTabs: { tabId } },
  });

  // Delete version history for this tab
  await DocumentVersion.deleteMany({
    projectId,
    section: `custom_${tab.name.toLowerCase().replace(/\s+/g, "_")}`,
  }).catch((err) =>
    console.warn(
      "[versions] Failed to delete custom tab versions:",
      err.message,
    ),
  );

  return getProjectById({ projectId, userId });
}

/**
 * List all custom tabs for a project.
 * Sorted by order for consistent UI display.
 */
export async function listCustomTabs({ projectId, userId }) {
  const project = await assertAccess(projectId, userId, "viewer");

  const tabs = project.customTabs?.sort((a, b) => a.order - b.order) || [];

  return { tabs };
}

/**
 * Reorder custom tabs (bulk update).
 * Requires editor or owner access.
 * Input: array of { tabId, order }
 */
export async function reorderCustomTabs({ projectId, userId, orders }) {
  const project = await assertAccess(projectId, userId, "editor");

  if (!Array.isArray(orders)) {
    throw domainError("orders must be an array", "VALIDATION_ERROR", 422);
  }

  // Update each tab's order
  for (const { tabId, order } of orders) {
    await Project.updateOne(
      { _id: projectId, "customTabs._id": tabId },
      { $set: { "customTabs.$.order": order } },
    );
  }

  return getProjectById({ projectId, userId });
}
