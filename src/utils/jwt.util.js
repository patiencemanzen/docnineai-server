import jwt from "jsonwebtoken";

const ACCESS_TTL = "2d";
const REFRESH_TTL = "14d";

function getSecrets() {
  const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
  const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

  if (!ACCESS_SECRET || !REFRESH_SECRET) {
    throw new Error("JWT secrets not configured.");
  }

  return { ACCESS_SECRET, REFRESH_SECRET };
}

export function signAccessToken(payload, options = {}) {
  const { ACCESS_SECRET } = getSecrets();
  const expiresIn = options.expiresIn || ACCESS_TTL;
  return jwt.sign(
    { sub: payload.userId, email: payload.email, role: payload.role ?? "user" },
    ACCESS_SECRET,
    { expiresIn, algorithm: "HS256" },
  );
}

export function signRefreshToken(payload) {
  const { REFRESH_SECRET } = getSecrets();
  return jwt.sign({ sub: payload.userId }, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token) {
  const { ACCESS_SECRET } = getSecrets();
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ["HS256"] });
}

export function verifyRefreshToken(token) {
  const { REFRESH_SECRET } = getSecrets();
  return jwt.verify(token, REFRESH_SECRET, { algorithms: ["HS256"] });
}

export function getRefreshCookieOpts() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "strict",
    maxAge: 14 * 24 * 60 * 60 * 1000,
    path: "/auth",
  };
}

import { createHash } from "crypto";
import { getRedis, isRedisAvailable } from "../config/redis.js";

if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) {
  console.warn(
    "[jwt] WARNING: REDIS_URL is not set. Token revocation (logout/CLI logout) " +
      "is NOT enforced server-side. Set REDIS_URL in production.",
  );
}

const DENYLIST_PREFIX = "token:deny:";

function tokenKey(token) {
  const hash = createHash("sha256").update(token).digest("hex");
  return `${DENYLIST_PREFIX}${hash}`;
}

export async function denylistToken(token) {
  if (!isRedisAvailable()) return;
  try {
    const { ACCESS_SECRET } = getSecrets();
    const payload = jwt.decode(token);
    const ttlSeconds = payload?.exp
      ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
      : 172800;
    if (ttlSeconds > 0) {
      await getRedis().set(tokenKey(token), "1", "EX", ttlSeconds);
    }
  } catch {}
}

export async function isTokenDenylisted(token) {
  if (!isRedisAvailable()) return false;
  try {
    const result = await getRedis().get(tokenKey(token));
    return result === "1";
  } catch {
    return false;
  }
}
