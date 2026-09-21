import * as githubService from "../services/github-api.service.js";
import * as gitlabService from "../services/gitlab.service.js";
import * as bitbucketService from "../services/bitbucket.service.js";
import * as azureDevOpsService from "../services/azure-devops.service.js";
import * as zipUploadService from "../services/zip-upload.service.js";

const PROVIDERS = {
  github: githubService,
  gitlab: gitlabService,
  bitbucket: bitbucketService,
  azure: azureDevOpsService,
  zip: zipUploadService,
};

export function getAdapter(provider) {
  const adapter = PROVIDERS[provider || "github"];
  if (!adapter) {
    throw new Error(
      `Unknown provider: "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return adapter;
}

export function detectProvider(repoUrl) {
  const url = String(repoUrl || "").toLowerCase();
  if (url.includes("gitlab.com")) return "gitlab";
  if (url.includes("bitbucket.org")) return "bitbucket";
  if (url.includes("dev.azure.com")) return "azure";
  return "github";
}

export function parseRepoUrl(provider, repoUrl) {
  return getAdapter(provider).parseRepoUrl(repoUrl);
}

export function createRepoAdapter(provider, repoUrl) {
  const svc = getAdapter(provider);
  const parsed = svc.parseRepoUrl(repoUrl);

  const rp =
    provider === "azure"
      ? [parsed.owner, parsed.project, parsed.repo]
      : [parsed.owner, parsed.repo];

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    project: parsed.project,

    getRepoMeta: (token) => svc.getRepoMeta(...rp, token),

    getCommitSha: (branch, token) => svc.getCommitSha(...rp, branch, token),

    getFileTreeWithSha: (branch, token) => svc.getFileTreeWithSha(...rp, branch, token),

    computeFileDiff: (branch, storedManifest, token) =>
      svc.computeFileDiff(...rp, branch, storedManifest, token),

    fetchFileContents: (paths, onProgress, token) =>
      svc.fetchFileContents(...rp, paths, onProgress, token),
  };
}

export function normaliseRepoUrl(provider, repoUrl) {
  const svc = getAdapter(provider);
  const parsed = svc.parseRepoUrl(repoUrl);

  if (provider === "azure") {
    const { owner, project, repo } = parsed;
    return `https://dev.azure.com/${owner}/${project}/_git/${repo}`;
  }

  const { owner, repo } = parsed;
  const hosts = {
    github: "github.com",
    gitlab: "gitlab.com",
    bitbucket: "bitbucket.org",
  };
  return `https://${hosts[provider] || "github.com"}/${owner}/${repo}`;
}
