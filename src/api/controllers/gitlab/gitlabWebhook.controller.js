// =============================================================
// GitLab Webhook Controller
//
// Handles push events sent by GitLab when code is pushed.
// Mirrors the GitHub webhook flow in webhook.service.js with two
// key differences:
//
//   1. Auth: GitLab sends a plain X-Gitlab-Token header (no HMAC).
//      We compare it against the project's webhookSecret.
//
//   2. Payload shape: GitLab push events have a different structure
//      than GitHub : we normalise it to the same internal shape
//      before passing to syncProject.
//
// GitLab push event reference:
//   https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#push-events
// =============================================================

import { validateWebhookToken } from "../../services/gitlab.service.js";

const CODE_FILE =
  /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|cpp|c|h|vue|svelte|prisma|graphql|sql|kt|swift|dart)$/i;

const MANIFEST_FILE =
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile|go\.mod|go\.sum|Cargo\.toml|pom\.xml|build\.gradle|composer\.json|Gemfile)$/i;

// ── Payload analysis ─────────────────────────────────────────

/**
 * Analyse a GitLab push payload to decide whether a re-doc sync is needed.
 * Returns the same shape as webhook.service.js → shouldReDocument().
 */
function shouldReDocument(payload) {
  const { ref, project: repo, commits = [], after, object_kind } = payload;

  if (object_kind && object_kind !== "push") {
    return { should: false, reason: "not_push_event" };
  }

  const defaultBranch = repo?.default_branch || "main";
  if (!ref || !ref.endsWith(`/${defaultBranch}`)) {
    return { should: false, reason: "not_default_branch", ref, defaultBranch };
  }

  // All-zero SHA means branch was deleted
  if (after === "0000000000000000000000000000000000000000") {
    return { should: false, reason: "branch_deleted" };
  }

  if (!commits.length) {
    return { should: false, reason: "no_commits" };
  }

  // Deduplicate across commits
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

// ── Project lookup ────────────────────────────────────────────

/**
 * Find a project and validate the webhook token against its secret.
 * GitLab sends plain X-Gitlab-Token (not HMAC), matched against
 * the project's webhookSecret stored in MongoDB.
 */
async function findProjectForWebhook({ repoFullName, incomingToken }) {
  const { Project } = await import("../../models/Project.js");

  // GitLab path_with_namespace is "owner/repo"
  const [owner, ...rest] = repoFullName.split("/");
  const repoName = rest.join("/"); // handles subgroups

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

// ── Main handler ──────────────────────────────────────────────

export async function handleGitLabWebhook({ payload, token }) {
  let parsed;
  try {
    parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (Buffer.isBuffer(parsed)) parsed = JSON.parse(parsed.toString("utf8"));
  } catch (err) {
    return { status: 400, body: { error: `Invalid JSON: ${err.message}` } };
  }

  // Identify the repo from the payload
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

  // Ping / system hook
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

// ── Express handler ───────────────────────────────────────────

export async function gitlabWebhookHandler(req, res) {
  const token = req.headers["x-gitlab-token"];

  // Body arrives as raw Buffer (middleware set in app.js)
  const raw   = Buffer.isBuffer(req.body)
    ? req.body.toString("utf8")
    : JSON.stringify(req.body);

  const result = await handleGitLabWebhook({ payload: raw, token });
  res.status(result.status).json(result.body);
}