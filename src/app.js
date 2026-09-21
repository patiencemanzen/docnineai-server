import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { connectDB } from "./config/db.js";
import apiRouter, { loadServices } from "./api/routes/router.js";
import { recoverOrphanedJobs } from "./api/services/projects/project.service.js";
import { startBillingCron } from "./services/cron.service.js";
import { startNotificationScheduler } from "./services/notification.scheduler.js";

const app = express();


app.set("trust proxy", 1);


app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

let initialized = false;


async function initOnce() {
  if (initialized) return;

  await connectDB();


  await recoverOrphanedJobs();


  await loadServices();


  startBillingCron();


  startNotificationScheduler();

  initialized = true;
}


app.use(async (req, res, next) => {
  try {
    await initOnce();
    next();
  } catch (err) {
    next(err);
  }
});


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

      if (!incomingOrigin) return callback(null, true);


      if (incomingOrigin === FRONTEND_ORIGIN) return callback(null, true);


      if (allowedOrigins.includes(incomingOrigin)) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin ${incomingOrigin} not allowed`));
    },
    credentials: true,
  }),
);




app.use("/webhook/github", express.raw({ type: "*/*", limit: "10mb" }));


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


app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});


app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Welcome to docnine AI server",
  });
});

app.use("/", apiRouter);


app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "NOT_FOUND",
  });
});


app.use((err, req, res, _next) => {
  console.error("[Error]: ", err);
  const isProd = process.env.NODE_ENV === "production";
  res.status(err.status || 500).json({
    success: false,
    error: isProd ? "Internal server error" : (err.message || "Internal error"),
  });
});

export default app;
