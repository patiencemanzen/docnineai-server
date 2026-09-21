
import { validateWebhookToken } from "../../services/gitlab.service.js";

const CODE_FILE =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql|kt|swift|dart)$/i;

const MANIFEST_FILE =
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile|go\.mod|go\.sum|Cargo\.toml|pom\.xml|build\.gradle|composer\.json|Gemfile)$/i;




function shouldReDocument(payload) {
  const { ref, project: repo, commits = [], after, object_kind } = payload;

  if (object_kind && object_kind !== "push") {
    return { should: false, reason: "not_push_event" };
  }

  const defaultBranch = repo?.default_branch || "main";
  if (!ref || !ref.endsWith(`/${defaultBranch}`)) {
    return { should: false, reason: "not_default_branch", ref, defaultBranch };
  }


  if (after === "0000000000000000000000000000000000000000") {
    return { should: false, reason: "branch_deleted" };
  }

  if (!commits.length) {
    return { should: false, reason: "no_commits" };
  }


  const pathMap = new Map();
  for (const commit of commits) {
    for (const p of commit.added    || []) pathMap.set(p, { path: p, status: "added"    });
    for (const p of commit.modified || []) pathMap.set(p, { path: p, status: "modified" });
    for (const p of commit.removed  || []) pathMap.set(p, { path: p, status: "removed"  });
  }

  const changedFiles = [...pathMap.values()];
  const codeFiles    = changedFiles.filter((f) => CODE_FILE.test(f.path));

  if (!codeFiles.length) {
    return { should: false, reason: "no_code_changes", totalChanged: changedFiles.length };
  }

  const needsFullRun = changedFiles.some((f) => MANIFEST_FILE.test(f.path.split("/").pop()));

  return {
    should:        true,
    reason:        "code_changed",
    changedFiles,
    codeFiles,
    needsFullRun,
    repoUrl:       repo?.web_url || repo?.git_http_url,
    repoFullName:  repo?.path_with_namespace,
    pusher:        payload.user_name || payload.user_username,
    branch:        defaultBranch,
    headCommit:    after,
    commitCount:   commits.length,
  };
}




async function findProjectForWebhook({ repoFullName, incomingToken }) {
  const { Project } = await import("../../models/Project.js");


  const [owner, ...rest] = repoFullName.split("/");
  const repoName = rest.join("/");

  const ownerRx = new RegExp(`^${owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const repoRx  = new RegExp(`^${repoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

  const candidates = await Project.find({
    repoOwner: ownerRx,
    repoName:  repoRx,
    provider:  "gitlab",
    status:    { $ne: "archived" },
  })
    .select("_id userId repoUrl repoOwner repoName status webhookSecret webhookEnabled updatedAt")
    .sort({ updatedAt: -1 })
    .lean(false);

  if (!candidates.length) return { kind: "no_project" };

  for (const project of candidates) {
    if (!project.webhookSecret) continue;
    const valid = validateWebhookToken(incomingToken, project.webhookSecret);
    if (!valid) continue;
    return { kind: "match", project };
  }

  return { kind: "invalid_token" };
}



export async function handleGitLabWebhook({ payload, token }) {
  let parsed;
  try {
    parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (Buffer.isBuffer(parsed)) parsed = JSON.parse(parsed.toString("utf8"));
  } catch (err) {
    return { status: 400, body: { error: `Invalid JSON: ${err.message}` } };
  }


  const repoFullName =
    parsed?.project?.path_with_namespace ||
    parsed?.repository?.full_path;

  if (!repoFullName) {
    return {
      status: 400,
      body: { error: "Cannot determine repository identity from GitLab payload." },
    };
  }

  const match = await findProjectForWebhook({ repoFullName, incomingToken: token });

  if (match.kind === "no_project") {
    console.log(`[gitlab-webhook] No project for ${repoFullName}`);
    return {
      status: 200,
      body: { message: "No project registered for this repository.", repoFullName },
    };
  }

  if (match.kind === "invalid_token") {
    console.warn(`[gitlab-webhook] Token validation failed for ${repoFullName}`);
    return { status: 401, body: { error: "Invalid webhook token" } };
  }

  const { project } = match;


  if (parsed.object_kind === "system" || parsed.event_name === "project_hooks") {
    return { status: 200, body: { message: "Pong! GitLab webhook configured correctly." } };
  }

  const check = shouldReDocument(parsed);
  if (!check.should) {
    console.log(`[gitlab-webhook] Skipped for ${project._id}: ${check.reason}`);
    return { status: 200, body: { message: `Skipped: ${check.reason}`, detail: check } };
  }

  if (project.status === "running" || project.status === "queued") {
    return { status: 202, body: { message: "Pipeline already running", projectId: project._id } };
  }
  if (project.status === "archived") {
    return { status: 202, body: { message: "Project is archived",      projectId: project._id } };
  }
  if (project.status !== "done" && project.status !== "error") {
    return {
      status: 202,
      body: { message: "Project must be done or error to sync", status: project.status },
    };
  }

  const { syncProject } = await import("../projects/project.service.js");

  try {
    const result = await syncProject({
      projectId:           project._id.toString(),
      userId:              project.userId.toString(),
      forceFullRun:        check.needsFullRun,
      webhookChangedFiles: check.changedFiles,
    });

    return {
      status: 202,
      body: {
        message:      "Sync triggered",
        projectId:    project._id,
        jobId:        result.project?.jobId,
        repoFullName,
        branch:       check.branch,
        headCommit:   check.headCommit?.slice(0, 8),
        codeFiles:    check.codeFiles.length,
        needsFullRun: check.needsFullRun,
      },
    };
  } catch (err) {
    console.error(`[gitlab-webhook] Sync failed for ${project._id}: ${err.message}`);
    return {
      status: 500,
      body: { error: `Failed to trigger sync: ${err.message}`, code: err.code },
    };
  }
}



export async function gitlabWebhookHandler(req, res) {
  const token = req.headers["x-gitlab-token"];


  const raw   = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : JSON.stringify(req.body);

  const result = await handleGitLabWebhook({ payload: raw, token });
  res.status(result.status).json(result.body);
}