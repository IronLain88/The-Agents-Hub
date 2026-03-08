import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { readdir, readFile, writeFile, mkdir, copyFile, access, unlink } from "fs/promises";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ensureV2 } from "./src/lib/property-validation.js";
import { createHeartbeatPayload, shouldAllowPayload } from "./src/lib/payload-merger.js";
import propertyRoutes from "./src/routes/property.js";
import assetRoutes from "./src/routes/assets.js";
import agentRoutes from "./src/routes/agents.js";
import signalRoutes from "./src/routes/signals.js";
import receptionRoutes from "./src/routes/reception.js";
import taskRoutes from "./src/routes/tasks.js";
import queueRoutes from "./src/routes/queue.js";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env file
dotenv.config({ path: join(__dirname, ".env") });

// Canonical built-in states — single source of truth for MCP, editor, and API
const BUILT_IN_STATES = [
  { name: "thinking",     group: "reasoning",  color: "#f0c040" },
  { name: "planning",     group: "reasoning",  color: "#60c0f0" },
  { name: "reflecting",   group: "reasoning",  color: "#c080f0" },
  { name: "searching",    group: "gathering",  color: "#f09040" },
  { name: "reading",      group: "gathering",  color: "#80d080" },
  { name: "querying",     group: "gathering",  color: "#40b0b0" },
  { name: "browsing",     group: "gathering",  color: "#d06060" },
  { name: "writing_code", group: "creating",   color: "#60f060" },
  { name: "writing_text", group: "creating",   color: "#60d0f0" },
  { name: "generating",   group: "creating",   color: "#f060c0" },
  { name: "inbox",        group: "communicating", color: "#5a9ef0" },
  { name: "idle",         group: "idle",       color: "#808080" },
];

const PORT = parseInt(process.env.PORT || "4242");
const HOST = process.env.HOST || "localhost";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const ALLOW_SIGNAL_PAYLOADS = process.env.ALLOW_SIGNAL_PAYLOADS === "true";
const ENABLE_GET_INBOX = process.env.ENABLE_GET_INBOX !== "false";

console.log(`[hub] Environment: ${NODE_ENV}`);
console.log(`[hub] Signal payloads: ${ALLOW_SIGNAL_PAYLOADS ? 'ENABLED' : 'DISABLED (set ALLOW_SIGNAL_PAYLOADS=true to enable)'}`);


const app = express();

// API key authentication
const API_KEY = process.env.API_KEY;
if (API_KEY) {
  console.log("[hub] API key authentication enabled");
} else {
  console.log("[hub] API key authentication disabled (set API_KEY to enable)");
}

function requireAuth(req, res, next) {
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
        || ALLOWED_ORIGINS.some(o => o.endsWith('*') && origin.startsWith(o.slice(0, -1)))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

if (process.env.TRUST_PROXY) {
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
  console.log(`[hub] trust proxy set to: ${process.env.TRUST_PROXY}`);
}

// HTTPS enforcement for production
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (!isSecure && !isLocal) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });

  if (!process.env.TRUST_PROXY) {
    console.warn("[hub] WARNING: Running in production without TRUST_PROXY set.");
  }
} else {
  if (ALLOWED_ORIGINS.includes('*')) {
    console.warn("[hub] WARNING: CORS is set to allow all origins ('*'). This is fine for development but should be restricted in production.");
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "2mb" }));

// Rate limiters
const signalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Too many signal fires, please try again later" },
  standardHeaders: true,
  legacyHeaders: false
});

const propertyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many property updates, please try again later" }
});

const spriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many sprite uploads, please try again later" }
});

const stateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many state updates, please try again later" }
});

// --- Shared state ---
const DATA_DIR = join(__dirname, "data");
const PROPERTY_FILENAME = process.env.PROPERTY_FILE || "property.json";
const PROPERTY_FILE = resolve(DATA_DIR, PROPERTY_FILENAME);
if (!PROPERTY_FILE.startsWith(resolve(DATA_DIR))) {
  console.error("[hub] FATAL: PROPERTY_FILE resolves outside DATA_DIR");
  process.exit(1);
}
const PROP_W = 24;
const PROP_H = 32;

if (process.env.PROPERTY_FILE) {
  console.log(`[hub] Using property file: ${PROPERTY_FILENAME}`);
}

let currentProperty = null;
const agents = new Map();
const viewers = new Set();
const activityLog = [];
const MAX_LOG_ENTRIES = 100;
const spriteStore = new Map();
const signalLastFired = new Map();
const agentPreviousState = new Map();
const TASK_EXPIRY_MS = 5 * 60 * 1000;

