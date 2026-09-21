import Redis from "ioredis";

let _client = null;
let _ready = false;

if (process.env.REDIS_URL) {
  try {
    let redisUrl = process.env.REDIS_URL.replace(/^["']|["']$/g, "");

    if (!/^rediss?:\/\//i.test(redisUrl)) {
      redisUrl = `redis://${redisUrl}`;
    }
    _client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,

      enableReadyCheck: false,

      connectTimeout: 5_000,
      commandTimeout: 3_000,

      retryStrategy(times) {
        if (times > 3) return null;
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

export function getRedis() {
  return _client;
}

export function isRedisAvailable() {
  return _ready && _client !== null;
}
