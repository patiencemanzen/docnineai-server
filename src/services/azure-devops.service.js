// =============================================================
// Azure DevOps API client — mirrors github/gitlab.service.js
//
// Azure DevOps REST API: https://learn.microsoft.com/en-us/rest/api/azure/devops/
//
// Key differences:
//  - Uses Personal Access Tokens (PAT) or OAuth
//  - Repository identified by organization/project/repo
//  - Base64 auth header for PAT (username is empty string)
//  - Different file tree & content APIs
// =============================================================

import axios from "axios";

const AZURE_API = "https://dev.azure.com";
const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;

// ── Internal helpers ──────────────────────────────────────────

function azHeaders(accessToken) {
  // Azure DevOps uses Basic auth with PAT (username is empty string)
  const auth = Buffer.from(`:${accessToken}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
  };
}

// ── URL parsing ───────────────────────────────────────────────

/**
 * Parse an Azure DevOps repo URL into { owner, repo, project }.
 * Formats:
 *  - https://dev.azure.com/org/project/_git/repo
 *  - git@ssh.dev.azure.com:v3/org/project/repo
 *  - org/project/repo (shorthand)
 */
export function parseRepoUrl(url) {
  const s = String(url || "")
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  // SSH format: git@ssh.dev.azure.com:v3/org/project/repo
  const ssh = s.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)/);
  if (ssh) {
    return {
      owner: ssh[1],
      project: ssh[2],
      repo: ssh[3],
    };
  }

  // HTTPS format: https://dev.azure.com/org/project/_git/repo
  const https = s.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/);
  if (https) {
    return {
      owner: https[1],
      project: https[2],
      repo: https[3],
    };
  }

  // Shorthand: org/project/repo
  const short = s.match(/^([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/);
  if (short) {
    return {
      owner: short[1],
      project: short[2],
      repo: short[3],
    };
  }

  const err = new Error(`Invalid Azure DevOps URL: ${url}`);
  err.code = "INVALID_REPO_URL";
  err.status = 400;
  throw err;
}

// ── OAuth ─────────────────────────────────────────────────────

/** Build the Azure DevOps OAuth authorization URL. */
export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_DEVOPS_CLIENT_ID,
    response_type: "code",
    state,
    scope: "vso.code",
    redirect_uri: process.env.AZURE_DEVOPS_REDIRECT_URI,
  });
  return `https://app.vssps.visualstudio.com/oauth2/authorize?${params}`;
}

/** Exchange OAuth authorization code for access token. */
export async function exchangeCode(code) {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_DEVOPS_CLIENT_ID,
    client_secret: process.env.AZURE_DEVOPS_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.AZURE_DEVOPS_REDIRECT_URI,
  });
  
  const { data } = await axios.post(
    "https://app.vssps.visualstudio.com/oauth2/token",
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || 3600,
  };
}

/** Fetch the authenticated Azure DevOps user profile. */
export async function getAuthenticatedUser(accessToken) {
  const { data } = await axios.get(`${AZURE_API}/_api/_identity/me`, {
    headers: azHeaders(accessToken),
  });
  return {
    id: data.id,
    username: data.providerDisplayName || data.displayName,
    name: data.displayName || data.providerDisplayName,
    email: data.emailAddress || null,
    avatarUrl: data.avatar?.large || null,
  };
}

/** List repos the user has access to. */
export async function listUserRepos(accessToken, page = 1, perPage = 30) {
  try {
    console.log("[azure-devops.service] Fetching repositories", { page, perPage });
    
    // Azure DevOps requires org + project to list repos
    const skip = (page - 1) * perPage;
    const { data } = await axios.get(`${AZURE_API}/_apis/projects`, {
      headers: azHeaders(accessToken),
      params: { $skip: skip, $top: perPage, "api-version": "7.0" },
    });

    const projects = data.value || [];
    console.log("[azure-devops.service] Fetched projects", { projectCount: projects.length });
    
    const repos = [];

    // Fetch repos from each project
    for (const proj of projects) {
      try {
        const { data: projRepos } = await axios.get(
          `${AZURE_API}/${proj.name}/_apis/git/repositories`,
          {
            headers: azHeaders(accessToken),
            params: { "api-version": "7.0" },
          },
        );
        
        const projReposArray = (projRepos.value || []).map((r) => ({
          id: r.id,
          name: r.name,
          full_name: `${proj.name}/${r.name}`,
          webUrl: r.webUrl,
          description: r.description || "",
          isPublic: r.isPublic,
          defaultBranch: r.defaultBranch || "main",
          pushedDate: r.pushedDate,
          project: proj.name,
        }));
        
        console.log(`[azure-devops.service] Fetched repos from project ${proj.name}`, { repoCount: projReposArray.length });
        repos.push(...projReposArray);
      } catch (err) {
        console.warn(`[azure-devops.service] Failed to fetch repos from project ${proj.name}`, {
          error_code: err.code,
          error_message: err.message,
        });
      }
    }

    console.log("[azure-devops.service] Mapped repositories successfully", { total: repos.length });
    return repos.slice(skip, skip + perPage);
  } catch (err) {
    console.error("[azure-devops.service] Error fetching repositories", {
      error_code: err.code,
      error_message: err.message,
      response_status: err.response?.status,
      response_data: err.response?.data,
    });
    throw err;
  }
}

