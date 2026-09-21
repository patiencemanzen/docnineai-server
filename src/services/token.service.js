

import { APIToken } from "../models/APIToken.js";
import { hashToken } from "../utils/crypto.util.js";


export async function createToken(
  userId,
  { name, description, scope, projectIds, expiresAt },
) {
  if (!name) {
    const err = new Error("Token name is required");
    err.code = "INVALID_TOKEN_NAME";
    err.status = 400;
    throw err;
  }

  const { plainToken, tokenHash, lastChars } = APIToken.generateToken();

  const token = await APIToken.create({
    userId,
    name,
    description,
    tokenHash,
    lastChars,
    scope: scope || ["api"],
    projectIds: projectIds || [],
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });

  return {
    id: token._id,
    plainToken,
    name: token.name,
    lastChars: token.lastChars,
    scope: token.scope,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
  };
}


export async function getTokens(userId, { includeRevoked = false } = {}) {
  const query = { userId };
  if (!includeRevoked) query.isRevoked = false;

  const tokens = await APIToken.find(query)
    .select("-tokenHash")
    .sort({ createdAt: -1 });

  return tokens.map((t) => t.toSafeJSON());
}


export async function getToken(userId, tokenId) {
  const token = await APIToken.findOne({
    _id: tokenId,
    userId,
  }).select("-tokenHash");

  if (!token) {
    const err = new Error("Token not found");
    err.code = "TOKEN_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  return token.toSafeJSON();
}


export async function revokeToken(userId, tokenId) {
  const token = await APIToken.findOne({
    _id: tokenId,
    userId,
  });

  if (!token) {
    const err = new Error("Token not found");
    err.code = "TOKEN_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  if (token.isRevoked) {
    const err = new Error("Token is already revoked");
    err.code = "ALREADY_REVOKED";
    err.status = 400;
    throw err;
  }

  token.isRevoked = true;
  token.revokedAt = new Date();
  await token.save();

  return token.toSafeJSON();
}


export async function deleteToken(userId, tokenId) {
  const result = await APIToken.deleteOne({
    _id: tokenId,
    userId,
  });

  if (result.deletedCount === 0) {
    const err = new Error("Token not found");
    err.code = "TOKEN_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  return { deleted: true };
}


export async function validateToken(plainToken, options = {}) {
  if (!plainToken) {
    const err = new Error("Token is required");
    err.code = "TOKEN_REQUIRED";
    err.status = 401;
    throw err;
  }


  if (!plainToken.startsWith("docnine_")) {
    const err = new Error("Invalid token format");
    err.code = "INVALID_TOKEN";
    err.status = 401;
    throw err;
  }

  const tokenHash = hashToken(plainToken);
  const token = await APIToken.findOne({ tokenHash }).populate("userId");

  if (!token) {
    const err = new Error("Invalid token");
    err.code = "INVALID_TOKEN";
    err.status = 401;
    throw err;
  }

  if (!token.isValid()) {
    const err = new Error("Token is revoked or expired");
    err.code = "TOKEN_INVALID";
    err.status = 401;
    throw err;
  }


  if (options.ipAddress && token.ipWhitelist?.length > 0) {
    if (!token.ipWhitelist.includes(options.ipAddress)) {
      const err = new Error("IP address not whitelisted");
      err.code = "IP_NOT_WHITELISTED";
      err.status = 403;
      throw err;
    }
  }


  await token.recordUsage(options.ipAddress);

  return {
    token: token._id,
    userId: token.userId._id,
    user: token.userId,
    scope: token.scope,
    projectIds: token.projectIds,
  };
}


export async function checkProjectAccess(tokenId, projectId) {
  const token = await APIToken.findById(tokenId);

  if (!token || !token.isValid()) {
    return false;
  }

  return token.hasProjectAccess(projectId);
}


export async function cleanupExpiredTokens() {
  const result = await APIToken.deleteMany({
    expiresAt: { $lt: new Date() },
  });

  return {
    deletedCount: result.deletedCount,
  };
}


export async function getTokenStats(userId) {
  const [total, active, revoked, expiringSoon] = await Promise.all([
    APIToken.countDocuments({ userId }),
    APIToken.countDocuments({ userId, isRevoked: false, expiresAt: null }),
    APIToken.countDocuments({ userId, isRevoked: true }),
    APIToken.countDocuments({
      userId,
      isRevoked: false,
      expiresAt: {
        $gt: new Date(),
        $lt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    }),
  ]);

  return {
    total,
    active,
    revoked,
    expiringSoon,
  };
}
