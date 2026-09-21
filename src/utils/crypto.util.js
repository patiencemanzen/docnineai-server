import { randomBytes, createCipheriv, createDecipheriv, createHash } from "crypto";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be exactly 64 hex characters in .env\n" +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(raw, "hex");
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(".");
}

export function decrypt(stored) {
  const parts = stored.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value format");

  const [ivHex, authTagHex, dataHex] = parts;
  const key = getKey();
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  return decipher.update(Buffer.from(dataHex, "hex"), undefined, "utf8") + decipher.final("utf8");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSecureToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}
