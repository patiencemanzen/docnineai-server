
import { User } from "../../../models/User.js";
import { randomBytes } from "crypto";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../../utils/jwt.util.js";
import { hashToken, generateSecureToken } from "../../../utils/crypto.util.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../../../config/email.js";
import { generateGitHubActionsWorkflow } from "../../../services/webhook.service.js";


export async function signup({ name, email, password, agreeToTerms = false }) {

  if (!agreeToTerms) {
    const err = new Error("You must agree to the Terms of Service and Privacy Policy.");
    err.code = "T_AND_C_REQUIRED";
    err.status = 422;
    throw err;
  }
  const existing = await User.findOne({ email });
  if (existing) {
    const err = new Error("An account with this email already exists.");
    err.code = "EMAIL_TAKEN";
    err.status = 409;
    throw err;
  }


  const rawToken = generateSecureToken();
  const hashedToken = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const user = await User.create({
    name,
    email,
    password,
    emailVerificationToken: hashedToken,
    emailVerificationExpires: expiresAt,
    webhookSecret: randomBytes(32).toString("hex"),
  });


  sendVerificationEmail({ to: email, token: rawToken, name }).catch((err) =>
    console.error("Failed to send verification email:", err.message),
  );

  return { user };
}


export async function login({ email, password }) {

  const user = await User.findOne({ email }).select("+password");


  const invalidErr = () => {
    const e = new Error("Incorrect email or password.");
    e.code = "INVALID_CREDENTIALS";
    e.status = 401;
    return e;
  };

  if (!user) throw invalidErr();

  let match;
  try {
    match = await user.comparePassword(password);
  } catch (e) {
    if (e.message === "PASSWORD_LOGIN_NOT_AVAILABLE") {
      const providerName = user.provider === "github" ? "GitHub" : "Google";
      const oauthErr = new Error(
        `This account was created with ${providerName}. Please use "Continue with ${providerName}" to sign in.`,
      );
      oauthErr.code = "USE_OAUTH_PROVIDER";
      oauthErr.status = 400;
      throw oauthErr;
    }
    throw e;
  }
  if (!match) throw invalidErr();

  if (!user.isEmailVerified && user.provider === "email") {
    const e = new Error("Please verify your email before signing in.");
    e.code = "EMAIL_NOT_VERIFIED";
    e.status = 403;
    throw e;
  }

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}




export async function logout(userId) {
  await User.findByIdAndUpdate(userId, { $unset: { refreshTokenHash: 1 } });
}




export async function refreshSession(rawRefreshToken) {
  if (!rawRefreshToken) {
    const err = new Error("Refresh token is required.");
    err.code = "NO_REFRESH_TOKEN";
    err.status = 401;
    throw err;
  }


  let payload;
  try {
    payload = verifyRefreshToken(rawRefreshToken);
  } catch {
    const err = new Error(
      "Refresh token is invalid or has expired. Please log in again.",
    );
    err.code = "INVALID_REFRESH_TOKEN";
    err.status = 401;
    throw err;
  }


  const user = await User.findById(payload.sub).select("+refreshTokenHash");

  const storedHash = user?.refreshTokenHash;
  const incomingHash = hashToken(rawRefreshToken);

  if (!user || storedHash !== incomingHash) {

    if (user) {
      user.refreshTokenHash = undefined;
      await user.save();
    }
    const err = new Error(
      "Refresh token has already been used or revoked. Please log in again.",
    );
    err.code = "REFRESH_TOKEN_REUSED";
    err.status = 401;
    throw err;
  }


  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}




export async function verifyEmail(rawToken) {
  const hashedToken = hashToken(rawToken);

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: new Date() },
  }).select("+emailVerificationToken +emailVerificationExpires");

  if (!user) {
    const err = new Error("Email verification link is invalid or has expired.");
    err.code = "INVALID_VERIFICATION_TOKEN";
    err.status = 400;
    throw err;
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  return user;
}




export async function forgotPassword(email) {
  const user = await User.findOne({ email });
  if (!user) return;

  const rawToken = generateSecureToken();
  const hashedToken = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = expiresAt;
  await user.save();

  sendPasswordResetEmail({ to: email, token: rawToken, name: user.name }).catch(
    (err) =>
      console.error("⚠️  Failed to send password-reset email:", err.message),
  );
}




export async function resetPassword({ token, password }) {
  const hashedToken = hashToken(token);

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetToken +passwordResetExpires +password");

  if (!user) {
    const err = new Error("Password reset link is invalid or has expired.");
    err.code = "INVALID_RESET_TOKEN";
    err.status = 400;
    throw err;
  }

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  user.refreshTokenHash = undefined;
  await user.save();

  return user;
}




export async function updateProfile(userId, { name, email }) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found.");
    err.code = "USER_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  if (email && email !== user.email) {
    const existing = await User.findOne({ email, _id: { $ne: userId } });
    if (existing) {
      const err = new Error("This email address is already in use.");
      err.code = "EMAIL_TAKEN";
      err.status = 409;
      throw err;
    }
  }

  if (name !== undefined) user.name = name;
  if (email !== undefined && email !== user.email) {
    user.email = email;
    user.isEmailVerified = false;
    const rawToken = generateSecureToken();
    user.emailVerificationToken = hashToken(rawToken);
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    sendVerificationEmail({ to: email, token: rawToken, name: user.name }).catch(
      (err) => console.error("Failed to send verification email:", err.message),
    );
  }
  await user.save();
  return user;
}




