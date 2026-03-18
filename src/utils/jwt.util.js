// ===================================================================
// Two-token strategy:
//   Access token  — 2 days, signed with JWT_ACCESS_SECRET
//                   sent in response body, stored in memory by client
//   Refresh token — 14 days, signed with JWT_REFRESH_SECRET
//                   sent as httpOnly Secure cookie
//                   hash stored in User.refreshTokenHash for revocation
//
// Extended from 15min/7days to support 2-day user sessions.
// Refresh token can be silently renewed on API calls without user interaction.
//
// WHY lazy env reads (no module-level constants for secrets):
//   In ESM, every `import` is resolved and evaluated BEFORE the calling
//   module's body runs. This means dotenv.config() in server.js fires
//   AFTER this module is evaluated — so module-level process.env reads
//   always see undefined for .env file values.
//   Reading inside functions defers evaluation to call-time, after dotenv.
// ===================================================================

import jwt from "jsonwebtoken";

const ACCESS_TTL = "2d"; // Extended from 15m to 2 days
const REFRESH_TTL = "14d"; // Extended from 7d to 14 days

// ── Internal helpers ──────────────────────────────────────────

/** Read and validate JWT secrets at call-time (after dotenv.config). */
function getSecrets() {
  const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
  const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

  if (!ACCESS_SECRET || !REFRESH_SECRET) {
    throw new Error("JWT secrets not configured.");
  }

  return { ACCESS_SECRET, REFRESH_SECRET };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Sign an access token.
 * @param {{ userId: string, email: string }} payload
 * @param {{ expiresIn?: string }} [options]
 * @returns {string} signed JWT
 */
export function signAccessToken(payload, options = {}) {
  const { ACCESS_SECRET } = getSecrets();
  const expiresIn = options.expiresIn || ACCESS_TTL;
  return jwt.sign(
    { sub: payload.userId, email: payload.email, role: payload.role ?? "user" },
    ACCESS_SECRET,
    { expiresIn },
  );
}

/**
 * Sign a refresh token.
 * @param {{ userId: string }} payload
 * @returns {string} signed JWT
 */
export function signRefreshToken(payload) {
  const { REFRESH_SECRET } = getSecrets();
  return jwt.sign({ sub: payload.userId }, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL,
  });
}

/**
 * Verify an access token.
 * @param {string} token
 * @returns {{ sub: string, email: string, iat: number, exp: number }}
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyAccessToken(token) {
  const { ACCESS_SECRET } = getSecrets();
  return jwt.verify(token, ACCESS_SECRET);
}

/**
 * Verify a refresh token.
 * @param {string} token
 * @returns {{ sub: string, iat: number, exp: number }}
 * @throws {jwt.JsonWebTokenError | jwt.TokenExpiredError}
 */
export function verifyRefreshToken(token) {
  const { REFRESH_SECRET } = getSecrets();
  return jwt.verify(token, REFRESH_SECRET);
}

/**
 * Cookie options for the refresh token.
 * Returns a new object each time so callers can safely mutate (e.g. clearCookie).
 * `secure` and `sameSite` are read at call-time so NODE_ENV works correctly after dotenv.
 *
 * WHY sameSite differs per environment:
 *   In production the frontend and backend are on different Vercel domains
 *   (cross-origin). The SameSite=Strict policy prevents the browser from
 *   attaching the cookie to any cross-site request, so POST /auth/refresh
 *   never receives the cookie and every page-refresh logs the user out.
 *   SameSite=None + Secure=true is the correct configuration for httpOnly
 *   cookies that must be sent in authenticated cross-origin API calls.
 *
 *   In development everything is proxied through Vite on localhost (same
 *   origin), so SameSite=Strict is safe and Secure is unnecessary.
 */
export function getRefreshCookieOpts() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "strict",
    maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days in ms (extended from 7 days to support 2-day sessions)
    path: "/auth", // cookie only sent to /auth/* routes
  };
}

/**
 * @deprecated Use getRefreshCookieOpts() — kept for any code referencing this name.
 * Will be removed in a future cleanup.
 */
export const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: false, // conservative default; getRefreshCookieOpts() reads env correctly
  sameSite: "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/auth",
};
