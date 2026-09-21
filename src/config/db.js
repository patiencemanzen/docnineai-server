
import dns from "node:dns";
import mongoose from "mongoose";


function ensureSrvDnsWorks(uri) {
  if (!uri.startsWith("mongodb+srv://")) return;
  const servers = dns.getServers();
  const onlyLoopback = servers.every(
    (s) => s === "127.0.0.1" || s === "::1" || s.startsWith("127.0.0.1:"),
  );
  if (!onlyLoopback) return;
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  console.warn(
    "[Database] Node DNS was 127.0.0.1 (SRV lookups refused). Using 8.8.8.8 for Atlas.",
  );
}


let _connectionPromise = null;

export async function connectDB() {
  const URI = process.env.MONGODB_URI;
  
  if (!URI) {
    throw new Error("MONGODB_URI is required in environment variables.\n");
  }


  if (mongoose.connection.readyState === 1) return;


  if (_connectionPromise) return _connectionPromise;

  _connectionPromise = _connect(URI).finally(() => {
    _connectionPromise = null;
  });

  return _connectionPromise;
}

async function _connect(URI) {
  ensureSrvDnsWorks(URI);


  mongoose.set("bufferCommands", false);

  await mongoose.connect(URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 1,
  });


  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once("open", resolve);
      mongoose.connection.once("error", reject);
    });
  }

  console.log("[Database] Connected to MongoDB");

  await migrateIndexes();
}


async function migrateIndexes() {
  try {

    let db = mongoose.connection.db;
    if (!db) {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("db not ready after 3s")),
          3000,
        );
        mongoose.connection.once("connected", () => {
          clearTimeout(deadline);
          resolve();
        });

        if (mongoose.connection.readyState === 1) {
          clearTimeout(deadline);
          resolve();
        }
      });
      db = mongoose.connection.db;
    }

    if (!db) {
      console.warn("⚠️  Skipping index migration : connection.db unavailable");
      return;
    }

    const collection = db.collection("projects");
    const indexes = await collection.indexes();
    const textIdx = indexes.find((idx) => idx.name === "project_search");

    if (!textIdx) {

      return;
    }

    if (textIdx.language_override === "search_language") {

      return;
    }

    console.log(
      "🔧 Dropping stale project_search index (missing language_override)…",
    );
    await collection.dropIndex("project_search");
    console.log(
      "Stale index dropped : will be recreated with language_override",
    );

    const { Project } = await import("../models/Project.js");
    await Project.ensureIndexes();
    console.log("✅ project_search index recreated");
  } catch (err) {

    console.warn("Index migration skipped:", err.message);
  }
}

mongoose.connection.on("disconnected", () =>
  console.warn("[Database] Database disconnected"),
);

mongoose.connection.on("reconnected", () =>
  console.log("[Database] Database reconnected"),
);

mongoose.connection.on("error", (err) =>
  console.error("[Database] Database error:", err.message),
);

export default mongoose;
