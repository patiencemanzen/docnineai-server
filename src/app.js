import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { connectDB } from "./config/db.js";
import apiRouter, { loadServices } from "./api/routes/router.js";
import { recoverOrphanedJobs } from "./api/services/projects/project.service.js";
import { startBillingCron } from "./services/cron.service.js";

const app = express();

// ── Trust proxy ────────────────────────────
// Required on Vercel — without this, express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR because Vercel's edge injects
// X-Forwarded-For but Express "trust proxy" is false by default.
// Setting to 1 means trust the first hop (eg: Vercel's edge proxy).
app.set("trust proxy", 1);

let initialized = false;

/**
 * Initialize once per cold start (serverless-safe).
 * After DB connects, recover any projects that were left in
 * "running"/"queued" state from a previous server instance.
 * Load services (orchestrator, chat, webhook, etc).
 */
async function initOnce() {
  if (initialized) return;

  await connectDB();

  // Best-effort recovery — don't block the request if it fails
  await recoverOrphanedJobs();

  // Load optional services (webhook, chat, export, etc)
  await loadServices();

  // init Billings cron jobs
  startBillingCron();

  initialized = true;
}

// ── Init middleware ────────────────────────
app.use(async (req, res, next) => {
  try {
    await initOnce();
    next();
  } catch (err) {
    next(err);
  }
});

// ── CORS ───────────────────────────────────
// In production, restrict to the known frontend origin so the browser
// receives a concrete Access-Control-Allow-Origin (not "*"), which is
// required for credentialed cross-origin requests (cookies).
// In development, reflect the request origin for convenience.
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || "";

const allowedOrigins = [
  "https://docnineai.com",
  "https://www.docnineai.com",
  process.env.CLIENT_URL,
  process.env.NODE_ENV === "development" && "http://localhost:5173",
  process.env.NODE_ENV === "development" && "http://localhost:3000",
].filter(Boolean);

app.use(
  cors({
    origin: (incomingOrigin, callback) => {
      // Allow requests with no origin (curl, Postman, server-to-server)
      if (!incomingOrigin) return callback(null, true);

      // Always allow the configured frontend origin
      if (incomingOrigin === FRONTEND_ORIGIN) return callback(null, true);

      // other custom allowed origins
      if (allowedOrigins.includes(incomingOrigin)) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin ${incomingOrigin} not allowed`));
    },
    credentials: true,
  }),
);

// ── Body parsing ───────────────────────────

// Webhook routes need the raw Buffer for signature verification —
// must be registered BEFORE express.json() consumes the body.
// The /webhook/github prefix covers both GitHub and Flutterwave webhooks,
app.use("/webhook/github", express.raw({ type: "*/*", limit: "10mb" }));

// Slack commands come as form-encoded, not JSON — use urlencoded parser.
// Both parsers capture rawBody so Slack signature verification works.
// This must come BEFORE the JSON parser to avoid stream consumption issues.
app.use(
  "/slack/commands",
  express.urlencoded({
    extended: true,
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(
  "/slack/events",
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

const jsonParser = express.json({
  limit: "20mb",
  // Capture raw bytes for signature verification (e.g., Slack requests).
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
});

app.use((req, res, next) => {
  if (
    req.path.startsWith("/slack/commands") ||
    req.path.startsWith("/slack/events")
  ) {
    return next();
  }
  return jsonParser(req, res, next);
});
app.use(cookieParser());
app.use(morgan("dev"));

// ── Health ─────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── API ────────────────────────────────────
// Root route returns welcome message
app.get("/", (_req, res) => {
  res.json({
    success: true,
    error: "Welcome to docnine AI server",
  });
});

app.use("/", apiRouter);

// ── 404 ────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
  });
});

// ── Error handler ──────────────────────────
app.use((err, req, res, _next) => {
  console.error("[Error]: ", err);
  res.status(500).json({
    success: false,
    error: err.message || "Internal error",
  });
});

export default app;
