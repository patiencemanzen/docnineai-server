import { getRedis, isRedisAvailable } from "../config/redis.js";

const JOB_TTL = 86_400;

const K = {
  job: (id) => `job:${id}`,
  events: (id) => `job:${id}:events`,
  vercelTimeouts: "vercel-timeouts",
};

export const jobs = new Map();

export const streams = new Map();

export const vercelTimeoutJobs = new Set();

function _rWrite(fn) {
  if (!isRedisAvailable()) return;
  Promise.resolve()
    .then(() => fn(getRedis()))
    .catch((err) => console.warn("[job-registry:redis] Write error (non-fatal):", err.message));
}

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

  console.log(`[job-registry] Job ${jobId} registered · total jobs: ${jobs.size}`);

  _rWrite(async (r) => {
    const pipe = r.pipeline();
    pipe.hset(K.job(jobId), {
      status: "running",
      startTime: String(now),
      lastHeartbeat: String(now),
      vercelTimeout: "0",
    });
    pipe.del(K.events(jobId));
    pipe.expire(K.job(jobId), JOB_TTL);
    await pipe.exec();
  });
}

export function pushEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.events.push(event);
  job.lastHeartbeat = Date.now();

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
    } catch {}
  }

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

export function recoverLostJob(jobId, message = "Pipeline interrupted by server restart.") {
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
}

export async function hydrateJobFromRedis(jobId) {
  if (jobs.has(jobId)) return jobs.get(jobId);

  if (!isRedisAvailable()) return null;

  try {
    const r = getRedis();
    const [meta, rawEvents] = await Promise.all([
      r.hgetall(K.job(jobId)),
      r.lrange(K.events(jobId), 0, -1),
    ]);

    if (!meta || !meta.status) {
      console.log(`[job-registry] hydrateJobFromRedis: no Redis record for ${jobId}`);
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
        meta.vercelTimeout && meta.vercelTimeout !== "0" ? Number(meta.vercelTimeout) : false,
    };

    jobs.set(jobId, job);
    if (!streams.has(jobId)) streams.set(jobId, new Set());

    console.log(
      `[job-registry] Hydrated job ${jobId} from Redis ` +
        `(status=${job.status}, events=${events.length})`,
    );
    return job;
  } catch (err) {
    console.warn(`[job-registry:redis] Hydrate failed for ${jobId}:`, err.message);
    return null;
  }
}

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
  console.log(`[job-registry] Hydrated job ${jobId} from DB (${job.events.length} events)`);
  return job;
}

export async function isVercelTimedOut(jobId) {
  if (vercelTimeoutJobs.has(jobId)) return true;

  if (!isRedisAvailable()) return false;

  try {
    const r = getRedis();
    const isMember = await r.sismember(K.vercelTimeouts, jobId);
    if (isMember) vercelTimeoutJobs.add(jobId);
    return !!isMember;
  } catch {
    return false;
  }
}

export function getStaleJobs() {
  const now = Date.now();
  const STALE_THRESHOLD = 25_000 * 5;
  const CONCERNING_THRESHOLD = 120_000;

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

export function getAllJobs() {
  return Array.from(jobs.entries()).map(([jobId, job]) => ({
    jobId,
    status: job.status,
    startTime: job.startTime,
    vercelTimeout: job.vercelTimeout,
  }));
}
