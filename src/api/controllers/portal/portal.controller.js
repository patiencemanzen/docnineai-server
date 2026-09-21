
import { ok, fail, serverError } from "../../../utils/response.util.js";
import * as portalService from "../../services/portal/portal.service.js";




export async function getOwnerPortal(req, res) {
  try {
    const portal = await portalService.getPortalForOwner(
      req.params.id,
      req.user.userId,
    );
    return ok(res, { portal });
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getOwnerPortal");
  }
}


export async function upsertPortal(req, res) {
  try {
    const portal = await portalService.updatePortal(
      req.params.id,
      req.user.userId,
      req.body,
    );
    return ok(res, { portal }, "Portal settings saved.");
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "upsertPortal");
  }
}


export async function togglePublish(req, res) {
  try {
    const portal = await portalService.togglePublish(
      req.params.id,
      req.user.userId,
    );
    const msg = portal.isPublished
      ? "Portal published."
      : "Portal unpublished.";
    return ok(res, { portal }, msg);
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "togglePublish");
  }
}




export async function getPublicPortal(req, res) {
  try {
    const data = await portalService.getPublicPortal(req.params.slug);


    if (data.portal.accessMode === "password") {
      const provided = req.headers["x-portal-password"];
      if (!provided) {

        return ok(res, {
          portal: data.portal,
          project: data.project,
          protected: true,
          content: null,
          sectionVisibility: null,
        });
      }
      const valid = await portalService.verifyPortalPassword(
        req.params.slug,
        provided,
      );
      if (!valid) {
        return fail(res, "INVALID_PASSWORD", "Incorrect portal password.", 401);
      }
    }

    return ok(res, { ...data, protected: false });
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "getPublicPortal");
  }
}


export async function authPortal(req, res) {
  try {
    const { password } = req.body;
    if (!password)
      return fail(res, "MISSING_PASSWORD", "Password is required.", 400);
    const valid = await portalService.verifyPortalPassword(
      req.params.slug,
      password,
    );
    if (!valid)
      return fail(res, "INVALID_PASSWORD", "Incorrect portal password.", 401);
    return ok(res, { valid: true }, "Password verified.");
  } catch (err) {
    if (err.status) return fail(res, err.code, err.message, err.status);
    return serverError(res, err, "authPortal");
  }
}
