import { randomBytes } from "crypto";
import { CliSession } from "../../models/CliSession.js";
import { User } from "../../models/User.js";
import { Subscription } from "../../models/Subscription.js";
import { signAccessToken, verifyRefreshToken } from "../../utils/jwt.util.js";
import { hashToken } from "../../utils/crypto.util.js";

const SESSION_TTL_MS = 10 * 60 * 1000;

function createError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function isValidSessionId(sessionId) {
  return /^[a-f0-9]{64}$/i.test(sessionId || "");
}

function isTimedOut(createdAt) {
  if (!createdAt) return true;
  return Date.now() - new Date(createdAt).getTime() > SESSION_TTL_MS;
}

async function getUserPlan(userId) {
  const sub = await Subscription.findOne({ userId }).select("plan").lean();
  return sub?.plan || "free";
}

async function markSessionExpired(session) {
  if (!session || session.status === "expired") return;
  session.status = "expired";
  await session.save();
}

export async function initCliSession({ userAgent, ipAddress, frontendBaseUrl }) {
  const sessionId = randomBytes(32).toString("hex");
  await CliSession.create({
    sessionId,
    status: "pending",
    userAgent: userAgent || null,
    ipAddress: ipAddress || null,
  });

  const baseUrl = (frontendBaseUrl || process.env.FRONTEND_URL || "https://docnineai.com")
    .replace(/\/$/, "");

  return {
    sessionId,
    loginUrl: `${baseUrl}/cli-auth?session=${sessionId}`,
  };
}

export async function pollCliSession(sessionId) {
  if (!isValidSessionId(sessionId)) {
    return { status: "expired" };
  }

  const session = await CliSession.findOne({ sessionId }).select("+cliToken");
  if (!session) return { status: "expired" };

  if (isTimedOut(session.createdAt)) {
    await markSessionExpired(session);
    return { status: "expired" };
  }

  if (session.status === "pending") return { status: "pending" };
  if (session.status === "cancelled" || session.status === "expired") {
    return { status: "expired" };
  }

  if (session.status !== "approved" || !session.userId || !session.cliToken) {
    return { status: "expired" };
  }

  const user = await User.findById(session.userId).select("email").lean();
  if (!user?.email) return { status: "expired" };

  const plan = await getUserPlan(session.userId);
  return {
    status: "approved",
    token: session.cliToken,
    user: {
      email: user.email,
      plan,
    },
  };
}

export async function authenticateCliApprover(refreshToken) {
  if (!refreshToken) {
    throw createError("A valid web session is required.", "NO_WEB_SESSION", 401);
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw createError("Web session is invalid or expired.", "INVALID_WEB_SESSION", 401);
  }

  const user = await User.findById(payload.sub).select("+refreshTokenHash");
  if (!user || !user.refreshTokenHash) {
    throw createError("Web session is invalid or expired.", "INVALID_WEB_SESSION", 401);
  }

  if (user.refreshTokenHash !== hashToken(refreshToken)) {
    throw createError("Web session is invalid or expired.", "INVALID_WEB_SESSION", 401);
  }

  return user;
}

export async function approveCliSession({ sessionId, userId }) {
  if (!isValidSessionId(sessionId)) {
    throw createError("Session is invalid.", "CLI_SESSION_INVALID", 400);
  }

  const session = await CliSession.findOne({ sessionId }).select("+cliToken");
  if (!session) {
    throw createError("Session has expired.", "CLI_SESSION_EXPIRED", 410);
  }

  if (isTimedOut(session.createdAt)) {
    await markSessionExpired(session);
    throw createError("Session has expired.", "CLI_SESSION_EXPIRED", 410);
  }

  if (session.status === "cancelled" || session.status === "expired") {
    throw createError("Session has expired.", "CLI_SESSION_EXPIRED", 410);
  }

  if (session.status === "approved") {
    if (!session.userId || String(session.userId) !== String(userId)) {
      throw createError(
        "This session is already approved by another account.",
        "CLI_SESSION_ALREADY_APPROVED",
        409,
      );
    }
    return;
  }

  const user = await User.findById(userId).select("email role").lean();
  if (!user?.email) {
    throw createError("User not found.", "USER_NOT_FOUND", 404);
  }

  const cliToken = signAccessToken(
    {
      userId: userId.toString(),
      email: user.email,
      role: user.role ?? "user",
    },
    { expiresIn: "90d" },
  );

  session.status = "approved";
  session.userId = userId;
  session.cliToken = cliToken;
  await session.save();
}

export async function cancelCliSession(sessionId) {
  if (!isValidSessionId(sessionId)) return;

  const session = await CliSession.findOne({ sessionId });
  if (!session) return;

  if (isTimedOut(session.createdAt)) {
    await markSessionExpired(session);
    return;
  }

  if (session.status === "pending") {
    session.status = "cancelled";
    await session.save();
  }
}