// Directories
const PROPERTIES_DIR = join(DATA_DIR, "properties");
const TILESETS_DIR = join(__dirname, "public", "assets", "tilesets");
const IMAGES_DIR = join(__dirname, "public", "assets", "images");
const CUTOUTS_DIR = join(__dirname, "public", "assets", "cutouts");
const CHARACTERS_DIR = join(__dirname, "public", "assets", "characters");

// --- Helper functions ---

function broadcast(message) {
  const json = JSON.stringify(message);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

async function savePropertyToDisk() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!currentProperty) return;

  try {
    await access(PROPERTY_FILE);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const backupFile = join(DATA_DIR, `property.backup.${timestamp}.json`);
    await copyFile(PROPERTY_FILE, backupFile);
    console.log(`[hub] Created backup: ${backupFile}`);
  } catch {
    // File doesn't exist yet, no backup needed
  }

  try {
    const files = await readdir(DATA_DIR);
    const backups = files.filter(f => f.startsWith("property.backup.")).sort();
    while (backups.length > 5) {
      const old = backups.shift();
      await unlink(join(DATA_DIR, old));
    }
  } catch { /* ignore rotation errors */ }

  const propertyJson = JSON.stringify(currentProperty, null, "\t");
  await writeFile(PROPERTY_FILE, propertyJson);
  console.log("[hub] Saved property to disk");
}

async function loadProperty() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    try {
      currentProperty = ensureV2(JSON.parse(await readFile(PROPERTY_FILE, "utf-8")));
      console.log("[hub] Loaded property from property.json");
      return;
    } catch { /* not found, try legacy */ }
    const files = await readdir(DATA_DIR);
    for (const file of files) {
      if (!file.endsWith(".property.json")) continue;
      try {
        currentProperty = ensureV2(JSON.parse(await readFile(join(DATA_DIR, file), "utf-8")));
        console.log(`[hub] Migrated property from ${file}`);
        await savePropertyToDisk();
        return;
      } catch { /* skip corrupt */ }
    }
    console.log("[hub] No saved property found");
  } catch { console.log("[hub] No saved property found"); }
}

let availableCharacters = ["Yuki"];
async function scanCharacters() {
  try {
    const files = await readdir(CHARACTERS_DIR);
    const names = new Set();
    for (const f of files) {
      const m = f.match(/^(.+)_idle_anim\.png$/i);
      if (m) names.add(m[1]);
    }
    if (names.size > 0) availableCharacters = [...names];
  } catch { /* keep default */ }
}
scanCharacters();

function assignCharacter(agentId) {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  return availableCharacters[Math.abs(hash) % availableCharacters.length];
}

function buildWelcome() {
  const assets = currentProperty?.assets || [];
  const stations = [];
  const signals = [];
  const tasks = [];
  const openclawTasks = [];

  for (const a of assets) {
    if (!a.station) continue;
    if (a.task) {
      const entry = `${a.station} — ${a.instructions || "(no instructions)"}`;
      if (a.openclaw_task) openclawTasks.push(entry);
      else tasks.push(entry);
      continue;
    }
    if (a.trigger) {
      signals.push(`${a.name || a.station} (${a.trigger})`);
    } else if (!a.welcome && !a.archive) {
      if (!stations.includes(a.station)) stations.push(a.station);
    }
  }

  const queues = currentProperty?.queues || {};
  const inboxCount = (queues.inbox || []).length;

  const others = [];
  for (const [, entry] of agents) {
    others.push({ name: entry.agent_name, state: entry.state });
  }

  return { stations, signals, tasks, openclawTasks, inbox: inboxCount, agents: others };
}

