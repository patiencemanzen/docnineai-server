// =============================================================
// Bitbucket Cloud API client — mirrors github/gitlab.service.js
//
// Bitbucket API v2.0: https://developer.atlassian.com/cloud/bitbucket/rest/intro/
//
// Key differences from GitHub:
//  - OAuth uses per-user access tokens (like GitLab)
//  - Repository identification uses workspace/repo_slug
//  - File tree API different structure
//  - Default branch stored as explicit field
// =============================================================

import axios from "axios";
import crypto from "crypto";

const BB_API = "https://api.bitbucket.org/2.0";
const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;

// ── Internal helpers ──────────────────────────────────────────

function bbHeaders(accessToken) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

// ── URL parsing ───────────────────────────────────────────────

/**
 * Parse a Bitbucket repo URL into { owner, repo }.
 * Accepts HTTPS, SSH, and shorthand (owner/repo) formats.
 */
export function parseRepoUrl(url) {
  const s = String(url || "")
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const ssh = s.match(/git@bitbucket\.org:([^/]+)\/([^/]+)/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const https = s.match(/bitbucket\.org\/([^/]+)\/([^/?#]+)/);
  if (https) return { owner: https[1], repo: https[2] };

  const short = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (short) return { owner: short[1], repo: short[2] };

  const err = new Error(`Invalid Bitbucket URL: ${url}`);
  err.code = "INVALID_REPO_URL";
  err.status = 400;
  throw err;
}

// ── OAuth ─────────────────────────────────────────────────────

/** Build the Bitbucket OAuth authorisation URL. */
export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.BITBUCKET_CLIENT_ID,
    response_type: "code",
    state,
  });
  return `https://bitbucket.org/site/oauth2/authorize?${params}`;
}

/** Exchange an OAuth code for tokens. Returns { access_token, refresh_token, expires_in }. */
export async function exchangeCode(code) {
  // Bitbucket requires form-encoded data, not JSON
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
  });

  const { data } = await axios.post(
    "https://bitbucket.org/site/oauth2/access_token",
    params.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: {
        username: process.env.BITBUCKET_CLIENT_ID,
        password: process.env.BITBUCKET_CLIENT_SECRET,
      },
    },
  );
  return data;
}

/** Refresh an expired Bitbucket access token. */
export async function refreshAccessToken(refreshToken) {
  // Bitbucket requires form-encoded data, not JSON
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const { data } = await axios.post(
    "https://bitbucket.org/site/oauth2/access_token",
    params.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      auth: {
        username: process.env.BITBUCKET_CLIENT_ID,
        password: process.env.BITBUCKET_CLIENT_SECRET,
      },
    },
  );
  return data;
}

/** Fetch the authenticated Bitbucket user profile. */
export async function getAuthenticatedUser(accessToken) {
  const { data } = await axios.get(`${BB_API}/user`, {
    headers: bbHeaders(accessToken),
  });
  return {
    id: data.uuid,
    username: data.username,
    name: data.display_name || data.username,
    email: data.email || null,
    avatarUrl: data.links?.avatar?.href || null,
  };
}

/** List repos the user has access to. */
export async function listUserRepos(accessToken, page = 1, perPage = 30) {
  const start = (page - 1) * perPage;
  const { data } = await axios.get(`${BB_API}/repositories`, {
    headers: bbHeaders(accessToken),
    params: {
      role: "member", // owned or member
      pagelen: perPage,
      page,
      sort: "-updated_on",
    },
  });
  return (data.values || []).map((r) => ({
    id: r.uuid,
    name: r.name,
    fullName: r.full_slug,
    url: r.links.html.href,
    description: r.description,
    private: r.is_private,
    defaultBranch: r.mainbranch?.name || "master",
    updatedAt: r.updated_on,
  }));
}

// ── Repo metadata ─────────────────────────────────────────────

/** Fetch metadata for a repository. */
export async function getRepoMeta(owner, repo, accessToken) {
  const { data } = await axios.get(`${BB_API}/repositories/${owner}/${repo}`, {
    headers: bbHeaders(accessToken),
  });
  return {
    name: data.name,
    description: data.description || "",
    language: null, // Bitbucket doesn't expose primary language in v2.0
    stars: data.has_wiki ? 0 : 0, // No direct stars equivalent
    defaultBranch: data.mainbranch?.name || "master",
    topics: data.project?.links ? [] : [],
    createdAt: data.created_on,
    updatedAt: data.updated_on,
  };
}

// ── Commit SHA resolution ─────────────────────────────────────

/** Get the commit SHA for a branch. */
export async function getCommitSha(owner, repo, branch, accessToken) {
  const { data } = await axios.get(
    `${BB_API}/repositories/${owner}/${repo}/commit/${branch}`,
    { headers: bbHeaders(accessToken) },
  );
  return data.hash;
}

// ── File tree with blob SHAs ──────────────────────────────────

