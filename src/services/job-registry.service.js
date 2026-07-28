// ===================================================================
// Job Registry : in-memory job store + Redis persistence layer.
//
// Architecture:
//   jobs Map    = per-instance cache for fast synchronous SSE delivery.
//   streams Map = active SSE connections : in-memory always (non-transferable).
//   Redis       = cross-instance source of truth.  Survives cold starts and
//                 is visible to every Vercel instance serving the same app.
//
// Redis data model (all keys TTL'd to 24 h):
//   job:{id}         Hash  { status, startTime, lastHeartbeat, vercelTimeout, resultJson }
//   job:{id}:events  List  [ ...JSON strings ]  : append-only event stream
//   vercel-timeouts  Set   { jobId, … }          : timeout registry
//
// Graceful degradation:
//   If redis is not set (or Redis is down), all Redis ops are no-ops
//   and the service falls back to pure in-memory behaviour.
// ===================================================================

import { getRedis, isRedisAvailable } from "../config/redis.js";

// ── Key helpers ───────────────────────────────────────────────
const JOB_TTL = 86_400; // seconds : 24 h auto-expiry on all job keys

const K = {
  job: (id) => `job:${id}`,
  events: (id) => `job:${id}:events`,
  vercelTimeouts: "vercel-timeouts",
};

// ── In-memory stores ──────────────────────────────────────────

/**
 * jobs Map : jobId → { status, events[], result, startTime, lastHeartbeat, vercelTimeout }
 * Per-instance cache. Redis is the authoritative cross-instance store.
 */
export const jobs = new Map();

/**
 * streams Map : jobId → Set<express.Response>
 * Active SSE client connections. Cannot be stored outside this process.
 */
export const streams = new Map();

/**
 * In-memory set of Vercel-timeout'd job IDs for the current instance.
 * Populated lazily when Redis confirms a jobId is in the remote set.
 */
export const vercelTimeoutJobs = new Set();

// ── Redis fire-and-forget helper ──────────────────────────────
// Redis writes never block SSE delivery. Errors are swallowed here
// because a Redis hiccup must never crash the pipeline.
function _rWrite(fn) {
  if (!isRedisAvailable()) return;
  Promise.resolve()
    .then(() => fn(getRedis()))
    .catch((err) =>
      console.warn(
        "[job-registry:redis] Write error (non-fatal):",
        err.message,
      ),
    );
}

// ── Public API ────────────────────────────────────────────────

/**
 * Register a new job and initialise its in-memory and Redis state.
 */
export function registerJob(jobId) {
  const now = Date.now();
  console.log(`[job-registry] Registering job ${jobId}`);

  jobs.set(jobId, {
    status: "running",
    events: [],
    result: null,
    startTime: now,
    lastHeartbeat: now,
    vercelTimeout: false,
  });
  streams.set(jobId, new Set());

  console.log(
    `[job-registry] Job ${jobId} registered · total jobs: ${jobs.size}`,
  );

  _rWrite(async (r) => {
    const pipe = r.pipeline();
    pipe.hset(K.job(jobId), {
      status: "running",
      startTime: String(now),
      lastHeartbeat: String(now),
      vercelTimeout: "0",
    });
    pipe.del(K.events(jobId)); // clear any stale events from a prior run
    pipe.expire(K.job(jobId), JOB_TTL);
    await pipe.exec();
  });
}

/**
 * Broadcast a progress event to all active SSE clients and persist to Redis.
 */
export function pushEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.events.push(event);
  job.lastHeartbeat = Date.now();

  // Synchronous SSE delivery : must not await anything here.
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
    } catch {
      /* disconnected */
    }
  }

  // Async Redis persistence (fire-and-forget).
  _rWrite(async (r) => {
    const now = Date.now();
    const pipe = r.pipeline();
    pipe.rpush(K.events(jobId), JSON.stringify(event));
    pipe.hset(K.job(jobId), "lastHeartbeat", String(now));
    pipe.expire(K.events(jobId), JOB_TTL);
    pipe.expire(K.job(jobId), JOB_TTL);
    await pipe.exec();
  });
}

