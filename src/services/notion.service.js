import { NotionSettings } from "../models/NotionSettings.js";
import { encrypt, decrypt } from "../utils/crypto.util.js";

export async function saveNotionSettings({ userId, apiKey, parentPageId, workspaceName = null }) {
  const apiKeyEncrypted = encrypt(apiKey.trim());

  const doc = await NotionSettings.findOneAndUpdate(
    { userId },
    {
      apiKeyEncrypted,
      parentPageId: parentPageId.trim(),
      workspaceName: workspaceName ?? null,
      connectedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return {
    connected: true,
    parentPageId: doc.parentPageId,
    workspaceName: doc.workspaceName,
    connectedAt: doc.connectedAt,
  };
}

export async function getNotionStatus(userId) {
  const doc = await NotionSettings.findOne({ userId });
  if (!doc) return { connected: false };

  return {
    connected: true,
    parentPageId: doc.parentPageId,
    workspaceName: doc.workspaceName,
    connectedAt: doc.connectedAt,
  };
}

export async function getDecryptedNotionSettings(userId) {
  const doc = await NotionSettings.findOne({ userId }).select("+apiKeyEncrypted");
  if (!doc) throw new Error("NOTION_NOT_CONNECTED");

  return {
    apiKey: decrypt(doc.apiKeyEncrypted),
    parentPageId: doc.parentPageId,
  };
}

export async function disconnectNotion(userId) {
  await NotionSettings.deleteOne({ userId });
}
