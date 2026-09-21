import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const GH_API = "https://api.github.com";
const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;

const HIGH_PRIORITY = [
  /^(?:src\/)?(?:main|app|server|index)\.[jt]sx?$/i,
  /^(?:main|app|server|index)\.[jt]sx?$/i,
  /package\.json$/i,
  /requirements\.txt$/i,
  /pyproject\.toml$/i,
  /Cargo\.toml$/i,
  /go\.mod$/i,
  /pom\.xml$/i,
  /composer\.json$/i,
  /Gemfile$/i,
  /README/i,
  /\.env\.example$/i,
  /docker-compose/i,
  /Dockerfile$/i,
];

const SOURCE_PRIORITY = [
  /controller[s]?\//i,
  /route[s]?\//i,
  /model[s]?\//i,
  /service[s]?\//i,
  /schema[s]?\//i,
  /middleware[s]?\//i,
  /migration[s]?\//i,
  /\/api\//i,
  /handler[s]?\//i,
  /repository|repositories/i,
  /util[s]?\/|helper[s]?\//i,
  /config[s]?\//i,
  /hook[s]?\//i,
  /store[s]?\//i,
  /provider[s]?\//i,
];

const LOW_PRIORITY = [
  /\.test\.[jt]sx?$/i,
  /\.spec\.[jt]sx?$/i,
  /__tests__\//i,
  /\/tests?\//i,
  /\/spec[s]?\//i,
  /fixture[s]?\//i,
  /seed[s]?\//i,
  /\.min\.(?:js|css)$/i,
  /\/dist\//i,
  /\/build\//i,
  /\/coverage\//i,
  /\/vendor\//i,
  /\.d\.ts$/i,
  /node_modules\//i,
];

function scoreFilePath(path) {
  if (LOW_PRIORITY.some((r) => r.test(path))) return 0;
  if (HIGH_PRIORITY.some((r) => r.test(path))) return 3;
  if (SOURCE_PRIORITY.some((r) => r.test(path))) return 2;
  return 1;
}

function selectRelevantFiles(files, cap) {
  return files
    .map((f) => ({ ...f, _score: scoreFilePath(f.path) }))
    .filter((f) => f._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, cap)
    .map(({ _score, ...f }) => f);
}

const DOWNLOAD_CONCURRENCY = 10;
let _dlActive = 0;
const _dlQueue = [];

function acquireDownloadSlot() {
  return new Promise((resolve) => {
    if (_dlActive < DOWNLOAD_CONCURRENCY) {
      _dlActive++;
      resolve();
    } else {
      _dlQueue.push(resolve);
    }
  });
}

function releaseDownloadSlot() {
  _dlActive--;
  if (_dlQueue.length > 0) {
    _dlActive++;
    _dlQueue.shift()();
  }
}

function ghHeaders(token = null) {
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function parseRepoUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/?.]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

export async function getRepoMeta(owner, repo, token = null) {
  const { data } = await axios.get(`${GH_API}/repos/${owner}/${repo}`, {
    headers: ghHeaders(token),
  });
  return {
    name: data.name,
    description: data.description,
    language: data.language,
    stars: data.stargazers_count,
    defaultBranch: data.default_branch,
    topics: data.topics,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function getCommitSha(owner, repo, branch, token = null) {
  const { data } = await axios.get(`${GH_API}/repos/${owner}/${repo}/commits/${branch}`, {
    headers: ghHeaders(token),
  });
  return data.sha;
}

export async function getFileTree(owner, repo, branch, token = null) {
  const { data } = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders(token) },
  );
  if (data.truncated) {
    console.warn("-- Tree truncated : repo is very large, some files may be skipped.");
  }
  return data.tree
    .filter((item) => item.type === "blob")
    .map((item) => ({ path: item.path, size: item.size }));
}

export async function getFileTreeWithSha(owner, repo, branch, token = null) {
  const { data } = await axios.get(
    `${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders(token) },
  );
  if (data.truncated) {
    console.warn("-- Tree truncated : some files may be missed in diff.");
  }
  return data.tree
    .filter((item) => item.type === "blob")
    .map((item) => ({ path: item.path, sha: item.sha, size: item.size }));
}

export async function computeFileDiff(owner, repo, branch, storedManifest, token = null) {
  const currentTree = await getFileTreeWithSha(owner, repo, branch, token);
  const eligible = currentTree.filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024);

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

export async function getFileContent(owner, repo, filePath, token = null) {
  try {
    const { data } = await axios.get(
      `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
      { headers: ghHeaders(token) },
    );
    if (data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return data.content || "";
  } catch (err) {
    if (err.response?.status === 403) return "";
    throw err;
  }
}

export async function fetchFileContents(owner, repo, filePaths, onProgress, token = null) {
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };
  const files = [];

  for (const [i, path] of filePaths.entries()) {
    const content = await getFileContent(owner, repo, path, token);
    if (content.trim()) files.push({ path, content });
    if ((i + 1) % 10 === 0 || i === filePaths.length - 1) {
      notify(`Fetching changed files… ${i + 1}/${filePaths.length}`);
    }
  }
  return files;
}

export async function fetchRepoFiles(repoUrl, token = null) {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const meta = await getRepoMeta(owner, repo, token);
  const allFiles = await getFileTree(owner, repo, meta.defaultBranch, token);

  const eligible = selectRelevantFiles(
    allFiles.filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024),
    MAX_FILES,
  );

  console.log(`📂 Fetching ${eligible.length} files from ${owner}/${repo}…`);

  const files = (
    await Promise.all(
      eligible.map(async (file) => {
        await acquireDownloadSlot();
        try {
          const content = await getFileContent(owner, repo, file.path, token);
          return content.trim() ? { path: file.path, content } : null;
        } finally {
          releaseDownloadSlot();
        }
      }),
    )
  ).filter(Boolean);
  return { meta, files, owner, repo };
}

export async function fetchRepoFilesWithProgress(repoUrl, onProgress, token = null) {
  const notify = (msg) => {
    if (onProgress) onProgress(msg);
  };

  const { owner, repo } = parseRepoUrl(repoUrl);
  notify(`Reading repo info for ${owner}/${repo}…`);
  const meta = await getRepoMeta(owner, repo, token);

  notify(`Reading file tree on branch "${meta.defaultBranch}"…`);
  const allFiles = await getFileTree(owner, repo, meta.defaultBranch, token);

  const eligible = selectRelevantFiles(
    allFiles.filter((f) => !SKIP_EXT.test(f.path) && f.size < MAX_KB * 1024),
    MAX_FILES,
  );

  notify(`Downloading ${eligible.length} source files…`);

  let downloaded = 0;
  const files = (
    await Promise.all(
      eligible.map(async (file) => {
        await acquireDownloadSlot();
        try {
          const content = await getFileContent(owner, repo, file.path, token);
          downloaded++;
          if (downloaded % 20 === 0 || downloaded === eligible.length) {
            notify(`Downloaded ${downloaded} / ${eligible.length} files…`);
          }
          return content.trim() ? { path: file.path, content } : null;
        } finally {
          releaseDownloadSlot();
        }
      }),
    )
  ).filter(Boolean);

  return { meta, files, owner, repo };
}
