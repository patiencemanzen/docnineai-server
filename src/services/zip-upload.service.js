// =============================================================
// ZIP Upload Service
//
// Handles extraction and processing of uploaded ZIP files.
// Simplified interface compared to git providers : no remote
// APIs, no OAuth, no incremental sync.
//
// ZIP projects:
//  - No repoUrl / repoOwner / repoName
//  - No provider tracking (sourceType = "zip")
//  - No incremental sync capability
//  - No continuous connection tracking
//  - Files extracted to memory/temp storage, then processed
// =============================================================

import AdmZip from "adm-zip";
import path from "path";
import crypto from "crypto";

const MAX_FILES = parseInt(process.env.MAX_FILES_PER_REPO || "100");
const MAX_KB = parseInt(process.env.MAX_FILE_SIZE_KB || "50");
const MAX_ZIP_SIZE =
  parseInt(process.env.MAX_ZIP_SIZE_MB || "50") * 1024 * 1024;

const SKIP_EXT =
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|mp4|mp3|bin|exe|dll|so|dylib|lock)$/i;

// ── ZIP validation ────────────────────────────────────────────

/**
 * Validate ZIP file buffer before extraction.
 * @throws Error if validation fails
 */
export function validateZipBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error("ZIP file is empty");
  }

  if (buffer.length > MAX_ZIP_SIZE) {
    throw new Error(
      `ZIP file exceeds maximum size of ${MAX_ZIP_SIZE / 1024 / 1024}MB`,
    );
  }

  // Check ZIP magic number (0x50 0x4B 0x03 0x04 = "PK\x03\x04")
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error("File is not a valid ZIP archive");
  }
}

// ── ZIP extraction ────────────────────────────────────────────

/**
 * Extract files from a ZIP buffer.
 * Returns { files: [{path, content}], meta: {name, fileCount, totalSize} }
 */
export function extractZipFiles(buffer, zipFilename = "upload.zip") {
  validateZipBuffer(buffer);

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`Failed to parse ZIP: ${err.message}`);
  }

  const entries = zip.getEntries();
  const files = [];
  let totalSize = 0;

  // Extract root directory name if ZIP contains a single top-level folder
  // e.g., my-project-main/ (common GitHub download pattern)
  const topLevelDirs = new Set();
  entries.forEach((e) => {
    if (e.isDirectory) return;
    const firstPart = e.entryName.split("/")[0];
    if (firstPart) topLevelDirs.add(firstPart);
  });

  const hasRootFolder = topLevelDirs.size === 1;
  const rootPrefix = hasRootFolder ? `${Array.from(topLevelDirs)[0]}/` : "";

  for (const entry of entries) {
    // Skip directories
    if (entry.isDirectory) continue;

    // Remove root folder prefix if present
    let filePath = entry.entryName;
    if (hasRootFolder && filePath.startsWith(rootPrefix)) {
      filePath = filePath.slice(rootPrefix.length);
    }

    // Skip binary files and oversized files
    if (SKIP_EXT.test(filePath) || entry.header.size > MAX_KB * 1024) {
      continue;
    }

    // Skip hidden files and dotfiles (except .gitignore, .env, etc)
    const filename = path.basename(filePath);
    if (filename.startsWith(".") && !isImportantDotfile(filename)) {
      continue;
    }

    try {
      const data = entry.getData();
      const content = data.toString("utf-8");

      // Skip empty files
      if (!content.trim()) continue;

      files.push({ path: filePath, content });
      totalSize += content.length;
    } catch {
      // Skip files that can't be decoded as UTF-8
      continue;
    }
  }

  // Sort by path for consistency
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Limit to MAX_FILES
  const truncated = files.slice(0, MAX_FILES);

  // Extract project name from ZIP filename
  const projectName = zipFilename
    .replace(/\.zip$/i, "")
    .replace(/[-_]/g, " ")
    .trim();

  return {
    files: truncated,
    meta: {
      name: projectName,
      fileCount: truncated.length,
      totalSize,
      uploadedAt: new Date(),
      zipFilename,
      checksum: crypto.randomBytes(16).toString("hex"), // identifier for this upload
    },
  };
}

// ── Helper: identify important dotfiles ──────────────────────

function isImportantDotfile(filename) {
  const important = [
    ".gitignore",
    ".env",
    ".env.example",
    ".env.local",
    ".gitattributes",
    ".prettierrc",
    ".eslintrc",
    ".eslintignore",
    ".dockerignore",
  ];
  return important.includes(filename);
}

// ── Project metadata from extracted files ────────────────────

/**
 * Infer project metadata from the extracted files.
 * Looks for package.json, package-lock.json, schema files, etc.
 */
export function inferProjectMetadata(files) {
  const paths = files.map((f) => f.path);
  const packageJson = files.find((f) => f.path === "package.json");
  const pyproject = files.find((f) => f.path === "pyproject.toml");
  const pom = files.find((f) => f.path === "pom.xml");
  const csharpProj = files.find((f) => f.path.endsWith(".csproj"));
  const goMod = files.find((f) => f.path === "go.mod");

  let language = "unknown";
  let techStack = [];

  if (packageJson) {
    language = "javascript";
    try {
      const pkg = JSON.parse(packageJson.content);
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        techStack.push("typescript");
      }
      if (pkg.devDependencies?.react || pkg.dependencies?.react) {
        techStack.push("react");
      }
      if (pkg.devDependencies?.express || pkg.dependencies?.express) {
        techStack.push("express");
      }
      if (pkg.devDependencies?.vite) {
        techStack.push("vite");
      }
    } catch {
      /* ignore JSON parse errors */
    }
  } else if (pyproject) {
    language = "python";
    techStack.push("python");
  } else if (pom) {
    language = "java";
    techStack.push("java");
    techStack.push("maven");
  } else if (csharpProj) {
    language = "csharp";
    techStack.push("csharp");
  } else if (goMod) {
    language = "go";
    techStack.push("go");
  }

  // Detect frameworks/tools from file presence
  if (paths.some((p) => p.includes("docker"))) {
    techStack.push("docker");
  }
  if (paths.some((p) => p.includes("kubernetes"))) {
    techStack.push("kubernetes");
  }
  if (paths.some((p) => p.includes("terraform"))) {
    techStack.push("terraform");
  }

  return {
    language,
    techStack: [...new Set(techStack)], // deduplicate
    fileCount: files.length,
  };
}

// ── Validation & error handling ──────────────────────────────

export function formatZipError(error) {
  if (error.message.includes("ZIP")) {
    return error.message; // Our custom ZIP errors
  }
  return `Failed to process ZIP file: ${error.message}`;
}