/**
 * Fetch the recursive file tree with per-file blob SHAs.
 * Bitbucket API requires paginated requests.
 */
export async function getFileTreeWithSha(owner, repo, branch, accessToken) {
  const all = [];
  let page = 1;

  while (true) {
    const { data, headers: res } = await axios.get(
      `${BB_API}/repositories/${owner}/${repo}/src/${branch}/`,
      {
        headers: bbHeaders(accessToken),
        params: {
          pagelen: 100,
          page,
          recursive: true,
        },
      },
    );

    if (!data.values) break;

    all.push(...data.values.filter((i) => i.type === "commit_file"));

    if (!data.pagelen || data.values.length < data.pagelen) break;
    page++;
  }

  return all
    .filter((i) => !SKIP_EXT.test(i.path))
    .map((i) => ({
      path: i.path,
      sha: i.commit.hash.substring(0, 40), // Bitbucket returns full hash
      size: i.size || 0,
    }));
}

/** File tree without SHAs (for full runs). */
export async function getFileTree(owner, repo, branch, accessToken) {
  const items = await getFileTreeWithSha(owner, repo, branch, accessToken);
  return items.map((i) => ({ path: i.path, size: i.size }));
}

// ── Compute file diff from stored manifest ────────────────────

/** Compare stored manifest against current tree. */
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
  const eligible = currentTree.filter(
    (f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024,
  );

  const manifestMap = new Map(storedManifest.map((f) => [f.path, f]));
  const currentMap = new Map(eligible.map((f) => [f.path, f]));

  const added = [];
  const modified = [];
  const removed = [];
  const unchanged = [];

  for (const [path, cur] of currentMap) {
    const stored = manifestMap.get(path);
    if (!stored) {
      added.push({ path, sha: cur.sha, status: "added" });
    } else if (stored.sha !== cur.sha) {
      modified.push({ path, sha: cur.sha, status: "modified" });
    } else {
      unchanged.push({ path });
    }
  }

  for (const [path] of manifestMap) {
    if (!currentMap.has(path)) {
      removed.push({ path, status: "removed" });
    }
  }

  return { added, modified, removed, unchanged, currentTree: eligible };
}

// ── Individual file content ───────────────────────────────────

export async function getFileContent(owner, repo, filePath, accessToken) {
  try {
    const { data } = await axios.get(
      `${BB_API}/repositories/${owner}/${repo}/src/HEAD/${filePath}`,
      { headers: bbHeaders(accessToken) },
    );
    return typeof data === "string" ? data : "";
  } catch (err) {
    if (err.response?.status === 404) return "";
    throw err;
  }
}

// ── Batch-fetch file contents ────────────────────────────────

export async function fetchFileContents(
  owner,
  repo,
  filePaths,
  onProgress,
  accessToken,
) {
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };
  const files = [];

  for (const [i, path] of filePaths.entries()) {
    const content = await getFileContent(owner, repo, path, accessToken);
    if (content.trim()) files.push({ path, content });
    if ((i + 1) % 10 === 0 || i === filePaths.length - 1) {
      notify(`Fetching changed files… ${i + 1}/${filePaths.length}`);
    }
  }
  return files;
}

// ── Full repo fetch ──────────────────────────────────────────

export async function fetchRepoFiles(repoUrl, accessToken) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const meta = await getRepoMeta(owner, repo, accessToken);
  const allFiles = await getFileTree(
    owner,
    repo,
    meta.defaultBranch,
    accessToken,
  );

  const eligible = allFiles
    .filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024)
    .slice(0, MAX_FILES);

  console.log(`📂 Fetching ${eligible.length} files from ${owner}/${repo}…`);

  const files = [];
  for (const file of eligible) {
    const content = await getFileContent(owner, repo, file.path, accessToken);
    if (content.trim()) files.push({ path: file.path, content });
  }

  return { meta, files, owner, repo };
}

// ── Full repo fetch with progress ────────────────────────────

export async function fetchRepoFilesWithProgress(
  repoUrl,
  onProgress,
  accessToken,
) {
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };

  const { owner, repo } = parseRepoUrl(repoUrl);
  notify(`Reading repo info for ${owner}/${repo}…`);
  const meta = await getRepoMeta(owner, repo, accessToken);

  notify(`Reading file tree on branch "${meta.defaultBranch}"…`);
  const allFiles = await getFileTree(
    owner,
    repo,
    meta.defaultBranch,
    accessToken,
  );

  const eligible = allFiles
    .filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024)
    .slice(0, MAX_FILES);

  notify(`Downloading ${eligible.length} source files…`);

  const files = [];
  for (const [i, file] of eligible.entries()) {
    const content = await getFileContent(owner, repo, file.path, accessToken);
    if (content.trim()) files.push({ path: file.path, content });
    if ((i + 1) % 20 === 0 || i === eligible.length - 1) {
      notify(`Downloaded ${i + 1} / ${eligible.length} files…`);
    }
  }

  return { meta, files, owner, repo };
}