function buildDefaultWelcomeText() {
  const w = buildWelcome();
  const lines = [
    "# The Agents",
    "",
    "You have a property — a tile grid with furniture. Each furniture piece can be tagged with a **station** name.",
    "When you call `update_state({ state, detail })`, your character walks to the matching station.",
    "Update state at EVERY transition. Set idle when done.",
    "Use `say({ text })` to update your speech bubble without changing state or moving.",
    "",
    "## Your Property",
    `**Stations:** ${w.stations.join(", ") || "none"}`,
  ];
  if (w.inbox > 0) lines.push(`**Inbox:** ${w.inbox} message(s)`);
  if (w.tasks.length > 0) {
    lines.push(`**Task stations (interactive — visitors trigger these, you do the work):**`);
    for (const t of w.tasks) lines.push(`  - ${t}`);
    lines.push(`*Workflow: subscribe() → check_events() (blocks until triggered) → do the work → answer_task({station, result}) → check_events() again*`);
  }
  if (w.openclawTasks.length > 0) {
    lines.push(`**OpenClaw task stations (auto-spawn — do NOT call work_task on these):**`);
    for (const t of w.openclawTasks) lines.push(`  - ${t}`);
  }
  if (w.signals.length > 0) lines.push(`**Signals:** ${w.signals.join(", ")}`);
  const archiveStations = (currentProperty?.assets || []).filter(a => a.archive).map(a => a.name || a.station || "archive");
  if (archiveStations.length > 0) lines.push(`**Archive:** ${archiveStations.join(", ")}`);
  lines.push(`**Total assets:** ${(currentProperty?.assets || []).length}`);
  return lines.join("\n");
}

// --- Simple endpoints ---

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/states", (_req, res) => res.json({
  built_in: BUILT_IN_STATES,
  groups: ["reasoning", "gathering", "creating", "idle"],
  custom_states_allowed: true,
}));
app.get("/", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.use("/viewer", express.static(join(__dirname, "public", "viewer")));
app.use("/editor", express.static(join(__dirname, "public", "editor")));
app.use("/assets/tilesets", express.static(TILESETS_DIR));
app.use("/assets/characters", express.static(CHARACTERS_DIR));
app.get("/api/characters", (_req, res) => res.json(availableCharacters));
app.use("/assets/animated", express.static(join(__dirname, "public", "assets", "animated")));
app.use("/assets/images", express.static(IMAGES_DIR));
app.use("/assets/cutouts", express.static(CUTOUTS_DIR));

app.get("/api/welcome", (req, res) => {
  const welcomeAsset = currentProperty?.assets?.find(a => a.welcome);
  if (welcomeAsset?.content?.data) {
    return res.json({ source: "custom", text: welcomeAsset.content.data });
  }
  res.json({ source: "default", text: buildDefaultWelcomeText() });
});

app.get("/api/welcome/default", (req, res) => {
  res.json({ text: buildDefaultWelcomeText() });
});

// --- Shared context for route modules ---
const ctx = {
  requireAuth, propertyLimiter, stateLimiter, signalLimiter, spriteLimiter,
  getProperty: () => currentProperty,
  setProperty: (p) => { currentProperty = p; },
  broadcast, savePropertyToDisk, agents, activityLog, MAX_LOG_ENTRIES,
  agentPreviousState, assignCharacter, buildWelcome, spriteStore,
  PROPERTIES_DIR, DATA_DIR, TILESETS_DIR, IMAGES_DIR, CUTOUTS_DIR,
  IS_PRODUCTION, PROP_W, PROP_H, API_KEY,
  ALLOW_SIGNAL_PAYLOADS, ENABLE_GET_INBOX,
  __dirname,
};

// --- Mount route modules ---
app.use(propertyRoutes(ctx));
app.use(assetRoutes(ctx));
app.use(agentRoutes(ctx));
app.use(signalRoutes(ctx));
app.use(receptionRoutes(ctx));
app.use(taskRoutes(ctx));
app.use(queueRoutes(ctx));

// --- HTTP + WebSocket server ---
const httpServer = createServer(app);
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 1024,
});

wss.on("connection", (ws) => {
  viewers.add(ws);
  console.log(`[hub] Viewer connected (${viewers.size} total)`);

  const snapshot = {};
  for (const [id, entry] of agents) {
    snapshot[id] = {
      agent_id: entry.agent_id,
      agent_name: entry.agent_name,
      state: entry.state,
      detail: entry.detail,
      group: entry.group,
      sprite: entry.sprite,
      owner_id: entry.owner_id,
      owner_name: entry.owner_name,
      parent_agent_id: entry.parent_agent_id,
    };
  }
  ws.send(JSON.stringify({ type: "snapshot", agents: snapshot, property: currentProperty }));

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on("pong", () => {});
  ws.on("close", () => {
    clearInterval(pingInterval);
    viewers.delete(ws);
    console.log(`[hub] Viewer disconnected (${viewers.size} total)`);
  });
  ws.on("error", () => {
    clearInterval(pingInterval);
    viewers.delete(ws);
  });
});

// --- Interval timers ---

