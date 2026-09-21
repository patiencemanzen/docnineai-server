
import { verifyAccessToken, isTokenDenylisted } from "../utils/jwt.util.js";
import { fail } from "../utils/response.util.js";
import { authenticateAPIToken } from "./token-auth.middleware.js";
import { User } from "../models/User.js";


export async function protect(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return fail(
      res,
      "NO_TOKEN",
      "Failed to authenticate. Session must be expired or missing.",
      401,
    );
  }

  const token = header.slice(7).trim();


  if (token.startsWith("docnine_")) {
    return authenticateAPIToken(req, res, next);
  }

  try {
    const payload = verifyAccessToken(token);


    const revoked = await isTokenDenylisted(token);
    if (revoked) {
      return fail(res, "TOKEN_REVOKED", "Session has been revoked. Run: docnine login", 401);
    }

    req.user = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role ?? "user",
    };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return fail(
        res,
        "TOKEN_EXPIRED",
        "Access token has expired. Use POST /auth/refresh.",
        401,
      );
    }
    return fail(
      res,
      "INVALID_TOKEN",
      "Access token is invalid or malformed.",
      401,
    );
  }
}


export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return next();

  const token = header.slice(7).trim();
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role ?? "user",
    };
  } catch {

  }
  next();
}


export function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      if (!req.user?.userId) {
        return fail(
          res,
          "FORBIDDEN",
          "You do not have permission to access this resource.",
          403,
        );
      }
      const user = await User.findById(req.user.userId).select("role").lean();
      if (!user || !roles.includes(user.role)) {
        return fail(
          res,
          "FORBIDDEN",
          "You do not have permission to access this resource.",
          403,
        );
      }
      req.user.role = user.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
