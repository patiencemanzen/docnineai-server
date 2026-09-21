
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



const ALL_OUTPUT_SECTIONS = [
  "readme",
  "internalDocs",
  "apiReference",
  "schemaDocs",
  "componentRef",
  "componentIndex",
  "securityReport",
  "remediationReport",
];



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




function parseRepoUrl(raw) {
  const provider = detectProvider(raw);
  try {
    const parsed = adapterParseRepoUrl(provider, raw);


    let repoName, owner;
    if (provider === "azure") {
      owner = parsed.owner;
      repoName = parsed.repo;

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


function domainError(msg, code, status = 400) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}


async function assertOwnership(projectId, userId) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project)
    throw domainError("Project not found.", "PROJECT_NOT_FOUND", 404);
  return project;
}


async function assertAccess(projectId, userId, requiredRole = "viewer") {

  const ownedProject = await Project.findOne({ _id: projectId, userId });
  if (ownedProject) {
    ownedProject._shareRole = "owner";
    return ownedProject;
  }


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


function makeProgressHandler(projectId, jobId) {
  let lastCheckpointTime = Date.now();

  return async (event) => {

    pushEvent(jobId, event);


    if (
      event.status === "done" ||
      event.status === "error" ||
      event.status === "running"
    ) {
      lastCheckpointTime = Date.now();
    }


    try {
      await Project.updateOne(
        { _id: projectId },
        {
          $push: {
            events: { $each: [event], $slice: -200 },
          },

          "meta.lastProgressAt": new Date(),
          "meta.lastProgressStep": event.step,
        },
      );
    } catch {
      
    }
  };
}


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

      console.warn(
        `[versions] Failed to create version for ${section}:`,
        err.message,
      );
    }
  });
  await Promise.all(promises);
}


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

    "agentOutputs.summaries": result.agentOutputs?.summaries || {},
    routing: result.routing || null,
    pipelineReport: result.pipelineReport?.markdown || null,
    agentErrors: result.agentErrors || [],
    search_language: "english",
  };
}




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





