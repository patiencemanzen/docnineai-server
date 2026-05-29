// =============================================================
// GitLab API client — mirrors github.service.js interface exactly.
//
// Every exported function has the same name and return shape as
// its GitHub counterpart so provider.adapter.js can swap them
// transparently without touching the orchestrator or sync pipeline.
//
// Key difference from GitHub: GitLab uses per-user OAuth access tokens
// passed in as `accessToken` at call time, not a server-level env var.
// The token is stored encrypted on the Project document.
//
// GitLab REST API v4: https://docs.gitlab.com/ee/api/rest/
// =============================================================

import axios from "axios";
import crypto from "crypto";

const GL_API = "https://gitlab.com/api/v4";
const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;

// ── Relevance-based file selection (mirrors github.service.js) ────

const HIGH_PRIORITY = [
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|go\.mod|pom\.xml|build\.gradle|Cargo\.toml|pyproject\.toml|setup\.py|composer\.json)$/i,
  /^(dockerfile|docker-compose\.ya?ml|\.env\.example|\.gitignore|readme\.md)$/i,
  /\/(index|main|app|server|entry)\.[jt]sx?$/i,
];
const SOURCE_PRIORITY = [
  /\/(route[s]?|controller[s]?|handler[s]?|endpoint[s]?)\//i,
  /\/(model[s]?|schema[s]?|entit(?:y|ies))\//i,
  /\/(service[s]?|middleware[s]?|util[s]?|helper[s]?|hook[s]?|provider[s]?)\//i,
  /\.(route|controller|service|model|schema)\.[jt]sx?$/i,
];
const LOW_PRIORITY = [
  /\/(test[s]?|spec[s]?|__tests?__|__mocks?__|fixture[s]?)\//i,
  /\.(test|spec)\.[jt]sx?$/i,
  /\/(dist|build|out|\.next|\.nuxt|coverage|generated)\//i,
  /\/(node_modules|vendor|\.git)\//i,
];

function scoreFilePath(path) {
  for (const re of LOW_PRIORITY) if (re.test(path)) return -1;
  for (const re of HIGH_PRIORITY) if (re.test(path)) return 10;
  for (const re of SOURCE_PRIORITY) if (re.test(path)) return 5;
  return 1;
}