export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await User.findById(userId).select("+password");
  if (!user) {
    const err = new Error("User not found.");
    err.code = "USER_NOT_FOUND";
    err.status = 404;
    throw err;
  }

  const match = await user.comparePassword(currentPassword);
  if (!match) {
    const err = new Error("Current password is incorrect.");
    err.code = "INVALID_CREDENTIALS";
    err.status = 401;
    throw err;
  }

  user.password = newPassword;
  user.refreshTokenHash = undefined;
  await user.save();
  return user;
}




export async function getMe(userId) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error("User not found.");
    err.code = "USER_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  return user;
}


function attachOAuthIdentity(user, { idField, idValue, usernameField, usernameValue }) {
  if (user[idField] && String(user[idField]) !== String(idValue)) {
    const err = new Error("This email is already associated with a different account.");
    err.code = "OAUTH_EMAIL_CONFLICT";
    err.status = 409;
    throw err;
  }

  if (!user[idField] && user.provider === "email" && !user.isEmailVerified) {
    const err = new Error(
      "An account with this email already exists. Verify your email and sign in with your password first.",
    );
    err.code = "OAUTH_UNVERIFIED_ACCOUNT";
    err.status = 409;
    throw err;
  }

  let changed = false;
  if (!user[idField]) {
    user[idField] = String(idValue);
    if (usernameField) user[usernameField] = usernameValue;
    changed = true;
  }
  return changed;
}




export async function githubSocialLogin(code) {
  const { GITHUB_LOGIN_CLIENT_ID, GITHUB_LOGIN_CLIENT_SECRET } = process.env;
  if (!GITHUB_LOGIN_CLIENT_ID || !GITHUB_LOGIN_CLIENT_SECRET) {
    const err = new Error(
      "GitHub Login requires GITHUB_LOGIN_CLIENT_ID and GITHUB_LOGIN_CLIENT_SECRET.",
    );
    err.code = "GITHUB_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }

  const { default: axios } = await import("axios");


  const tokenRes = await axios.post(
    "https://github.com/login/oauth/access_token",
    {
      client_id: GITHUB_LOGIN_CLIENT_ID,
      client_secret: GITHUB_LOGIN_CLIENT_SECRET,
      code,
    },
    { headers: { Accept: "application/json" } },
  );

  const githubAccessToken = tokenRes.data.access_token;
  if (!githubAccessToken) {
    const err = new Error(
      "GitHub did not return an access token. The code may have expired.",
    );
    err.code = "GITHUB_CODE_INVALID";
    err.status = 400;
    throw err;
  }

  const ghHeaders = { Authorization: `Bearer ${githubAccessToken}` };


  const [userRes, emailsRes] = await Promise.all([
    axios.get("https://api.github.com/user", { headers: ghHeaders }),
    axios.get("https://api.github.com/user/emails", { headers: ghHeaders }),
  ]);

  const ghUser = userRes.data;
  const primaryEmail = emailsRes.data.find(
    (e) => e.primary && e.verified,
  )?.email;

  if (!primaryEmail) {
    const err = new Error(
      "No verified primary email found on your GitHub account.",
    );
    err.code = "GITHUB_NO_EMAIL";
    err.status = 400;
    throw err;
  }


  let user = await User.findOne({
    $or: [{ githubId: String(ghUser.id) }, { email: primaryEmail }],
  });

  if (!user) {
    user = await User.create({
      name: ghUser.name || ghUser.login,
      email: primaryEmail,
      provider: "github",
      githubId: String(ghUser.id),
      githubUsername: ghUser.login,
      isEmailVerified: true,
      webhookSecret: randomBytes(32).toString("hex"),
    });
  } else {
    const changed = attachOAuthIdentity(user, {
      idField: "githubId",
      idValue: ghUser.id,
      usernameField: "githubUsername",
      usernameValue: ghUser.login,
    });
    if (changed) await user.save();
  }

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}




export async function googleSocialLogin(code) {
  const {
    GOOGLE_LOGIN_CLIENT_ID,
    GOOGLE_LOGIN_CLIENT_SECRET,
    GOOGLE_LOGIN_REDIRECT_URI,
  } = process.env;

  if (
    !GOOGLE_LOGIN_CLIENT_ID ||
    !GOOGLE_LOGIN_CLIENT_SECRET ||
    !GOOGLE_LOGIN_REDIRECT_URI
  ) {
    const err = new Error(
      "Google Login requires GOOGLE_LOGIN_CLIENT_ID, GOOGLE_LOGIN_CLIENT_SECRET, " +
        "and GOOGLE_LOGIN_REDIRECT_URI.",
    );
    err.code = "GOOGLE_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }

  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_LOGIN_CLIENT_ID,
    GOOGLE_LOGIN_CLIENT_SECRET,
    GOOGLE_LOGIN_REDIRECT_URI,
  );

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: profile } = await oauth2.userinfo.get();

  if (!profile.email || !profile.verified_email) {
    const err = new Error("No verified email found on your Google account.");
    err.code = "GOOGLE_NO_EMAIL";
    err.status = 400;
    throw err;
  }

  let user = await User.findOne({
    $or: [{ googleId: profile.id }, { email: profile.email }],
  });

  if (!user) {
    user = await User.create({
      name: profile.name,
      email: profile.email,
      provider: "google",
      googleId: profile.id,
      googleUsername: profile.name,
      isEmailVerified: true,
      webhookSecret: randomBytes(32).toString("hex"),
    });
  } else {
    const changed = attachOAuthIdentity(user, {
      idField: "googleId",
      idValue: profile.id,
      usernameField: "googleUsername",
      usernameValue: profile.name,
    });
    if (changed) await user.save();
  }

  const { accessToken, refreshToken } = await issueTokens(user);
  return { user, accessToken, refreshToken };
}



