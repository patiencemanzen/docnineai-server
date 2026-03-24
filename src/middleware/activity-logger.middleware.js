/**
 * autoLog(action, getOpts?)
 *
 * Express middleware factory that fires an ActivityLog entry only when the
 * response is a 2xx success JSON response.  It does this by monkey-patching
 * `res.json` — the patch runs synchronously BEFORE the response is flushed,
 * so the action string and the response body are both available.
 *
 * Usage:
 *   router.post("/login", autoLog("AUTH_LOGIN", (req, body) => ({
 *     userId:     body.data?.user?._id,
 *     actorName:  body.data?.user?.name,
 *     actorEmail: body.data?.user?.email,
 *   })), loginController);
 *
 *   router.post("/logout", autoLog("AUTH_LOGOUT"), logoutController);
 *
 * - `getOpts` is called with (req, parsedBody) and should return a partial
 *   opts object that will be merged into the log call.  When omitted the
 *   middleware reads userId / actorName / actorEmail from req.user (set by
 *   the protect middleware).
 * - Always fire-and-forget — never blocks response delivery.
 */

import ActivityLogService from "../services/activity-log.service.js";

/**
 * @param {string} action
 * @param {(req: import('express').Request, body: any) => object} [getOpts]
 */
export function autoLog(action, getOpts) {
  return function activityLoggerMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = function patchedJson(body) {
      // Restore immediately so subsequent calls are unaffected
      res.json = originalJson;

      // Only log on success responses
      if (res.statusCode >= 200 && res.statusCode < 300 && body?.success !== false) {
        try {
          const overrides = typeof getOpts === "function" ? getOpts(req, body) : {};

          // Fall back to req.user when the response doesn't carry user identity
          // (covers all protect-guarded routes)
          const userId     = overrides.userId     ?? req.user?.userId;
          const actorName  = overrides.actorName  ?? req.user?.name  ?? "";
          const actorEmail = overrides.actorEmail ?? req.user?.email ?? "";

          if (userId) {
            ActivityLogService.log({
              userId,
              actorName,
              actorEmail,
              action,
              projectId:    overrides.projectId    ?? req.params?.id ?? undefined,
              projectName:  overrides.projectName  ?? "",
              resourceId:   overrides.resourceId   ?? "",
              resourceType: overrides.resourceType ?? "",
              metadata:     overrides.metadata     ?? {},
              req,
              ...( overrides.ipAddress ? { ipAddress: overrides.ipAddress } : {} ),
              ...( overrides.userAgent ? { userAgent: overrides.userAgent } : {} ),
            });
          }
        } catch {
          // Logging must never block or error-out the response
        }
      }

      return originalJson(body);
    };

    next();
  };
}
