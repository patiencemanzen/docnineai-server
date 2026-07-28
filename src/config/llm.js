// ===================================================================
// Global LLM Config File
// ===================================================================
// Problem: 4 agents running in parallel all share one 6,000 TPM
// bucket. They fire independently → instant rate limit storm.
//
// Solution: ALL agents submit to a single global queue.
//   • Queue drains one call at a time
//   • Tracks tokens used in the last 60s (sliding window)
//   • If next call would exceed TPM_LIMIT → wait until window clears
//   • Each call estimates its own token cost upfront
//   • Result: smooth, predictable throughput, zero retry storms
// ===================================================================

import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

export const MODEL = "llama-3.1-8b-instant";

// Lazy-init: the LLM client is created on first use rather than at import time.
// This prevents a missing GROQ_API_KEY from crashing the entire server on cold
// start : routes that don't use the LLM remain fully operational.
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

/** @deprecated Use getClient() : kept for backward compat with existing imports. */
export const client = new Proxy(
  {},
  {
    get(_target, prop) {
      return getClient()[prop];
    },
  },
);

// ── Rate limit config ─────────────────────────────────────────
const TPM_LIMIT = 5000; // stay under 6000 : leave 1000 buffer
const TPM_WINDOW_MS = 62000; // 62s window (slightly over 60s for safety)
const MAX_TOKENS_PER_CALL = 1800; // input + output budget per call

// ── Sliding window token tracker ─────────────────────────────
const tokenLog = []; // Each entry: { tokens, ts }

function tokensUsedInWindow() {
  const now = Date.now();
  const cutoff = now - TPM_WINDOW_MS;
  // Evict old entries
  while (tokenLog.length && tokenLog[0].ts < cutoff) tokenLog.shift();
  return tokenLog.reduce((sum, e) => sum + e.tokens, 0);
}

function recordTokens(tokens) {
  tokenLog.push({ tokens, ts: Date.now() });
}

/**
 *  How long until oldest entries roll out of window to free up space?
 */
function msUntilCapacity(needed) {
  let freed = 0;
  const now = Date.now();
  const cutoff = now - TPM_WINDOW_MS;

  for (const entry of tokenLog) {
    if (entry.ts < cutoff) continue; // already expired
    freed += entry.tokens;
    const expiresAt = entry.ts + TPM_WINDOW_MS;
    if (tokensUsedInWindow() - freed + needed <= TPM_LIMIT) {
      return Math.max(0, expiresAt - now + 200); // +200ms buffer
    }
  }

  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Estimate tokens for a call ────────────────────────────────
function estimateTokens(systemPrompt, userContent) {
  return Math.ceil((systemPrompt.length + userContent.length) / 3.5);
}

// ── Concurrency semaphore ─────────────────────────────────────
// Allows up to MAX_CONCURRENT calls at once while still funnelling
// each through the global TPM tracker inside executeCall().
// Replaces the old fully-serial queuePromise chain that forced all
// agents to wait in a single line : causing 37+ minute waits at
// 5,000 TPM.  2 concurrent × ~1,800 tokens = 3,600 TPM peak burst,
// which stays safely under the 5,000 limit; the per-call TPM gate
// inside executeCall handles any remaining headroom logic.
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
  // Pre-compute token estimate so both the TPM gate and executeCall share it.
  const estimatedInput = estimateTokens(systemPrompt, userContent);
  const estimatedTotal = estimatedInput + 512;

  if (estimatedInput > 4000) {
    console.warn(`Request ~${estimatedInput} tokens : trimming recommended`);
  }

  // Wait for TPM headroom BEFORE acquiring a concurrency slot.
  // This prevents a rate-limit stall from tying up a semaphore slot for up to
  // 62 seconds and blocking every other caller ("stall the entire queue" bug).
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
  // estimatedTotal is pre-computed by the caller (llmCall) before slot acquisition.
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature,
    max_tokens: 1536, // hard cap on output tokens
  });

  // Record actual tokens used (from response header if available)
  const actualTokens = response.usage?.total_tokens || estimatedTotal;
  recordTokens(actualTokens);

  const remaining = TPM_LIMIT - tokensUsedInWindow();
  console.log(
    `✓ LLM call done (${actualTokens} tokens | ${remaining} remaining in window)`,
  );

  return response.choices[0].message.content.trim();
}
