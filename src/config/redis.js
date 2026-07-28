// ===================================================================
// Redis client : singleton with graceful degradation.
//
// If REDIS_URL is not set, all operations are no-ops and the
// application falls back to pure in-memory behavior (dev / local).
//
// Recommended providers:
//   Upstash Redis : https://upstash.com  (set REDIS_URL=rediss://...)
//   Redis Cloud   : https://redis.com
// ===================================================================

import Redis from "ioredis";

let _client = null;
let _ready = false;

if (process.env.REDIS_URL) {
  try {
    // Strip surrounding quotes if present (dotenv edge-case)
    let redisUrl = process.env.REDIS_URL.replace(/^["']|["']$/g, "");
    // If no scheme, default to plain redis://
    if (!/^rediss?:\/\//i.test(redisUrl)) {
      redisUrl = `redis://${redisUrl}`;
    }
    _client = new Redis(redisUrl, {
      // Fail commands quickly so a Redis hiccup never stalls a pipeline.
      maxRetriesPerRequest: 1,
      // Don't wait for the "ready" probe on startup : commands will
      // queue internally until the connection resolves.
      enableReadyCheck: false,
      // Vercel serverless: connections are short-lived, keep timeouts tight.
      connectTimeout: 5_000,
      commandTimeout: 3_000,
      // Retry strategy: give up after 3 attempts to avoid stalling cold starts.
      retryStrategy(times) {
        if (times > 3) return null; // stop retrying
        return Math.min(times * 200, 1_000);
      },
    });

    _client.on("connect", () => {
      _ready = true;
      console.log("[redis] Connected");
    });

    _client.on("ready", () => {
      _ready = true;
    });

    _client.on("error", (err) => {
      // Non-fatal : log once per class of error, don't flood logs.
      if (!_client._lastErrCode || _client._lastErrCode !== err.code) {
        console.warn("[redis] Connection error (non-fatal):", err.message);
        _client._lastErrCode = err.code;
      }
      _ready = false;
    });

    _client.on("close", () => {
      _ready = false;
    });

    _client.on("reconnecting", () => {
      console.log("[redis] Reconnecting…");
    });
  } catch (err) {
    console.warn("[redis] Init failed (non-fatal):", err.message);
    _client = null;
  }
} else {
  console.log(
    "[redis] redis not set : running in-memory only (set REDIS_URL to enable cross-instance job state)",
  );
}

/**
 * Returns the ioredis client, or null if Redis is not configured.
 * @returns {import("ioredis").Redis | null}
 */
export function getRedis() {
  return _client;
}

/**
 * Returns true if Redis is configured AND connected.
 * Always check this before issuing commands.
 * @returns {boolean}
 */
export function isRedisAvailable() {
  return _ready && _client !== null;
}
