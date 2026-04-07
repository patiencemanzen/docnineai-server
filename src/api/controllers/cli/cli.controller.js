import * as cliService from "../../services/cli/cli.service.js";
import { ok, fail, serverError } from "../../../utils/response.util.js";

function toDomainFail(res, err, context) {
  if (err?.code && err?.status) {
    return fail(res, err.code, err.message, err.status);
  }
  return serverError(res, err, context);
}

export async function generate(req, res) {
  const { files, projectId, agentsOnly = [] } = req.body || {};
  try {
    const result = await cliService.generateFromCli({
      userId: req.user.userId,
      projectId,
      files,
      agentsOnly,
    });
    return ok(res, result, "CLI generation completed.");
  } catch (err) {
    return toDomainFail(res, err, "cli.generate");
  }
}

export async function chat(req, res) {
  const { projectId, question } = req.body || {};
  try {
    const result = await cliService.chatFromCli({
      userId: req.user.userId,
      projectId,
      question,
    });
    return ok(res, result, "CLI chat response.");
  } catch (err) {
    return toDomainFail(res, err, "cli.chat");
  }
}

export async function diff(req, res) {
  const { id: projectId } = req.params;
  const { since } = req.query;
  try {
    const result = await cliService.diffFromCli({
      userId: req.user.userId,
      projectId,
      since,
    });
    return ok(res, result, "CLI diff loaded.");
  } catch (err) {
    return toDomainFail(res, err, "cli.diff");
  }
}

export async function exportDoc(req, res) {
  const { id: projectId } = req.params;
  const format = String(req.query.format || "openapi").toLowerCase();
  try {
    const result = await cliService.exportFromCli({
      userId: req.user.userId,
      projectId,
      format,
    });
    return ok(res, result, "CLI export loaded.");
  } catch (err) {
    return toDomainFail(res, err, "cli.export");
  }
}

