import * as cliService from "./cli.service.js";
import { ok, fail, serverError } from "../../utils/response.util.js";

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

