import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

export const MODEL = "llama-3.1-8b-instant";

let _client = null;

export function getClient() {
  if (_client) return _client;
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      "GROQ_API_KEY is missing from environment. AI generation features are unavailable.",
    );
  }
  _client = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  return _client;
}

export const client = new Proxy(
  {},
  {
    get(_target, prop) {
      return getClient()[prop];
    },
  },
);

const TPM_LIMIT = 5000;
const TPM_WINDOW_MS = 62000;
const MAX_TOKENS_PER_CALL = 1800;

const tokenLog = [];

function tokensUsedInWindow() {
  const now = Date.now();
  const cutoff = now - TPM_WINDOW_MS;

  while (tokenLog.length && tokenLog[0].ts < cutoff) tokenLog.shift();
  return tokenLog.reduce((sum, e) => sum + e.tokens, 0);
}

function recordTokens(tokens) {
  tokenLog.push({ tokens, ts: Date.now() });
}

function msUntilCapacity(needed) {
  let freed = 0;
  const now = Date.now();
  const cutoff = now - TPM_WINDOW_MS;

  for (const entry of tokenLog) {
    if (entry.ts < cutoff) continue;
    freed += entry.tokens;
    const expiresAt = entry.ts + TPM_WINDOW_MS;
    if (tokensUsedInWindow() - freed + needed <= TPM_LIMIT) {
      return Math.max(0, expiresAt - now + 200);
    }
  }

  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function estimateTokens(systemPrompt, userContent) {
  return Math.ceil((systemPrompt.length + userContent.length) / 3.5);
}

const MAX_CONCURRENT = 2;
let _active = 0;
const _pending = [];

function _acquire() {
  return new Promise((resolve) => {
    if (_active < MAX_CONCURRENT) {
      _active++;
      resolve();
    } else {
      _pending.push(resolve);
    }
  });
}

function _release() {
  _active--;
  if (_pending.length > 0) {
    _active++;
    _pending.shift()();
  }
}

export async function llmCall({ systemPrompt, userContent, temperature = 0 }) {
  const estimatedInput = estimateTokens(systemPrompt, userContent);
  const estimatedTotal = estimatedInput + 512;

  if (estimatedInput > 4000) {
    console.warn(`Request ~${estimatedInput} tokens : trimming recommended`);
  }

  let waited = false;
  while (tokensUsedInWindow() + estimatedTotal > TPM_LIMIT) {
    const waitMs = msUntilCapacity(estimatedTotal) || 5000;
    if (!waited) {
      console.log(
        `-- Token bucket full (~${tokensUsedInWindow()}/${TPM_LIMIT} TPM used). Waiting ${(waitMs / 1000).toFixed(1)}s…`,
      );
      waited = true;
    }
    await sleep(waitMs);
  }

  await _acquire();
  try {
    return await executeCall({ systemPrompt, userContent, temperature, estimatedTotal });
  } finally {
    _release();
  }
}

async function executeCall({ systemPrompt, userContent, temperature, estimatedTotal }) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
    max_tokens: 1536,
  });

  const actualTokens = response.usage?.total_tokens || estimatedTotal;
  recordTokens(actualTokens);

  const remaining = TPM_LIMIT - tokensUsedInWindow();
  console.log(`✓ LLM call done (${actualTokens} tokens | ${remaining} remaining in window)`);

  return response.choices[0].message.content.trim();
}