function selectRelevantFiles(files, cap) {
  return files
    .map((f) => ({ f, score: scoreFilePath(f.path) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map(({ f }) => f);
}

// ── Internal helpers ──────────────────────────────────────────

function glHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
}

/** GitLab requires "owner%2Frepo" encoding in project API paths */
function encodePath(owner, repo) {
  return encodeURIComponent(`${owner}/${repo}`);
}

// ── URL parsing ───────────────────────────────────────────────

/**
 * Parse a GitLab repo URL into { owner, repo }.
 * Accepts HTTPS, SSH, and shorthand (owner/repo) formats.
 */
export function parseRepoUrl(url) {
  const s = String(url || "")
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const ssh = s.match(/git@gitlab\.com:([^/]+)\/([^/]+)/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const https = s.match(/gitlab\.com\/([^/]+)\/([^/?#]+)/);
  if (https) return { owner: https[1], repo: https[2] };

  const short = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (short) return { owner: short[1], repo: short[2] };

  const err = new Error(`Invalid GitLab URL: ${url}`);
  err.code = "INVALID_REPO_URL";
  err.status = 400;
  throw err;
}

// ── OAuth ─────────────────────────────────────────────────────

/** Build the GitLab OAuth authorisation URL. Scopes: read_api + read_repository. */
export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GITLAB_CLIENT_ID,
    redirect_uri: process.env.GITLAB_REDIRECT_URI,
    response_type: "code",
    state,
    scope: "read_api read_repository",
  });
  return `https://gitlab.com/oauth/authorize?${params}`;
}

/** Exchange an OAuth code for tokens. Returns { access_token, refresh_token, expires_in }. */
export async function exchangeCode(code) {
  const { data } = await axios.post("https://gitlab.com/oauth/token", {
    client_id: process.env.GITLAB_CLIENT_ID,
    client_secret: process.env.GITLAB_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: process.env.GITLAB_REDIRECT_URI,
  });
  return data;
}

/** Refresh an expired GitLab access token. */
export async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post("https://gitlab.com/oauth/token", {
    client_id: process.env.GITLAB_CLIENT_ID,
    client_secret: process.env.GITLAB_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    redirect_uri: process.env.GITLAB_REDIRECT_URI,
  });
  return data;
}

/** Fetch the authenticated GitLab user profile. */
export async function getAuthenticatedUser(accessToken) {
  const { data } = await axios.get(`${GL_API}/user`, {
    headers: glHeaders(accessToken),
  });
  return {
    id: data.id,
    username: data.username,
    name: data.name,
    email: data.email,
    avatarUrl: data.avatar_url,
  };
}

/** List repos the user has access to. */
export async function listUserRepos(accessToken, page = 1, perPage = 30) {
  try {
    console.log("[gitlab.service] Fetching repositories", { page, perPage });
    
    const { data } = await axios.get(`${GL_API}/projects`, {
      headers: glHeaders(accessToken),
      params: {
        membership: true,
        order_by: "last_activity_at",
        sort: "desc",
        per_page: perPage,
        page,
      },
    });
    
    console.log("[gitlab.service] Raw GitLab API response", {
      projectCount: data?.length || 0,
      firstProject: data?.[0] ? { id: data[0].id, name: data[0].name, path_with_namespace: data[0].path_with_namespace } : null,
    });

    const repos = data.map((p) => {
      if (!p.path_with_namespace || !p.web_url) {
        console.warn("[gitlab.service] Project missing required fields", {
          id: p.id,
          name: p.name,
          has_path_with_namespace: !!p.path_with_namespace,
          has_web_url: !!p.web_url,
        });
      }
      return {
        id: p.id,
        name: p.name,
        path_with_namespace: p.path_with_namespace,
        web_url: p.web_url,
        description: p.description,
        visibility: p.visibility,
        default_branch: p.default_branch,
        last_activity_at: p.last_activity_at,
      };
    });

    console.log("[gitlab.service] Mapped repositories successfully", { count: repos.length });
    return repos;
  } catch (err) {
    console.error("[gitlab.service] Error fetching repositories", {
      error_code: err.code,
      error_message: err.message,
      response_status: err.response?.status,
      response_data: err.response?.data,
    });
    throw err;
  }
}

// ── Repo metadata ─────────────────────────────────────────────

/** Same return shape as github.service.js → getRepoMeta(). */
export async function getRepoMeta(owner, repo, accessToken) {
  const { data } = await axios.get(
    `${GL_API}/projects/${encodePath(owner, repo)}`,
    { headers: glHeaders(accessToken) },
  );
  return {
    name: data.name,
    description: data.description,
    language: null,
    stars: data.star_count,
    defaultBranch: data.default_branch,
    topics: data.topics || [],
    createdAt: data.created_at,
    updatedAt: data.last_activity_at,
  };
}

// ── Commit SHA resolution ─────────────────────────────────────

/** Same signature as github.service.js → getCommitSha(). */
export async function getCommitSha(owner, repo, branch, accessToken) {
  const { data } = await axios.get(
    `${GL_API}/projects/${encodePath(owner, repo)}/repository/branches/${encodeURIComponent(branch)}`,
    { headers: glHeaders(accessToken) },
  );
  return data.commit.id;
}

// ── File tree with blob SHAs ──────────────────────────────────

/**
 * Fetch the recursive file tree with per-file blob SHAs.
 * GitLab's tree API paginates — we exhaust all pages.
 * Same return shape as github.service.js → getFileTreeWithSha().
 */
export async function getFileTreeWithSha(owner, repo, branch, accessToken) {
  const pid = encodePath(owner, repo);
  const all = [];
  let page = 1;

  while (true) {
    const { data, headers: res } = await axios.get(
      `${GL_API}/projects/${pid}/repository/tree`,
      {
        headers: glHeaders(accessToken),
        params: { ref: branch, recursive: true, per_page: 100, page },
      },
    );
    all.push(...data.filter((i) => i.type === "blob"));
    const total = parseInt(res["x-total-pages"] || "1");
    if (page >= total) break;
    page++;
  }

  return all
    .filter((i) => !SKIP_EXT.test(i.path))
    .map((i) => ({ path: i.path, sha: i.id, size: null }));
}

/** Same as getFileTreeWithSha but drops SHA — used for full runs. */
export async function getFileTree(owner, repo, branch, accessToken) {
  const items = await getFileTreeWithSha(owner, repo, branch, accessToken);
  return items.map((i) => ({ path: i.path, size: i.size }));
}

// ── Compute file diff from stored manifest ────────────────────

/** Same return shape as github.service.js → computeFileDiff(). */
export async function computeFileDiff(
  owner,
  repo,
  branch,
  storedManifest,
  accessToken,
) {
  const currentTree = await getFileTreeWithSha(
    owner,
    repo,
    branch,
    accessToken,
  );
  const eligible = currentTree.filter((f) => !SKIP_EXT.test(f.path));

  const manifestMap = new Map(storedManifest.map((f) => [f.path, f]));
  const currentMap = new Map(eligible.map((f) => [f.path, f]));

  const added = [],
    modified = [],
    removed = [],
    unchanged = [];

  for (const [path, cur] of currentMap) {
    const stored = manifestMap.get(path);
    if (!stored) added.push({ path, sha: cur.sha, status: "added" });
    else if (stored.sha !== cur.sha)
      modified.push({ path, sha: cur.sha, status: "modified" });
    else unchanged.push({ path });
  }
  for (const [path] of manifestMap) {
    if (!currentMap.has(path)) removed.push({ path, status: "removed" });
  }

  return { added, modified, removed, unchanged, currentTree: eligible };
}

// ── File content ──────────────────────────────────────────────

/** Same signature as github.service.js → getFileContent(). */
export async function getFileContent(
  owner,
  repo,
  filePath,
  accessToken,
  ref = "HEAD",
) {
  const pid = encodePath(owner, repo);
  try {
    const { data } = await axios.get(
      `${GL_API}/projects/${pid}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        headers: glHeaders(accessToken),
        params: { ref },
        responseType: "text",
        transformResponse: [(d) => d], // prevent axios auto-JSON-parsing
      },
    );
    return typeof data === "string" ? data : "";
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 403) return "";
    throw err;
  }
}

/** Same signature as github.service.js → fetchFileContents(). */
export async function fetchFileContents(
  owner,
  repo,
  filePaths,
  onProgress,
  accessToken,
) {
  const files = [];
  for (const [i, path] of filePaths.entries()) {
    const content = await getFileContent(owner, repo, path, accessToken);
    if (content.trim()) files.push({ path, content });
    if ((i + 1) % 10 === 0 || i === filePaths.length - 1) {
      onProgress?.(`Fetching changed files… ${i + 1}/${filePaths.length}`);
    }
  }
  return files;
}

// ── Full repo fetch ───────────────────────────────────────────

/** Same return shape as github.service.js → fetchRepoFiles(). */
export async function fetchRepoFiles(repoUrl, accessToken) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const meta = await getRepoMeta(owner, repo, accessToken);
  const allFiles = await getFileTree(
    owner,
    repo,
    meta.defaultBranch,
    accessToken,
  );
  const eligible = selectRelevantFiles(
    allFiles.filter((f) => !SKIP_EXT.test(f.path)),
    MAX_FILES,
  );

  console.log(
    `📂 Fetching ${eligible.length} files from ${owner}/${repo} (GitLab)…`,
  );

  const files = [];
  for (const file of eligible) {
    const content = await getFileContent(
      owner,
      repo,
      file.path,
      accessToken,
      meta.defaultBranch,
    );
    if (content.trim()) files.push({ path: file.path, content });
  }
  return { meta, files, owner, repo };
}

/** Same as fetchRepoFiles with progress callbacks. */
export async function fetchRepoFilesWithProgress(
  repoUrl,
  onProgress,
  accessToken,
) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  onProgress?.(`Reading repo info for ${owner}/${repo}…`);

  const meta = await getRepoMeta(owner, repo, accessToken);
  onProgress?.(`Reading file tree on branch "${meta.defaultBranch}"…`);

  const allFiles = await getFileTree(
    owner,
    repo,
    meta.defaultBranch,
    accessToken,
  );
  const eligible = selectRelevantFiles(
    allFiles.filter((f) => !SKIP_EXT.test(f.path)),
    MAX_FILES,
  );
  onProgress?.(`Downloading ${eligible.length} source files…`);

  const files = [];
  for (const [i, file] of eligible.entries()) {
    const content = await getFileContent(
      owner,
      repo,
      file.path,
      accessToken,
      meta.defaultBranch,
    );
    if (content.trim()) files.push({ path: file.path, content });
    if ((i + 1) % 20 === 0 || i === eligible.length - 1) {
      onProgress?.(`Downloaded ${i + 1} / ${eligible.length} files…`);
    }
  }
  return { meta, files, owner, repo };
}

// ── Webhook ───────────────────────────────────────────────────

/**
 * Validate a GitLab webhook token.
 * GitLab sends the configured secret as a plain X-Gitlab-Token header — no HMAC.
 * We use constant-time comparison to prevent timing attacks.
 */
export function validateWebhookToken(incomingToken, expectedSecret) {
  // Fail closed: if no secret is configured for this project, reject the webhook.
  // Accepting arbitrary webhooks without a shared secret is a security risk.
  if (!expectedSecret) return false;
  if (!incomingToken) return false;
  const a = Buffer.from(String(incomingToken));
  const b = Buffer.from(String(expectedSecret));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Register a push webhook on a GitLab project.
 * Called automatically when a user connects their repo.
 */
export async function registerWebhook(
  owner,
  repo,
  accessToken,
  webhookUrl,
  secret,
) {
  const { data } = await axios.post(
    `${GL_API}/projects/${encodePath(owner, repo)}/hooks`,
    {
      url: webhookUrl,
      token: secret,
      push_events: true,
      enable_ssl_verification: true,
    },
    { headers: glHeaders(accessToken) },
  );
  return { hookId: data.id };
}

/** Delete a webhook — called on project delete or GitLab disconnect. */
export async function deleteWebhook(owner, repo, accessToken, hookId) {
  try {
    await axios.delete(
      `${GL_API}/projects/${encodePath(owner, repo)}/hooks/${hookId}`,
      { headers: glHeaders(accessToken) },
    );
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }
}