// Heartbeat signal scanner
setInterval(() => {
  if (!currentProperty?.assets) return;
  const now = Date.now();
  for (const asset of currentProperty.assets) {
    if (!asset.trigger || asset.trigger === "manual") continue;
    const intervalMs = (asset.trigger_interval || 60) * 1000;
    const last = signalLastFired.get(asset.id) || 0;
    if (now - last >= intervalMs) {
      // Ensure queue exists
      if (!currentProperty.queues) currentProperty.queues = {};
      if (!currentProperty.queues[asset.station]) currentProperty.queues[asset.station] = [];
      const queue = currentProperty.queues[asset.station];

      // Accumulate into existing DTO or create a new one
      const trailEntry = { station: asset.station, by: "Heartbeat", at: new Date().toISOString(), data: asset.instructions || "Heartbeat tick" };
      let dto;
      if (queue.length > 0) {
        dto = queue[queue.length - 1];
        dto.trail.push(trailEntry);
      } else {
        dto = {
          id: Math.random().toString(36).slice(2, 10),
          type: "heartbeat",
          created_at: new Date().toISOString(),
          trail: [trailEntry],
        };
        queue.push(dto);
      }

      const message = { type: "signal", station: asset.station, trigger: asset.trigger, timestamp: now };
      const allowPayload = shouldAllowPayload(ALLOW_SIGNAL_PAYLOADS, asset);
      const payload = createHeartbeatPayload(asset, allowPayload);
      if (payload !== undefined) {
        message.payload = payload;
      }
      message.payload = { ...(message.payload || {}), dtoId: dto.id };
      broadcast(message);
      signalLastFired.set(asset.id, now);
      savePropertyToDisk().catch(e => console.error("[hub] Failed to save:", e));
      console.log(`[hub] Signal fired: "${asset.station}" (${asset.trigger}) - DTO ${dto.id} (trail: ${dto.trail.length})`);
    }
  }
}, 10_000);

// Task expiry: reset abandoned tasks back to idle
setInterval(() => {
  if (!currentProperty?.assets) return;
  const now = Date.now();
  let changed = false;
  for (const asset of currentProperty.assets) {
    if (!asset.task) continue;
    let state;
    try { state = asset.content?.data ? JSON.parse(asset.content.data) : null; } catch { continue; }
    if (!state || state.status !== "pending") continue;
    const started = state.startedAt ? new Date(state.startedAt).getTime() : 0;
    if (now - started > TASK_EXPIRY_MS) {
      asset.content = { type: "task", data: JSON.stringify({ status: "idle", result: null }) };
      changed = true;
      console.log(`[hub] Task "${asset.station}" expired after ${TASK_EXPIRY_MS / 1000}s — reset to idle`);
    }
  }
  if (changed) {
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  }
}, 60_000);

// Agent heartbeat cleanup: remove agents not seen for 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 300_000;
  for (const [id, entry] of agents) {
    if (entry.last_seen < cutoff) {
      agents.delete(id);
      broadcast({ type: "agent_removed", agent_id: id });
      console.log(`[hub] Removed stale agent ${id}`);
    }
  }
}, 60_000);

// --- Error handling ---
app.use((err, req, res, next) => {
  console.error("[hub] Error:", {
    message: err.message,
    stack: IS_PRODUCTION ? undefined : err.stack,
    url: req.url,
    method: req.method
  });
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: IS_PRODUCTION ? "Internal server error" : err.message,
    ...(IS_PRODUCTION ? {} : { stack: err.stack })
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Start server ---
loadProperty().then(() => {
  httpServer.listen(PORT, HOST, () => {
    console.log(`[hub] Server listening on ${HOST}:${PORT}`);
    console.log(`[hub] HTTP: http://localhost:${PORT}/api/agents`);
    console.log(`[hub] WebSocket: ws://localhost:${PORT}`);
    if (process.send) process.send({ type: "ready" });
  });
});

// --- Graceful shutdown ---
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[hub] Received ${signal}, starting graceful shutdown...`);

  httpServer.close(() => {
    console.log("[hub] HTTP server closed");
  });

  console.log(`[hub] Closing ${viewers.size} WebSocket connections...`);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "server_shutdown", message: "Server is shutting down" }));
      ws.close(1001, "Server shutting down");
    }
  }
  viewers.clear();

  try {
    console.log("[hub] Saving property to disk...");
    await savePropertyToDisk();
    console.log("[hub] Property saved successfully");
  } catch (err) {
    console.error("[hub] Error saving property:", err);
  }

  console.log("[hub] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[hub] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[hub] Unhandled rejection at:", promise, "reason:", reason);
  gracefulShutdown("unhandledRejection");
});