export async function createProject({ userId, repoUrl }) {
  try {

    const { owner, repoName, normalised, provider } = parseRepoUrl(repoUrl);

    console.log("[createProject] Parsed repo URL", {
      provider,
      owner,
      repoName,
      repoUrl: normalised,
    });


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

      const { encrypt, decrypt } =
        await import("../../../utils/crypto.util.js");
      providerToken = encrypt(decrypt(user.gitlabTokenEncrypted));
      console.log("[createProject] GitLab token prepared for project");
    }


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

      const { encrypt, decrypt } =
        await import("../../../utils/crypto.util.js");
      providerToken = encrypt(decrypt(user.azureDevOpsTokenEncrypted));
      console.log("[createProject] Azure DevOps token prepared for project");
    }


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


    if (provider === "github") {
      const { GitHubToken } =
        await import("../../../models/GitHubToken.js");
      const githubToken = await GitHubToken.findOne({ userId }).select(
        "+accessTokenEncrypted",
      );
      if (githubToken?.accessTokenEncrypted) {

        const { encrypt, decrypt } =
          await import("../../../utils/crypto.util.js");
        providerToken = encrypt(decrypt(githubToken.accessTokenEncrypted));
        console.log("[createProject] GitHub token prepared for project");
      } else {
        console.warn("[createProject] GitHub token not found for user", {
          userId,
        });

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


export async function createFromScratchProject({ userId, projectName }) {
  if (!projectName || projectName.trim().length === 0) {
    throw domainError("Project name is required.", "INVALID_PROJECT_NAME", 400);
  }


  const cleanName = projectName.trim().replace(/\s+/g, "-").toLowerCase();


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
    repoUrl: `manual://${cleanName}`,
    repoOwner: "manual",
    repoName: cleanName,
    provider: "github",
    sourceType: "manual",
    status: "done",
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


export async function getProjectById({ projectId, userId }) {
  return assertAccess(projectId, userId, "viewer");
}


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





export async function syncProject({
  projectId,
  userId,
  forceFullRun = false,
  webhookChangedFiles = null,
}) {

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


  runSync({ project, jobId, forceFullRun, webhookChangedFiles }).catch((err) =>
    console.error(`❌ Sync crash [${jobId}]:`, err.message),
  );

  return {
    project,
    streamUrl: `/projects/${project._id}/stream`,
  };
}




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


  const editedSections = (project.editedSections || []).filter(
    (s) => s.section !== section,
  );
  editedSections.push({ section, editedAt: new Date(), stale: false });

  await Project.findByIdAndUpdate(project._id, {
    [`editedOutput.${section}`]: content,
    editedSections,
  });


  await DocumentVersion.createVersion({
    projectId: project._id,
    section,
    content,
    source: "user",
    meta: { changeSummary: "User edit" },
  }).catch((err) =>
    console.warn("[versions] Version save failed:", err.message),
  );


  try {
    const { logSectionEdit } =
      await import("../../../services/changelog.service.js");
    await logSectionEdit(projectId, userId, section, currentContent, content);
  } catch (err) {
    console.warn("[changelog] Failed to log section edit:", err.message);
  }

  return getProjectById({ projectId, userId });
}


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


export async function acceptAISection({ projectId, userId, section }) {
  if (!SECTIONS.includes(section))
    throw domainError(
      `Invalid section. Must be one of: ${SECTIONS.join(", ")}`,
      "INVALID_SECTION",
      400,
    );


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


  try {
    const { logSectionAccept } =
      await import("../../../services/changelog.service.js");
    await logSectionAccept(projectId, userId, section);
  } catch (err) {
    console.warn("[changelog] Failed to log section accept:", err.message);
  }

  return revertDocSection({ projectId, userId, section });
}




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


export async function getVersion({ projectId, userId, versionId }) {
  await assertAccess(projectId, userId, "viewer");

  const version = await DocumentVersion.findOne({ _id: versionId, projectId });
  if (!version)
    throw domainError("Version not found.", "VERSION_NOT_FOUND", 404);

  return version;
}


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





async function runPipeline({ project, normalised, jobId }) {
  const orchestrate = await getOrchestrate();
  const onProgress = makeProgressHandler(project._id, jobId);
  const isVercel =
    !!process.env.VERCEL && process.env.NODE_ENV === "production";


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


    let result;
    if (isVercel) {
      result = await Promise.race([
        orchestrate(normalised, onProgress, {
          provider: project.provider,
          token: providerTokenDecrypted,
        }),
        new Promise(
          (_, reject) =>
            setTimeout(() => reject(new Error("VERCEL_HTTP_TIMEOUT")), 55_000),
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


    const update = buildFullRunUpdate(
      result,
      result.lastDocumentedCommit,
      null,
    );
    await Project.findByIdAndUpdate(project._id, { $set: update });


    await createInitialVersions(
      project._id,
      result.output,
      result.lastDocumentedCommit,
    );


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

    if (err.message === "VERCEL_HTTP_TIMEOUT") {
      console.warn(`[pipeline:${jobId}] Vercel 55s timeout : marking project as error (retryable).`);
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


async function runSync({ project, jobId, forceFullRun, webhookChangedFiles }) {
  const incrementalSync = await getIncrementalSync();
  const onProgress = makeProgressHandler(project._id, jobId);


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


    if (syncResult.isFullRun) {
      console.log(
        `[sync:${jobId}] Fell back to full run : applying full pipeline result`,
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



    const { _update, ...syncMeta } = syncResult;

    if (!_update) {

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

        techStack: project.techStack || _update.techStack || [],
        testFrameworks: project.testFrameworks || [],
        architectureHint:
          project.architectureHint || _update.architectureHint || "",
      },
    });


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


export async function runZipPipeline({ project, jobId }) {
  const orchestrate = await getOrchestrate();
  const onProgress = makeProgressHandler(project._id, jobId);

  console.log(
    `[zip-pipeline:${jobId}] 🚀 Starting ZIP pipeline for ${project.repoUrl}`,
  );

  try {

    const { extractedFiles = [] } = project.zipMetadata || {};

    if (!extractedFiles.length) {
      throw new Error("No extracted files found in ZIP metadata");
    }

    console.log(
      `[zip-pipeline:${jobId}] Processing ${extractedFiles.length} extracted files`,
    );


    const normalised = {
      owner: project.repoOwner || "local",
      repo: project.repoName || "zip-project",
      meta: {
        name: project.meta?.name || project.repoName || "zip-project",
        description: project.meta?.description || `Uploaded ZIP project (${extractedFiles.length} files)`,
        language: project.meta?.language || "unknown",
        defaultBranch: "main",
        stars: 0,
        topics: project.meta?.topics || [],
        createdAt: project.zipMetadata?.uploadedAt || new Date(),
        updatedAt: project.zipMetadata?.uploadedAt || new Date(),
      },
      branch: "main",
      commits: [],
      files: extractedFiles,
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


    const update = buildFullRunUpdate(result, normalised.lastCommitSha, null);
    await Project.findByIdAndUpdate(project._id, { $set: update });


    await createInitialVersions(
      project._id,
      result.output,
      normalised.lastCommitSha,
    );


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




export async function createCustomTab({
  projectId,
  userId,
  name,
  description,
  content = "",
}) {
  const project = await assertAccess(projectId, userId, "editor");


  if (!name || name.trim().length === 0) {
    throw domainError("Tab name cannot be empty", "VALIDATION_ERROR", 422);
  }

  const trimmedName = name.trim();


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


  const updates = { updatedAt: new Date() };


  if (name !== undefined && name !== null) {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw domainError("Tab name cannot be empty", "VALIDATION_ERROR", 422);
    }


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


  if (description !== undefined) {
    updates.description = description?.trim() || "";
  }


  if (content !== undefined) {
    const oldContent = tab.content;
    updates.content = content?.trim() || "";


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


      await DocumentVersion.createVersion({
        projectId: project._id,
        section: `custom_${tab.name.toLowerCase().replace(/\s+/g, "_")}`,
        content: updates.content,
        source: "user",
        meta: { changeSummary: "Custom tab edit" },
      }).catch((err) =>
        console.warn("[versions] Custom tab version save failed:", err.message),
      );


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


export async function deleteCustomTab({ projectId, userId, tabId }) {
  const project = await assertAccess(projectId, userId, "owner");

  const tab = project.customTabs?.find(
    (t) => t._id?.toString() === tabId?.toString(),
  );

  if (!tab) {
    throw domainError("Tab not found", "TAB_NOT_FOUND", 404);
  }


  await Project.findByIdAndUpdate(projectId, {
    $pull: { customTabs: { _id: tabId } },
  });


  await Project.findByIdAndUpdate(projectId, {
    $pull: { editedCustomTabs: { tabId } },
  });


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


export async function listCustomTabs({ projectId, userId }) {
  const project = await assertAccess(projectId, userId, "viewer");

  const tabs = project.customTabs?.sort((a, b) => a.order - b.order) || [];

  return { tabs };
}


export async function reorderCustomTabs({ projectId, userId, orders }) {
  const project = await assertAccess(projectId, userId, "editor");

  if (!Array.isArray(orders)) {
    throw domainError("orders must be an array", "VALIDATION_ERROR", 422);
  }


  for (const { tabId, order } of orders) {
    await Project.updateOne(
      { _id: projectId, "customTabs._id": tabId },
      { $set: { "customTabs.$.order": order } },
    );
  }

  return getProjectById({ projectId, userId });
}