export function getGithubLoginUrl() {
  const { GITHUB_LOGIN_CLIENT_ID, GITHUB_LOGIN_REDIRECT_URI } = process.env;
  if (!GITHUB_LOGIN_CLIENT_ID) {
    const err = new Error("GITHUB_LOGIN_CLIENT_ID not configured.");
    err.code = "GITHUB_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: GITHUB_LOGIN_CLIENT_ID,
    scope: "read:user user:email",
    ...(GITHUB_LOGIN_REDIRECT_URI
      ? { redirect_uri: GITHUB_LOGIN_REDIRECT_URI }
      : {}),
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export function getGoogleLoginUrl() {
  const { GOOGLE_LOGIN_CLIENT_ID, GOOGLE_LOGIN_REDIRECT_URI } = process.env;
  if (!GOOGLE_LOGIN_CLIENT_ID || !GOOGLE_LOGIN_REDIRECT_URI) {
    const err = new Error("Google Login env vars not configured.");
    err.code = "GOOGLE_LOGIN_NOT_CONFIGURED";
    err.status = 503;
    throw err;
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_LOGIN_CLIENT_ID,
    redirect_uri: GOOGLE_LOGIN_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}




async function issueTokens(user) {
  const accessToken = signAccessToken({
    userId: user._id.toString(),
    email: user.email,
    role: user.role ?? "user",
  });
  const refreshToken = signRefreshToken({ userId: user._id.toString() });

  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  return { accessToken, refreshToken };
}




function resolveApiBaseUrl(apiBaseUrl) {
  return (
    apiBaseUrl ||
    process.env.APP_URL ||
    process.env.APP_URL ||
    "https://your-docnine-instance.com"
  ).replace(/\/$/, "");
}

function buildWebhookSettings(user, apiBaseUrl) {
  const backendBase = resolveApiBaseUrl(apiBaseUrl);
  const webhookUrl = `${backendBase}/webhook/github`;

  return {
    webhookUrl,
    secret: user.webhookSecret,
    webhookEnabled: user.webhookEnabled,
    lastWebhookAt: user.lastWebhookAt || null,
    lastWebhookStatus: user.lastWebhookStatus || null,
    yaml: generateGitHubActionsWorkflow(backendBase),
  };
}

export async function getWebhookStatus(userId) {
  const user = await User.findById(userId).select("+webhookSecret");
  if (!user) throw new Error("User not found");

  return {
    webhookEnabled: user.webhookEnabled,
    hasSecret: !!user.webhookSecret,
    lastWebhookAt: user.lastWebhookAt || null,
    lastWebhookStatus: user.lastWebhookStatus || null,
  };
}


export async function getOrInitializeWebhook(userId, apiBaseUrl) {
  const user = await User.findById(userId).select("+webhookSecret");
  if (!user) throw new Error("User not found");

  if (!user.webhookSecret) {
    user.webhookSecret = randomBytes(32).toString("hex");
    await user.save();
  }

  return buildWebhookSettings(user, apiBaseUrl);
}


export async function rotateWebhookSecret(userId, apiBaseUrl) {
  const user = await User.findById(userId).select("+webhookSecret");
  if (!user) throw new Error("User not found");

  user.webhookSecret = randomBytes(32).toString("hex");
  await user.save();

  return buildWebhookSettings(user, apiBaseUrl);
}


export async function updateWebhookSettings(
  userId,
  webhookEnabled,
  apiBaseUrl,
) {
  const user = await User.findById(userId).select("+webhookSecret");
  if (!user) throw new Error("User not found");

  user.webhookEnabled = webhookEnabled;
  await user.save();

  const backendBase = resolveApiBaseUrl(apiBaseUrl);
  const webhookUrl = `${backendBase}/webhook/github`;

  return {
    webhookUrl,
    webhookEnabled: user.webhookEnabled,
    hasSecret: !!user.webhookSecret,
    lastWebhookAt: user.lastWebhookAt || null,
    lastWebhookStatus: user.lastWebhookStatus || null,
    yaml: generateGitHubActionsWorkflow(backendBase),
  };
}