/**
 * Mark the job as finished, notify all SSE clients, and persist final state.
 */
export function finishJob(jobId, result) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = result.success ? "done" : "error";
    job.result = result;
  }

  const payload = `data: ${JSON.stringify({ step: "done", result })}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
      client.end();
    } catch {}
  }
  streams.delete(jobId);

  _rWrite(async (r) => {
    const status = result.success ? "done" : "error";
    await r.hset(K.job(jobId), {
      status,
      resultJson: JSON.stringify(result),
    });
  });
}

/**
 * Mark a job as errored from an uncaught exception.
 */
export function failJob(jobId, err) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "error";
    job.result = { success: false, error: err.message };
    job.lastHeartbeat = Date.now();
  }

  const payload = `data: ${JSON.stringify({ step: "error", status: "error", msg: err.message })}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
      client.end();
    } catch {}
  }
  streams.delete(jobId);

  _rWrite(async (r) => {
    await r.hset(K.job(jobId), {
      status: "error",
      resultJson: JSON.stringify({ success: false, error: err.message }),
    });
  });
}

/**
 * Mark a job as Vercel-timed-out. The pipeline may still be running in
 * another invocation : don't set status=error yet. Notify and close SSE clients.
 */
export function flagVercelTimeout(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    job.vercelTimeout = Date.now();
    console.log(`[job-registry] Marked job ${jobId} as Vercel-timed-out`);
  }
  vercelTimeoutJobs.add(jobId);

  const timeoutEvent = {
    step: "timeout",
    status: "timeout",
    msg: "HTTP request timeout on Vercel (60s limit). Pipeline may still be running. Please retry.",
    retryable: true,
    ts: Date.now(),
  };

  const payload = `data: ${JSON.stringify(timeoutEvent)}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
      client.end();
    } catch {}
  }
  streams.delete(jobId);

  _rWrite(async (r) => {
    const pipe = r.pipeline();
    pipe.hset(K.job(jobId), "vercelTimeout", String(Date.now()));
    pipe.sadd(K.vercelTimeouts, jobId);
    pipe.expire(K.job(jobId), JOB_TTL);
    await pipe.exec();
  });
}

/**
 * Register a synthetic error job for state lost on server restart.
 * Connecting SSE clients will receive the buffered error event immediately.
 */
export function recoverLostJob(
  jobId,
  message = "Pipeline interrupted by server restart.",
) {
  const errorEvent = {
    step: "error",
    status: "error",
    msg: message,
    ts: Date.now(),
  };
  jobs.set(jobId, {
    status: "error",
    events: [errorEvent],
    result: { success: false, error: message },
    startTime: Date.now(),
    lastHeartbeat: Date.now(),
    vercelTimeout: false,
  });
  // No streams slot : any connecting client sees the buffered error immediately.
}

// ── Redis-backed recovery (async) ─────────────────────────────

/**
 * Hydrate an in-memory job from Redis.
 * Called when an SSE client connects to a "running" project but this instance
 * has no matching job in memory (cold start, cross-instance, Vercel scale-out).
 *
 * Returns the hydrated job object, or null if Redis has no record.
 *
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
export async function hydrateJobFromRedis(jobId) {
  if (jobs.has(jobId)) return jobs.get(jobId); // local cache hit : no-op

  if (!isRedisAvailable()) return null;

  try {
    const r = getRedis();
    const [meta, rawEvents] = await Promise.all([
      r.hgetall(K.job(jobId)),
      r.lrange(K.events(jobId), 0, -1),
    ]);

    if (!meta || !meta.status) {
      console.log(
        `[job-registry] hydrateJobFromRedis: no Redis record for ${jobId}`,
      );
      return null;
    }

    const events = rawEvents
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const now = Date.now();
    const job = {
      status: meta.status,
      events,
      result: meta.resultJson ? JSON.parse(meta.resultJson) : null,
      startTime: Number(meta.startTime) || now,
      lastHeartbeat: Number(meta.lastHeartbeat) || now,
      vercelTimeout:
        meta.vercelTimeout && meta.vercelTimeout !== "0"
          ? Number(meta.vercelTimeout)
          : false,
    };

    jobs.set(jobId, job);
    if (!streams.has(jobId)) streams.set(jobId, new Set());

    console.log(
      `[job-registry] Hydrated job ${jobId} from Redis ` +
        `(status=${job.status}, events=${events.length})`,
    );
    return job;
  } catch (err) {
    console.warn(
      `[job-registry:redis] Hydrate failed for ${jobId}:`,
      err.message,
    );
    return null;
  }
}

/**
 * Fallback: hydrate from MongoDB events when Redis has no record.
 * Used by streamProject after hydrateJobFromRedis returns null.
 *
 * @param {string}   jobId
 * @param {object[]} dbEvents : project.events from MongoDB
 * @returns {object}
 */
export function hydrateJobFromDb(jobId, dbEvents = []) {
  if (jobs.has(jobId)) return jobs.get(jobId);
  const now = Date.now();
  const job = {
    status: "running",
    events: Array.isArray(dbEvents) ? dbEvents : [],
    result: null,
    startTime: now,
    lastHeartbeat: now,
    vercelTimeout: false,
  };
  jobs.set(jobId, job);
  if (!streams.has(jobId)) streams.set(jobId, new Set());
  console.log(
    `[job-registry] Hydrated job ${jobId} from DB (${job.events.length} events)`,
  );
  return job;
}

/**
 * Check whether a job has been flagged as Vercel-timed-out.
 * Checks local Set first (fast), then Redis (cross-instance).
 * Populates local Set cache so subsequent calls are synchronous.
 *
 * @param {string} jobId
 * @returns {Promise<boolean>}
 */
export async function isVercelTimedOut(jobId) {
  if (vercelTimeoutJobs.has(jobId)) return true;

  if (!isRedisAvailable()) return false;

  try {
    const r = getRedis();
    const isMember = await r.sismember(K.vercelTimeouts, jobId);
    if (isMember) vercelTimeoutJobs.add(jobId); // populate local cache
    return !!isMember;
  } catch {
    return false;
  }
}

/**
 * Check which running jobs haven't sent a heartbeat recently.
 * Used by recoverOrphanedJobs for monitoring.
 * @returns {{ staleJobs: string[], soonStaleJobs: string[] }}
 */
export function getStaleJobs() {
  const now = Date.now();
  const STALE_THRESHOLD = 25_000 * 5; // no heartbeat for 2+ min
  const CONCERNING_THRESHOLD = 120_000; // warn if running > 2 min

  const staleJobs = [];
  const soonStaleJobs = [];

  for (const [jobId, job] of jobs.entries()) {
    if (job.status !== "running") continue;
    const uptime = now - job.startTime;
    const timeSinceHeartbeat = now - job.lastHeartbeat;
    if (timeSinceHeartbeat > STALE_THRESHOLD) staleJobs.push(jobId);
    else if (uptime > CONCERNING_THRESHOLD) soonStaleJobs.push(jobId);
  }

  return { staleJobs, soonStaleJobs };
}

/**
 * Retrieve summary info about a job for monitoring (dashboard use).
 * @param {string} jobId
 * @returns {object | null} Job info with uptime, lifetime, etc.
 */
export function getJobInfo(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;

  const now = Date.now();
  return {
    jobId,
    status: job.status,
    uptime: now - job.startTime,
    timeSinceHeartbeat: now - job.lastHeartbeat,
    eventCount: job.events.length,
    vercelTimeout: job.vercelTimeout ? now - job.vercelTimeout : false,
    hasResult: !!job.result,
  };
}

/**
 * Export snapshot of all jobs for monitoring and recovery.
 * @returns {Array<object>} Array of job info
 */
export function getAllJobs() {
  return Array.from(jobs.entries()).map(([jobId, job]) => ({
    jobId,
    status: job.status,
    startTime: job.startTime,
    vercelTimeout: job.vercelTimeout,
  }));
}
