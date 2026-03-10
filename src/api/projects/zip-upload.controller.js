// =============================================================
// ZIP Upload Controller
//
// Handles project creation from uploaded ZIP files.
// =============================================================

import { Project } from "../../models/Project.js";
import * as zipService from "../../services/zip-upload.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

// ── POST /projects/zip/upload ─────────────────────────────────
// Accept file upload, extract, validate, and create project
export async function uploadZipProject(req, res) {
  try {
    if (!req.file) {
      return fail(res, "NO_FILE", "No ZIP file uploaded", 400);
    }

    const { buffer, originalname } = req.file;

    // Validate and extract ZIP
    const { files, meta } = zipService.extractZipFiles(buffer, originalname);

    if (files.length === 0) {
      return fail(res, "EMPTY_ZIP", "No source files found in ZIP", 400);
    }

    // Infer project metadata
    const projectMeta = zipService.inferProjectMetadata(files);

    // Create project document
    const project = new Project({
      userId: req.user.userId,
      sourceType: "zip",
      provider: "zip", // tracks provider for UI display
      repoUrl: `zip://${meta.checksum}`, // pseudo-URL for identification
      repoName: meta.name,
      repoOwner: "local",
      meta: {
        name: meta.name,
        language: projectMeta.language,
        description: `Uploaded ZIP project (${files.length} files)`,
        stars: 0,
        defaultBranch: "main",
        topics: projectMeta.techStack,
      },
      techStack: projectMeta.techStack,
      zipMetadata: {
        uploadedFilename: originalname,
        checksum: meta.checksum,
        uploadedAt: meta.uploadedAt,
        fileCount: files.length,
      },
      status: "queued",
    });

    // Save project to get ID for linking files
    await project.save();

    return ok(res, {
      id: project._id,
      name: project.repoName,
      status: "queued",
      sourceType: "zip",
      fileCount: files.length,
      language: projectMeta.language,
      techStack: projectMeta.techStack,
    });
  } catch (err) {
    if (err.message?.includes("ZIP")) {
      return fail(res, "INVALID_ZIP", zipService.formatZipError(err), 400);
    }
    return serverError(res, err, "uploadZipProject");
  }
}

// ── GET /projects/zip/validate ────────────────────────────────
// Validate a ZIP file without creating a project (useful for preview)
export async function validateZipUpload(req, res) {
  try {
    if (!req.file) {
      return fail(res, "NO_FILE", "No ZIP file uploaded", 400);
    }

    const { buffer, originalname } = req.file;

    // Validate and extract ZIP
    const { files, meta } = zipService.extractZipFiles(buffer, originalname);
    const projectMeta = zipService.inferProjectMetadata(files);

    return ok(res, {
      name: meta.name,
      fileCount: files.length,
      totalSize: meta.totalSize,
      language: projectMeta.language,
      techStack: projectMeta.techStack,
      sampleFiles: files.slice(0, 10).map((f) => f.path), // preview first 10 files
      isValid: files.length > 0,
    });
  } catch (err) {
    return fail(res, "INVALID_ZIP", zipService.formatZipError(err), 400);
  }
}
