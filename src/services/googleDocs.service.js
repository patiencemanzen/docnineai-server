import { google } from "googleapis";
import { createHmac, timingSafeEqual } from "crypto";
import { encrypt, decrypt } from "../utils/crypto.util.js";
import GoogleToken from "../models/GoogleToken.js";

const STATE_TTL_MS = 10 * 60 * 1000;

function getStateSecret() {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("JWT_ACCESS_SECRET or ENCRYPTION_KEY must be set");
  }
  return secret;
}

function buildSignedState(userId) {
  const ts = Date.now();
  const payload = `${userId}:${ts}`;
  const sig = createHmac("sha256", getStateSecret()).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ u: String(userId), ts, sig })).toString("base64url");
}

export function verifySignedState(stateParam) {
  try {
    const { u, ts, sig } = JSON.parse(Buffer.from(stateParam, "base64url").toString("utf8"));
    if (!u || !ts || !sig) return null;
    if (Date.now() - ts > STATE_TTL_MS) return null;
    const expected = createHmac("sha256", getStateSecret()).update(`${u}:${ts}`).digest("hex");
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return u;
  } catch {
    return null;
  }
}

function makeOAuth2Client() {
  const { GOOGLE_DOCS_CLIENT_ID, GOOGLE_DOCS_CLIENT_SECRET, GOOGLE_DOCS_REDIRECT_URI } =
    process.env;
  if (!GOOGLE_DOCS_CLIENT_ID || !GOOGLE_DOCS_CLIENT_SECRET || !GOOGLE_DOCS_REDIRECT_URI) {
    throw new Error(
      "Google Docs export requires GOOGLE_DOCS_CLIENT_ID, GOOGLE_DOCS_CLIENT_SECRET, " +
        "and GOOGLE_DOCS_REDIRECT_URI in the environment.",
    );
  }
  return new google.auth.OAuth2(
    GOOGLE_DOCS_CLIENT_ID,
    GOOGLE_DOCS_CLIENT_SECRET,
    GOOGLE_DOCS_REDIRECT_URI,
  );
}

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export function getGoogleDocsOAuthUrl(userId) {
  const oauth2Client = makeOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: buildSignedState(userId),
  });
}

export async function handleGoogleDocsCallback(code, userId) {
  const oauth2Client = makeOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    const existing = await GoogleToken.findOne({ userId }).select(
      "+accessTokenEncrypted +refreshTokenEncrypted",
    );
    if (!existing) {
      throw new Error(
        "No refresh_token received and no prior token stored. " +
          "Please revoke app access in Google and reconnect.",
      );
    }

    existing.accessTokenEncrypted = encrypt(tokens.access_token);
    existing.expiryDate = tokens.expiry_date ?? Date.now() + 3600 * 1000;
    await existing.save();
    return existing;
  }

  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: profile } = await oauth2.userinfo.get();

  const doc = await GoogleToken.findOneAndUpdate(
    { userId },
    {
      accessTokenEncrypted: encrypt(tokens.access_token),
      refreshTokenEncrypted: encrypt(tokens.refresh_token),
      expiryDate: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      scopes: tokens.scope ? tokens.scope.split(" ") : SCOPES,
      googleUserId: profile.id,
      googleEmail: profile.email,
      googleName: profile.name,
      connectedAt: new Date(),
    },
    { upsert: true, new: true },
  );
  return doc;
}

async function getAuthenticatedClient(userId) {
  const tokenDoc = await GoogleToken.findOne({ userId }).select(
    "+accessTokenEncrypted +refreshTokenEncrypted",
  );
  if (!tokenDoc) {
    throw new Error("GOOGLE_NOT_CONNECTED");
  }

  const oauth2Client = makeOAuth2Client();
  oauth2Client.setCredentials({
    access_token: decrypt(tokenDoc.accessTokenEncrypted),
    refresh_token: decrypt(tokenDoc.refreshTokenEncrypted),
    expiry_date: tokenDoc.expiryDate,
  });

  oauth2Client.on("tokens", async (newTokens) => {
    const update = {
      expiryDate: newTokens.expiry_date ?? Date.now() + 3600 * 1000,
    };
    if (newTokens.access_token) {
      update.accessTokenEncrypted = encrypt(newTokens.access_token);
    }
    if (newTokens.refresh_token) {
      update.refreshTokenEncrypted = encrypt(newTokens.refresh_token);
    }
    await GoogleToken.findOneAndUpdate({ userId }, update).catch(console.error);
  });

  return oauth2Client;
}

function buildDocRequests(output, meta) {
  const requests = [];
  let idx = 1;

  let sections = [];

  if (Array.isArray(output?.tabs) && output.tabs.length > 0) {
    sections = output.tabs
      .filter((t) => t.content && t.content.trim())
      .map((t) => ({ title: t.label, content: t.content }));
  } else {
    const EFFECTIVE_OUTPUT_SECTIONS = [
      { key: "readme", title: "README" },
      { key: "apiReference", title: "API Reference" },
      { key: "schemaDocs", title: "Schema Documentation" },
      { key: "internalDocs", title: "Internal Notes" },
      { key: "securityReport", title: "Security Report" },
    ];
    sections = EFFECTIVE_OUTPUT_SECTIONS.map(({ key, title }) => ({
      title,
      content: output?.[key] || "",
    })).filter((s) => s.content.trim());
  }

  for (const { title, content } of sections) {
    const headingText = `${title}\n`;
    requests.push({
      insertText: { location: { index: idx }, text: headingText },
    });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: idx, endIndex: idx + headingText.length - 1 },
        paragraphStyle: { namedStyleType: "HEADING_1" },
        fields: "namedStyleType",
      },
    });
    idx += headingText.length;

    const stripped = content
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/`{3}[\s\S]*?`{3}/g, "")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\[(.+?)\]\(.+?\)/g, "$1")
      .trim();

    const bodyText = stripped + "\n\n";
    requests.push({
      insertText: { location: { index: idx }, text: bodyText },
    });
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: idx, endIndex: idx + bodyText.length },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    idx += bodyText.length;
  }

  const repoName = meta?.name || "Unknown Repo";
  const generatedAt = new Date().toUTCString();
  const footerText = `\nGenerated by Docnine\nRepository: ${repoName}\nDate: ${generatedAt}\n`;
  requests.push({
    insertText: { location: { index: idx }, text: footerText },
  });

  return requests;
}

export async function exportToGoogleDocs({ output, meta, stats, securityScore, userId }) {
  const auth = await getAuthenticatedClient(userId);
  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });

  const repoName = meta?.name || "Untitled Documentation";
  const docTitle = `${repoName} : Docnine Documentation`;

  const { data: created } = await docs.documents.create({
    requestBody: { title: docTitle },
  });
  const documentId = created.documentId;

  const requests = buildDocRequests(output, meta);
  if (requests.length > 0) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });
  }

  const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;
  return { documentId, documentUrl: docUrl, title: docTitle };
}

export async function getGoogleDocsConnectionStatus(userId) {
  const token = await GoogleToken.findOne({ userId });
  if (!token) return { connected: false };
  return {
    connected: true,
    email: token.googleEmail,
    name: token.googleName,
    connectedAt: token.connectedAt,
  };
}

export async function disconnectGoogleDocs(userId) {
  await GoogleToken.deleteOne({ userId });
}