// ── Repo metadata ─────────────────────────────────────────────

export async function getRepoMeta(org, project, repo, accessToken) {
  const { data } = await axios.get(
    `${AZURE_API}/${org}/${project}/_apis/git/repositories/${repo}`,
    { headers: azHeaders(accessToken), params: { "api-version": "7.0" } },
  );

  return {
    name: data.name,
    description: data.description || "",
    language: null,
    stars: 0,
    defaultBranch: data.defaultBranch || "main",
    topics: [],
    createdAt: data.createdDate,
    updatedAt: data.pushedDate || data.createdDate,
  };
}

// ── Commit SHA resolution ─────────────────────────────────────

export async function getCommitSha(org, project, repo, branch, accessToken) {
  const { data } = await axios.get(
    `${AZURE_API}/${org}/${project}/_apis/git/repositories/${repo}/refs`,
    {
      headers: azHeaders(accessToken),
      params: {
        filter: `heads/${branch}`,
        "api-version": "7.0",
      },
    },
  );

  const ref = (data.value || []).find((r) => r.name === `refs/heads/${branch}`);
  if (!ref) throw new Error(`Branch ${branch} not found`);
  return ref.objectId;
}

// ── File tree with blob SHAs ──────────────────────────────────

export async function getFileTreeWithSha(
  org,
  project,
  repo,
  branch,
  accessToken,
) {
  const all = [];
  let skip = 0;

  while (true) {
    const { data } = await axios.get(
      `${AZURE_API}/${org}/${project}/_apis/git/repositories/${repo}/items`,
      {
        headers: azHeaders(accessToken),
        params: {
          recursionLevel: "full",
          versionDescriptor: { versionType: "branch", version: branch },
          $skip: skip,
          $top: 100,
          "api-version": "7.0",
        },
      },
    );

    const items = (data.value || []).filter((i) => i.gitObjectType === "blob");
    if (items.length === 0) break;

    all.push(...items);

    if (!data["@nextLink"]) break;
    skip += 100;
  }

  return all
    .filter((i) => !SKIP_EXT.test(i.path))
    .map((i) => ({
      path: i.path,
      sha: i.objectId.substring(0, 40),
      size: i.size || 0,
    }));
}

/** File tree without SHAs. */
export async function getFileTree(org, project, repo, branch, accessToken) {
  const items = await getFileTreeWithSha(
    org,
    project,
    repo,
    branch,
    accessToken,
  );
  return items.map((i) => ({ path: i.path, size: i.size }));
}

// ── Compute file diff ────────────────────────────────────────

export async function computeFileDiff(
  org,
  project,
  repo,
  branch,
  storedManifest,
  accessToken,
) {
  const currentTree = await getFileTreeWithSha(
    org,
    project,
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

export async function getFileContent(
  org,
  project,
  repo,
  filePath,
  accessToken,
) {
  try {
    const { data } = await axios.get(
      `${AZURE_API}/${org}/${project}/_apis/git/repositories/${repo}/items`,
      {
        headers: azHeaders(accessToken),
        params: {
          path: `/${filePath}`,
          download: true,
          "api-version": "7.0",
        },
      },
    );
    return typeof data === "string" ? data : "";
  } catch (err) {
    if (err.response?.status === 404) return "";
    throw err;
  }
}

// ── Batch-fetch file contents ────────────────────────────────

export async function fetchFileContents(
  org,
  project,
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
    const content = await getFileContent(org, project, repo, path, accessToken);
    if (content.trim()) files.push({ path, content });
    if ((i + 1) % 10 === 0 || i === filePaths.length - 1) {
      notify(`Fetching changed files… ${i + 1}/${filePaths.length}`);
    }
  }
  return files;
}

// ── Full repo fetch ──────────────────────────────────────────

export async function fetchRepoFiles(repoUrl, accessToken) {
  const { owner, project, repo } = parseRepoUrl(repoUrl);
  const meta = await getRepoMeta(owner, project, repo, accessToken);
  const allFiles = await getFileTree(
    owner,
    project,
    repo,
    meta.defaultBranch,
    accessToken,
  );

  const eligible = allFiles
    .filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024)
    .slice(0, MAX_FILES);

  console.log(
    `📂 Fetching ${eligible.length} files from ${owner}/${project}/${repo}…`,
  );

  const files = [];
  for (const file of eligible) {
    const content = await getFileContent(
      owner,
      project,
      repo,
      file.path,
      accessToken,
    );
    if (content.trim()) files.push({ path: file.path, content });
  }

  return { meta, files, owner, project, repo };
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

  const { owner, project, repo } = parseRepoUrl(repoUrl);
  notify(`Reading repo info for ${owner}/${project}/${repo}…`);
  const meta = await getRepoMeta(owner, project, repo, accessToken);

  notify(`Reading file tree on branch "${meta.defaultBranch}"…`);
  const allFiles = await getFileTree(
    owner,
    project,
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
    const content = await getFileContent(
      owner,
      project,
      repo,
      file.path,
      accessToken,
    );
    if (content.trim()) files.push({ path: file.path, content });
    if ((i + 1) % 20 === 0 || i === eligible.length - 1) {
      notify(`Downloaded ${i + 1} / ${eligible.length} files…`);
    }
  }

  return { meta, files, owner, project, repo };
}
