// =============================================================
// Provider Adapter
//
// Single import point for all git provider operations.
// The orchestrator, incremental sync, and webhook handlers import
// from here instead of github.service.js directly.
// =============================================================

import * as githubService from "../services/github.service.js";
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

/**
 * Return the service module for the given provider string.
 * @param {"github"|"gitlab"|"bitbucket"|"azure"|"zip"} provider
 */
export function getAdapter(provider) {
  const adapter = PROVIDERS[provider || "github"];
  if (!adapter) {
    throw new Error(
      `Unknown provider: "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return adapter;
}

/**
 * Detect the provider from a repository URL.
 * Defaults to "github" for unknown hosts.
 */
export function detectProvider(repoUrl) {
  const url = String(repoUrl || "").toLowerCase();
  if (url.includes("gitlab.com")) return "gitlab";
  if (url.includes("bitbucket.org")) return "bitbucket";
  if (url.includes("dev.azure.com")) return "azure";
  return "github";
}

/**
 * Parse a repo URL using the correct provider's parser.
 * Returns { owner, repo }.
 */
export function parseRepoUrl(provider, repoUrl) {
  return getAdapter(provider).parseRepoUrl(repoUrl);
}

/**
 * Normalise a repo URL to its canonical HTTPS form.
 * e.g. git@gitlab.com:foo/bar.git  →  https://gitlab.com/foo/bar
 *      https://dev.azure.com/org/proj/_git/repo → https://dev.azure.com/org/proj/_git/repo
 */
export function normaliseRepoUrl(provider, repoUrl) {
  const svc = getAdapter(provider);
  const parsed = svc.parseRepoUrl(repoUrl);

  // Azure DevOps uses org/project/repo structure
  if (provider === "azure") {
    const { owner, project, repo } = parsed;
    return `https://dev.azure.com/${owner}/${project}/_git/${repo}`;
  }

  // GitHub, GitLab, Bitbucket use org/repo structure
  const { owner, repo } = parsed;
  const hosts = {
    github: "github.com",
    gitlab: "gitlab.com",
    bitbucket: "bitbucket.org",
  };
  return `https://${hosts[provider] || "github.com"}/${owner}/${repo}`;
}
