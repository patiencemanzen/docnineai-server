// ===================================================================
// Shared in-memory job store — single source of truth for
// pipeline job state and active SSE client connections.
//
// IMPROVED: Track job lifetime, heartbeat, and handle Vercel timeout
//
// Both the legacy /api/document route (index.js) and the new
// project service import from here. This is the ONLY file that
// needs to change if you later switch to Redis pub/sub.
// ===================================================================

/**
 * jobs Map — jobId → {
 *   status: "running" | "done" | "error",
 *   events: [],
 *   result: null | object,
 *   startTime: timestamp,
 *   lastHeartbeat: timestamp,
 *   vercelTimeout: false | timestamp when timeout detected
 * }
 */
export const jobs = new Map();

/**
 * streams Map — jobId → Set<express.Response>
 * Each value is a Set of active SSE response objects for that job.
 */
export const streams = new Map();

/**
 * Track jobs that timed out on Vercel but are still running in the background.
 * Helps us identify and recover truly orphaned jobs vs jobs interrupted by
 * Vercel's 60s serverless timeout.
 *
 * vecelTimeoutJobs: Set<jobId>
 */
export const vercelTimeoutJobs = new Set();

/**
 * Register a new job and initialise its streams slot.
 * @param {string} jobId
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
}

/**
 * Broadcast a progress event to all SSE clients watching this job
 * AND append it to the event buffer (for late-connecting clients).
 * Also updates the heartbeat timestamp to track job liveness.
 * @param {string} jobId
 * @param {object} event  — { step, status, msg, detail, ts }
 */
export function pushEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  
  job.events.push(event);
  job.lastHeartbeat = Date.now(); // Track that job is still alive

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
    } catch {
      /* client disconnected */
    }
  }
}

/**
 * Mark a job as complete, broadcast the done event, close all SSE clients.
 * @param {string} jobId
 * @param {object} result — full orchestrate() result
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
}

/**
 * Register a pre-failed job that represents state lost on server restart.
 * This lets the SSE stream endpoint serve a proper error event instead
 * of the generic "state lost" message.
 *
 * @param {string} jobId
 * @param {string} [message]
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
  // No streams slot — any connecting client will see the buffered error
  // event immediately and the job will be served as done (error).
}

/**
 * Mark a job as Vercel-timed-out (HTTP request timeout at 60s on serverless).
 * The job may still be running in the background — don't fail it yet.
 * Instead, tell the client to retry and disconnect from streaming.
 *
 * @param {string} jobId
 */
export function flagVercelTimeout(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    job.vercelTimeout = Date.now();
    console.log(
      `[job-registry] Marked job ${jobId} as Vercel-timed-out (may still be running)`,
    );
  }
  vercelTimeoutJobs.add(jobId);

  const timeoutEvent = {
    step: "timeout",
    status: "timeout",
    msg: "HTTP request timeout on Vercel (60s limit). Pipeline may still be running. Please retry.",
    retryable: true,
    ts: Date.now(),
  };

  // Notify connected clients and close them
  const payload = `data: ${JSON.stringify(timeoutEvent)}\n\n`;
  for (const client of streams.get(jobId) || new Set()) {
    try {
      client.write(payload);
      client.end();
    } catch {}
  }
  streams.delete(jobId);
}

/**
 * Check which jobs have been running for a suspiciously long time
 * on Vercel and might be stuck or genuinely orphaned (not just HTTP timeout).
 * Returns { staleJobs, soonStaleJobs } for monitoring.
 *
 * @returns {{ staleJobs: string[], soonStaleJobs: string[] }}
 */
export function getStaleJobs() {
  const now = Date.now();
  const HEARTBEAT_INTERVAL = 25_000; // SSE heartbeat interval from controller
  const STALE_THRESHOLD = HEARTBEAT_INTERVAL * 5; // no heartbeat for 2+ minutes
  const CONCERNING_THRESHOLD = 120_000; // warn if running >2 min

  const staleJobs = [];
  const soonStaleJobs = [];

  for (const [jobId, job] of jobs.entries()) {
    if (job.status !== "running") continue;

    const uptime = now - job.startTime;
    const timeSinceHeartbeat = now - job.lastHeartbeat;

    if (timeSinceHeartbeat > STALE_THRESHOLD) {
      staleJobs.push(jobId);
    } else if (uptime > CONCERNING_THRESHOLD) {
      soonStaleJobs.push(jobId);
    }
  }

  return { staleJobs, soonStaleJobs };
}

/**
 * Mark a job as errored from an uncaught exception.
 * @param {string} jobId
 * @param {Error}  err
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
