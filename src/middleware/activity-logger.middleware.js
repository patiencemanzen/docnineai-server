

import ActivityLogService from "../services/activity-log.service.js";


export function autoLog(action, getOpts) {
  return function activityLoggerMiddleware(req, res, next) {
    const originalJson = res.json.bind(res);

    res.json = function patchedJson(body) {

      res.json = originalJson;


      if (res.statusCode >= 200 && res.statusCode < 300 && body?.success !== false) {
        try {
          const overrides = typeof getOpts === "function" ? getOpts(req, body) : {};


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

        }
      }

      return originalJson(body);
    };

    next();
  };
}
