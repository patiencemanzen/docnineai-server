// =============================================================
// ZIP Upload Controller
//
// Handles project creation from uploaded ZIP files.
// Files are extracted and processed through the standard pipeline.
// =============================================================

import { randomUUID } from "crypto";
import { Project } from "../../models/Project.js";
import { PlanUsage } from "../../models/PlanUsage.js";
import * as zipService from "../../services/zip-upload.service.js";
import * as projectService from "./project.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";
import { registerJob } from "../../services/job-registry.service.js";

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
      provider: "zip",
      repoUrl: `zip://${meta.checksum}`,
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
        extractedFiles: files, // Store files for pipeline processing
        totalSize: meta.totalSize,
      },
      status: "queued", // Queue for pipeline processing
      output: {
        readme: "",
        internalDocs: "",
        apiReference: "",
        schemaDocs: "",
        securityReport: "",
      },
      stats: {
        filesAnalysed: 0,
        endpoints: 0,
        models: 0,
        relationships: 0,
        components: 0,
      },
    });

    // Save project to get ID
    await project.save();

    // Track usage for plan gate checks
    await PlanUsage.increment(req.user.userId, { projectCount: 1 }).catch(
      () => {},
    );

    // Register job and start pipeline
    const jobId = randomUUID();
    project.jobId = jobId;
    project.status = "running"; // Move to running immediately
    await project.save();

    registerJob(jobId);

    // Fire-and-forget pipeline execution
    projectService
      .runZipPipeline({ project, jobId })
      .catch((err) =>
        console.error(`❌ ZIP Pipeline crash [${jobId}]:`, err.message),
      );

    return ok(
      res,
      {
        project: {
          _id: project._id,
          userId: project.userId,
          repoUrl: project.repoUrl,
          repoName: project.repoName,
          repoOwner: project.repoOwner,
          provider: project.provider,
          sourceType: project.sourceType,
          status: project.status,
          jobId: project.jobId,
          meta: project.meta,
          techStack: project.techStack,
          createdAt: project.createdAt,
        },
      },
      "ZIP project created and pipeline started.",
      202,
    );
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
      valid: files.length > 0,
      message:
        files.length > 0 ? "ZIP is valid" : "No valid files found in ZIP",
      stats: {
        files: files.length,
        totalSize: meta.totalSize,
        languages: [projectMeta.language].filter(Boolean),
      },
    });
  } catch (err) {
    return fail(res, "INVALID_ZIP", zipService.formatZipError(err), 400);
  }
}
