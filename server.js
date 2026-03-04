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
import sanitizeFilename from "sanitize-filename";
import { fileTypeFromBuffer } from "file-type";
import { ensureV2 } from "./src/lib/property-validation.js";
import { createHeartbeatPayload, createManualPayload, shouldAllowPayload } from "./src/lib/payload-merger.js";
import { formatBreadcrumb, applyBreadcrumb, applyNote } from "./src/lib/station-log.js";
import * as schemas from "./src/lib/validation.js";
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
  { name: "remote_board", group: "communicating", color: "#9a6ef0" },
  { name: "idle",         group: "idle",       color: "#808080" },
];

const PORT = parseInt(process.env.PORT || "4242");
const HOST = process.env.HOST || "localhost";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

// Security: Disable payload transmission to prevent prompt injection (set ALLOW_SIGNAL_PAYLOADS=true to enable)
const ALLOW_SIGNAL_PAYLOADS = process.env.ALLOW_SIGNAL_PAYLOADS === "true";
const ENABLE_REMOTE_BOARDS = process.env.ENABLE_REMOTE_BOARDS === "true";

console.log(`[hub] Environment: ${NODE_ENV}`);
console.log(`[hub] Signal payloads: ${ALLOW_SIGNAL_PAYLOADS ? 'ENABLED' : 'DISABLED (set ALLOW_SIGNAL_PAYLOADS=true to enable)'}`);
console.log(`[hub] Remote boards: ${ENABLE_REMOTE_BOARDS ? 'ENABLED' : 'DISABLED (set ENABLE_REMOTE_BOARDS=true to enable)'}`);

const app = express();

// API key authentication (set API_KEY env var to enable)
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
      scriptSrc: ["'self'", "'unsafe-inline'"], // Viewer/editor use inline scripts
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    }
  },
  crossOriginEmbedderPolicy: false, // Allow loading assets
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow VS Code webview to load images
}));

// CORS configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
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

// M5: Set trust proxy when configured
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
  // Development mode warning
  if (ALLOWED_ORIGINS.includes('*')) {
    console.warn("[hub] WARNING: CORS is set to allow all origins ('*'). This is fine for development but should be restricted in production.");
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(express.raw({ type: ["image/*", "application/octet-stream"], limit: "2mb" }));

// Rate limiters
const signalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { error: "Too many signal fires, please try again later" },
  standardHeaders: true,
  legacyHeaders: false
});

const propertyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 property updates per minute
  message: { error: "Too many property updates, please try again later" }
});

const spriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 sprite uploads per minute
  message: { error: "Too many sprite uploads, please try again later" }
});

const stateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 state updates per minute per IP
  message: { error: "Too many state updates, please try again later" }
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/states", (_req, res) => res.json({
  built_in: BUILT_IN_STATES,
  groups: ["reasoning", "gathering", "creating", "idle"],
  custom_states_allowed: true,
}));
app.get("/", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.use("/viewer", express.static(join(__dirname, "public", "viewer")));
app.use("/editor", express.static(join(__dirname, "public", "editor")));
const TILESETS_DIR = join(__dirname, "public", "assets", "tilesets");
app.get("/api/tilesets", async (_req, res) => {
  try {
    const files = await readdir(TILESETS_DIR);
    const pngs = files.filter(f => f.endsWith(".png"));
    const tilesets = {};
    for (const f of pngs) {
      const key = f.replace(/\.png$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
      tilesets[key] = `/assets/tilesets/${f}`;
    }
    res.json(tilesets);
  } catch {
    res.json({});
  }
});
app.use("/assets/tilesets", express.static(TILESETS_DIR));
app.use("/assets/characters", express.static(join(__dirname, "public", "assets", "characters")));

// Scan available character names from idle animation files
const CHARACTERS_DIR = join(__dirname, "public", "assets", "characters");
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

app.get("/api/characters", (_req, res) => res.json(availableCharacters));
app.use("/assets/animated", express.static(join(__dirname, "public", "assets", "animated")));

// Image storage — full images displayed with picture frames + lightbox
const IMAGES_DIR = join(__dirname, "public", "assets", "images");
app.use("/assets/images", express.static(IMAGES_DIR));
app.get("/api/images", async (_req, res) => {
  try {
    await mkdir(IMAGES_DIR, { recursive: true });
    const files = (await readdir(IMAGES_DIR)).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});
app.post("/api/images/:filename", requireAuth, propertyLimiter, async (req, res) => {
  try {
    const fname = req.params.filename;
    if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(fname)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    await mkdir(IMAGES_DIR, { recursive: true });
    await writeFile(join(IMAGES_DIR, fname), req.body);
    res.json({ ok: true, path: `/assets/images/${fname}` });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});

// Cutout storage — persistent PNGs extracted from tilesets
const CUTOUTS_DIR = join(__dirname, "public", "assets", "cutouts");
app.use("/assets/cutouts", express.static(CUTOUTS_DIR));
app.post("/api/cutouts/:filename", requireAuth, propertyLimiter, async (req, res) => {
  try {
    const fname = req.params.filename;
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(fname)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    await mkdir(CUTOUTS_DIR, { recursive: true });
    await writeFile(join(CUTOUTS_DIR, fname), req.body);
    res.json({ ok: true, path: `/assets/cutouts/${fname}` });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});

// Custom sprite storage (uploaded by MCP servers)
const spriteStore = new Map();
app.post("/api/sprites/:filename", requireAuth, spriteLimiter, async (req, res) => {
  try {
    // Validate filename
    const validation = schemas.spriteFilenameSchema.safeParse(req.params.filename);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }

    // Validate file type
    const fileType = await fileTypeFromBuffer(req.body);
    if (!fileType || fileType.mime !== "image/png") {
      return res.status(400).json({ error: "Only PNG images are allowed" });
    }

    spriteStore.set(req.params.filename, req.body);
    // H3: Cap sprite store to prevent memory DoS
    if (spriteStore.size > 50) {
      const oldest = spriteStore.keys().next().value;
      spriteStore.delete(oldest);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});
app.get("/assets/sprites/:filename", (req, res) => {
  const buf = spriteStore.get(req.params.filename);
  if (!buf) return res.status(404).send("Not found");
  res.type("image/png").send(buf);
});

const DATA_DIR = join(__dirname, "data");
const PROPERTY_FILENAME = process.env.PROPERTY_FILE || "property.json";
const PROPERTY_FILE = resolve(DATA_DIR, PROPERTY_FILENAME);

// M1: Validate PROPERTY_FILE stays within DATA_DIR
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

async function savePropertyToDisk() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!currentProperty) return;

  // Create backup before saving
  try {
    await access(PROPERTY_FILE); // Check if file exists
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const backupFile = join(DATA_DIR, `property.backup.${timestamp}.json`);
    await copyFile(PROPERTY_FILE, backupFile);
    console.log(`[hub] Created backup: ${backupFile}`);
  } catch {
    // File doesn't exist yet, no backup needed
  }

  // L1: Rotate backups — keep only the last 5
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
    // Try new single file first, then fall back to any legacy *.property.json
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

// Property validation functions moved to src/lib/property-validation.js

// Property API (single property)
function handleGetProperty(_req, res) {
  if (currentProperty) {
    res.json(currentProperty);
  } else {
    // Return empty default property instead of 404
    const defaultProperty = {
      version: 2,
      width: PROP_W,
      height: PROP_H,
      floor: [],
      assets: []
    };
    res.json(defaultProperty);
  }
}

function handlePostProperty(req, res) {
  // Validate with Zod schema
  const validation = schemas.propertyV2Schema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }

  const property = ensureV2(req.body);
  if (!property) {
    res.status(400).json({ error: "invalid property data" });
    return;
  }
  currentProperty = property;
  broadcast({ type: "property_update", property });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
}

app.get("/api/property", handleGetProperty);
app.post("/api/property", requireAuth, propertyLimiter, handlePostProperty);
// Backwards compat: MCP servers POST with ownerId — all map to the single property
app.get("/api/property/:ownerId", handleGetProperty);
app.post("/api/property/:ownerId", requireAuth, propertyLimiter, handlePostProperty);

// Property management for editor
const PROPERTIES_DIR = join(DATA_DIR, "properties");

app.get("/api/properties/list", async (_req, res) => {
  try {
    await mkdir(PROPERTIES_DIR, { recursive: true });
    const files = await readdir(PROPERTIES_DIR);
    const properties = files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
    res.json({ properties });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});

app.get("/api/properties/:name", async (req, res) => {
  try {
    // Validate and sanitize property name
    const validation = schemas.propertyNameSchema.safeParse(req.params.name);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const safeName = sanitizeFilename(req.params.name);

    const filePath = join(PROPERTIES_DIR, `${safeName}.json`);
    const data = await readFile(filePath, "utf-8");
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(404).json({ error: "Property not found" });
  }
});

app.post("/api/properties/:name", requireAuth, propertyLimiter, async (req, res) => {
  try {
    // Validate and sanitize property name
    const validation = schemas.propertyNameSchema.safeParse(req.params.name);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const safeName = sanitizeFilename(req.params.name);

    // Validate property data
    const propertyValidation = schemas.propertyV2Schema.safeParse(req.body);
    if (!propertyValidation.success) {
      return res.status(400).json({ error: propertyValidation.error.errors[0].message });
    }

    await mkdir(PROPERTIES_DIR, { recursive: true });
    const filePath = join(PROPERTIES_DIR, `${safeName}.json`);
    await writeFile(filePath, JSON.stringify(req.body, null, "\t"));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});

app.post("/api/property/set-default", requireAuth, propertyLimiter, async (req, res) => {
  try {
    // Validate with Zod schema
    const validation = schemas.propertyV2Schema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }

    const property = ensureV2(req.body);
    if (!property) {
      res.status(400).json({ error: "invalid property data" });
      return;
    }
    currentProperty = property;
    await savePropertyToDisk();
    broadcast({ type: "property_update", property });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});

// --- Granular asset endpoints ---

// POST /api/assets — add a new asset
app.post("/api/assets", requireAuth, propertyLimiter, (req, res) => {
  const validation = schemas.addAssetSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  if (!currentProperty) {
    return res.status(404).json({ error: "No property loaded" });
  }

  const { name, tileset, tx, ty, x, y, station, approach, collision, remote_url, remote_station, reception, task, openclaw_task, task_public, instructions, archive } = validation.data;
  const isTask = task || openclaw_task;
  const id = `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
  const asset = {
    id,
    name,
    sprite: { tileset: tileset || "interiors", tx: tx || 0, ty: ty || 0 },
    position: x !== undefined && y !== undefined ? { x, y } : null,
    collision: collision ?? false,
    ...(station && { station }),
    ...(approach && { approach }),
    ...(remote_url && { remote_url }),
    ...(remote_station && { remote_station }),
    ...(reception && { reception, trigger: "manual", instructions,
      content: { type: "reception", data: JSON.stringify({ status: "idle", question: null, answer: null }) } }),
    ...(isTask && { task: true, trigger: "manual", instructions, task_public: task_public ?? true,
      content: { type: "task", data: JSON.stringify({ status: "idle", result: null }) } }),
    ...(openclaw_task && { openclaw_task: true }),
    ...(archive && { archive: true }),
  };

  currentProperty.assets.push(asset);
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true, asset });
});

// DELETE /api/assets/:id — remove an asset
app.delete("/api/assets/:id", requireAuth, propertyLimiter, (req, res) => {
  if (!currentProperty?.assets) {
    return res.status(404).json({ error: "No property loaded" });
  }
  const idx = currentProperty.assets.findIndex(a => a.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ error: "Asset not found" });
  }
  const removed = currentProperty.assets.splice(idx, 1)[0];
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true, removed });
});

// PATCH /api/assets/:id — update asset fields (position, content)
app.patch("/api/assets/:id", requireAuth, propertyLimiter, (req, res) => {
  const validation = schemas.patchAssetSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  if (!currentProperty?.assets) {
    return res.status(404).json({ error: "No property loaded" });
  }
  const asset = currentProperty.assets.find(a => a.id === req.params.id);
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const { position, content } = validation.data;
  if (position) asset.position = position;
  if (content) asset.content = content;

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true, asset });
});

// POST /api/assets/:id/log — append a breadcrumb or note to an asset's log
app.post("/api/assets/:id/log", requireAuth, stateLimiter, (req, res) => {
  const validation = schemas.logEntrySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  if (!currentProperty?.assets) {
    return res.status(404).json({ error: "No property loaded" });
  }
  const asset = currentProperty.assets.find(a => a.id === req.params.id);
  if (!asset) {
    return res.status(404).json({ error: "Asset not found" });
  }

  const { entry, isNote } = validation.data;
  const log = asset.log || "";
  asset.log = isNote
    ? applyNote(log, entry)
    : applyBreadcrumb(log, formatBreadcrumb(entry));

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// Tile catalog
const CATALOG_FILE = join(DATA_DIR, "tile_catalog.json");

app.get("/api/tile-catalog", async (_req, res) => {
  res.set("Cache-Control", "no-cache");
  try {
    const data = await readFile(CATALOG_FILE, "utf-8");
    res.type("json").send(data);
  } catch {
    res.status(404).json({ error: "tile_catalog.json not found" });
  }
});

app.post("/api/tile-catalog", requireAuth, propertyLimiter, async (req, res) => {
  try {
    const validation = schemas.tileCatalogSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CATALOG_FILE, JSON.stringify(req.body, null, "\t"));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
  }
});

// Animated files listing
app.get("/api/animated-files", async (_req, res) => {
  try {
    const files = await readdir(join(__dirname, "..", "assets", "animated"));
    res.json(files.filter(f => f.endsWith(".png")));
  } catch {
    res.json([]);
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: 1024, // H4: Prevent large frame DoS
  // Viewers are read-only — no auth required for WebSocket connections

});

// Agent registry
const agents = new Map();
const viewers = new Set();

// Activity log (last 100 speech bubbles)
const activityLog = [];
const MAX_LOG_ENTRIES = 100;

function broadcast(message) {
  const json = JSON.stringify(message);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

// Auto-assign character sprite based on agent_id hash
function assignCharacter(agentId) {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  return availableCharacters[Math.abs(hash) % availableCharacters.length];
}

// Track previous state per agent for station logging
const agentPreviousState = new Map(); // agent_id → { state, stationId }

// Build a compact welcome summary of the current property
function buildWelcome() {
  const assets = currentProperty?.assets || [];
  const stations = [];
  const signals = [];
  const boards = [];
  const tasks = [];
  const openclawTasks = [];
  let inboxCount = 0;

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
    } else if (a.station.startsWith("inbox") && a.content?.data) {
      try {
        const msgs = JSON.parse(a.content.data);
        if (Array.isArray(msgs)) inboxCount += msgs.length;
      } catch {}
      if (!stations.includes(a.station)) stations.push(a.station);
    } else {
      if (!stations.includes(a.station)) stations.push(a.station);
      if (a.content?.data) boards.push(a.name || a.station);
    }
  }

  // Other active agents
  const others = [];
  for (const [, entry] of agents) {
    others.push({ name: entry.agent_name, state: entry.state });
  }

  return { stations, signals, boards, tasks, openclawTasks, inbox: inboxCount, agents: others };
}

// POST /api/state — agent reports its state
app.post("/api/state", requireAuth, stateLimiter, (req, res) => {
  const validation = schemas.agentStateSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  const { agent_id, agent_name, state, detail, group, sprite, owner_id, owner_name, parent_agent_id, note } = validation.data;

  const entry = {
    agent_id,
    agent_name: agent_name || "Agent",
    state,
    detail: detail || "",
    group: group || "idle",
    sprite: sprite || assignCharacter(agent_id),
    owner_id: owner_id || "default-owner",
    owner_name: owner_name || "Owner",
    parent_agent_id: parent_agent_id || null,
    last_seen: Date.now(),
  };
  // Dedup: if another agent with the same name+owner already exists under a
  // different ID (e.g. MCP restarted with a new random suffix), remove the stale one.
  // Timeout is high (150s) to avoid evicting legitimate parallel instances.
  if (!parent_agent_id) {
    const STALE_MS = 150_000;
    for (const [existingId, existing] of agents) {
      if (existingId !== agent_id
        && existing.agent_name === entry.agent_name
        && existing.owner_id === entry.owner_id
        && !existing.parent_agent_id
        && (Date.now() - existing.last_seen) > STALE_MS) {
        agents.delete(existingId);
        broadcast({ type: "agent_removed", agent_id: existingId });
      }
    }
  }

  const isNewAgent = !agents.has(agent_id);
  agents.set(agent_id, entry);

  // Station logging: append breadcrumbs/notes to station assets
  if (currentProperty?.assets) {
    const prev = agentPreviousState.get(agent_id);

    // If state changed and a note was provided, append it to the previous station
    if (prev && prev.state !== state && note && prev.stationId) {
      const prevAsset = currentProperty.assets.find(a => a.id === prev.stationId);
      if (prevAsset) {
        prevAsset.log = applyNote(prevAsset.log || "", note);
      }
    }

    // Append breadcrumb to current station
    const currentStation = currentProperty.assets.find(a => a.station === state);
    if (currentStation && detail) {
      currentStation.log = applyBreadcrumb(currentStation.log || "", formatBreadcrumb(detail));
    }

    agentPreviousState.set(agent_id, { state, stationId: currentStation?.id || null });

    // Save if we modified any logs
    if ((prev?.stationId && note && prev.state !== state) || (currentStation && detail)) {
      broadcast({ type: "property_update", property: currentProperty });
      savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    }
  }

  // Log speech bubbles to activity log
  if (detail && detail.trim()) {
    activityLog.push({
      timestamp: Date.now(),
      agent_name: entry.agent_name,
      detail: detail.trim(),
      state,
    });
    // Keep only last MAX_LOG_ENTRIES
    if (activityLog.length > MAX_LOG_ENTRIES) {
      activityLog.shift();
    }
  }

  broadcast({
    type: "agent_update",
    agent_id,
    agent_name: entry.agent_name,
    state,
    detail: entry.detail,
    group: entry.group,
    sprite: entry.sprite,
    owner_id: entry.owner_id,
    owner_name: entry.owner_name,
    parent_agent_id: entry.parent_agent_id,
  });

  // Welcome on first report: property summary so agents know what's here
  if (isNewAgent) {
    const welcome = buildWelcome();
    return res.json({ ok: true, welcome });
  }

  res.json({ ok: true });
});

// GET /api/agents — debug endpoint
app.get("/api/agents", (_req, res) => {
  res.json(Object.fromEntries(agents));
});

// GET /api/activity-log — retrieve activity log
app.get("/api/activity-log", (_req, res) => {
  res.json(activityLog);
});

// GET /api/status — compact status overview for agents
app.get("/api/status", (_req, res) => {
  // Agents summary
  const agentList = [];
  const occupiedStations = new Set();
  for (const [, entry] of agents) {
    const isIdle = entry.state === "idle";
    const a = { name: entry.agent_name, state: entry.state, detail: entry.detail || "", idle: isIdle };
    if (entry.parent_agent_id) a.sub = true;
    agentList.push(a);
    if (!isIdle) occupiedStations.add(entry.state);
  }

  // Inbox summary
  let inboxCount = 0;
  let inboxLatest = null;
  for (const asset of currentProperty.assets || []) {
    if (asset.station?.startsWith("inbox") && asset.content?.data) {
      try {
        const msgs = JSON.parse(asset.content.data);
        if (Array.isArray(msgs)) inboxCount += msgs.length;
      } catch {}
      if (asset.content.publishedAt && (!inboxLatest || asset.content.publishedAt > inboxLatest)) {
        inboxLatest = asset.content.publishedAt;
      }
    }
  }

  // Recent activity (last 5)
  const recent = activityLog.slice(-5).reverse().map(e => ({
    agent: e.agent_name, state: e.state, detail: e.detail, t: e.timestamp,
  }));

  res.json({
    agents: agentList,
    inbox: { count: inboxCount, latest: inboxLatest },
    activity: recent,
    stations: [...occupiedStations],
  });
});

// WebSocket: viewer connects
wss.on("connection", (ws) => {
  viewers.add(ws);
  console.log(`[hub] Viewer connected (${viewers.size} total)`);

  // Send initial snapshot
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
  ws.send(JSON.stringify({
    type: "snapshot",
    agents: snapshot,
    property: currentProperty,
  }));

  // WebSocket keepalive: ping every 30 seconds to prevent proxy timeout
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on("pong", () => {
    // Client is alive, connection healthy
  });

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

// --- Signal system ---
const signalLastFired = new Map(); // asset_id → timestamp

// Trigger scanner: check property assets for due signals
setInterval(() => {
  if (!currentProperty?.assets) return;
  const now = Date.now();
  for (const asset of currentProperty.assets) {
    if (!asset.trigger || asset.trigger === "manual") continue;
    const intervalMs = (asset.trigger_interval || 60) * 1000; // trigger_interval now in seconds
    const last = signalLastFired.get(asset.id) || 0;
    if (now - last >= intervalMs) {
      const message = { type: "signal", station: asset.station, trigger: asset.trigger, timestamp: now };

      // Add payload using the payload merger utility
      const allowPayload = shouldAllowPayload(ALLOW_SIGNAL_PAYLOADS, asset);
      const payload = createHeartbeatPayload(asset, allowPayload);
      if (payload !== undefined) {
        message.payload = payload;
      }

      broadcast(message);
      signalLastFired.set(asset.id, now);
      const payloadInfo = asset.trigger_payload !== undefined ? (allowPayload ? " (with payload)" : " (payload disabled)") : "";
      console.log(`[hub] Signal fired: "${asset.station}" (${asset.trigger}) - interval: ${asset.trigger_interval}s${payloadInfo}`);
    }
  }
}, 10_000);

// Manual/external signal fire endpoint
app.post("/api/signals/fire", requireAuth, signalLimiter, (req, res) => {
  // Validate request with Zod schema
  const validation = schemas.signalFireSchema.safeParse(req.body);
  if (!validation.success) {
    const firstError = validation.error.issues[0];
    if (firstError) {
      const field = firstError.path.join('.');
      // For invalid_type with undefined, use simpler "is required" message
      let message;
      if (firstError.code === 'invalid_type' && (firstError.received === 'undefined' || firstError.received === undefined)) {
        message = field.length > 0 ? `${field} is required` : 'Required field missing';
      } else {
        message = field.length > 0 ? `${field}: ${firstError.message}` : firstError.message;
      }
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: "Validation failed" });
  }

  const { station, payload } = req.body;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.trigger);
  const message = { type: "signal", station, trigger: "manual", timestamp: Date.now() };

  // Add payload using the payload merger utility
  const allowPayload = shouldAllowPayload(ALLOW_SIGNAL_PAYLOADS, asset);
  const mergedPayload = createManualPayload(asset, payload, allowPayload);
  if (mergedPayload !== undefined) {
    message.payload = mergedPayload;
  }

  broadcast(message);

  const payloadInfo = (payload !== undefined || asset?.trigger_payload !== undefined)
    ? (allowPayload ? " (with payload)" : " (payload blocked)")
    : "";
  console.log(`[hub] Signal manually fired: "${station}"${payloadInfo}`);
  res.json({ ok: true });
});

// Update signal interval endpoint
app.post("/api/signals/set-interval", requireAuth, signalLimiter, (req, res) => {
  // Validate request with Zod schema
  const validation = schemas.signalIntervalSchema.safeParse(req.body);
  if (!validation.success) {
    const firstError = validation.error.issues?.[0];
    if (firstError) {
      const field = firstError.path?.join('.');
      const message = field ? `${field} is required` : firstError.message;
      return res.status(400).json({ error: message });
    }
    return res.status(400).json({ error: "Validation failed" });
  }

  const { station, interval} = req.body;

  if (!currentProperty?.assets) {
    return res.status(404).json({ error: "no property loaded" });
  }

  const asset = currentProperty.assets.find(a => a.station === station && a.trigger);
  if (!asset) {
    return res.status(404).json({ error: `signal "${station}" not found` });
  }

  asset.trigger_interval = interval;
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));

  console.log(`[hub] Signal "${station}" interval updated to ${interval}s`);
  res.json({ ok: true, station, interval });
});

// --- Reception station endpoints ---

const receptionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many questions, please try again later" },
});

// POST /api/reception/:station/ask — visitor asks a question (public, rate-limited)
app.post("/api/reception/:station/ask", receptionLimiter, (req, res) => {
  const validation = schemas.receptionAskSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.reception);
  if (!asset) return res.status(404).json({ error: "Reception station not found" });

  let state = { status: "idle", question: null, answer: null };
  try {
    if (asset.content?.data) state = JSON.parse(asset.content.data);
  } catch {}

  if (state.status !== "idle") {
    return res.status(409).json({ error: "Reception is busy — please wait" });
  }

  state.status = "pending";
  state.question = validation.data.question;
  state.answer = null;
  state.askedAt = new Date().toISOString();
  asset.content = { type: "reception", data: JSON.stringify(state) };

  // Auto-fire paired signal — always include payload for reception (instructions are owner-authored, not external)
  const signalPayload = { question: state.question };
  if (asset.instructions) signalPayload.instructions = asset.instructions;
  broadcast({ type: "signal", station, trigger: "manual", timestamp: Date.now(), payload: signalPayload });
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// POST /api/reception/:station/answer — agent posts an answer (requires auth)
app.post("/api/reception/:station/answer", requireAuth, stateLimiter, (req, res) => {
  const validation = schemas.receptionAnswerSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.reception);
  if (!asset) return res.status(404).json({ error: "Reception station not found" });

  let state = { status: "idle", question: null, answer: null };
  try {
    if (asset.content?.data) state = JSON.parse(asset.content.data);
  } catch {}

  if (state.status !== "pending") {
    return res.status(409).json({ error: "No pending question" });
  }

  state.status = "answered";
  state.answer = validation.data.answer;
  state.answeredAt = new Date().toISOString();
  asset.content = { type: "reception", data: JSON.stringify(state) };

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// POST /api/reception/:station/clear — reset reception to idle (requires auth)
app.post("/api/reception/:station/clear", requireAuth, stateLimiter, (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.reception);
  if (!asset) return res.status(404).json({ error: "Reception station not found" });

  asset.content = { type: "reception", data: JSON.stringify({ status: "idle", question: null, answer: null }) };
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// --- Task station endpoints ---

const taskLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many task requests, please try again later" },
});

// Task expiry: reset abandoned tasks back to idle
const TASK_EXPIRY_MS = 5 * 60 * 1000;
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

// POST /api/task/:station/run — visitor triggers a task (public or auth-gated, rate-limited)
app.post("/api/task/:station/run", taskLimiter, (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
  if (!asset) return res.status(404).json({ error: "Task station not found" });

  // Auth-gated tasks require API key
  if (!asset.task_public && API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "This task requires authentication" });
  }

  let state = { status: "idle", result: null };
  try {
    if (asset.content?.data) state = JSON.parse(asset.content.data);
  } catch {}

  if (state.status !== "idle") {
    return res.status(409).json({ error: "Task is already running" });
  }

  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.slice(0, 2000) : null;
  state.status = "pending";
  state.result = null;
  state.claimedBy = null;
  state.startedAt = new Date().toISOString();
  if (prompt) state.prompt = prompt;
  asset.content = { type: "task", data: JSON.stringify(state) };

  // Fire signal with instructions
  const payload = { station, instructions: asset.instructions };
  broadcast({
    type: "signal", station, trigger: "manual", timestamp: Date.now(),
    payload,
  });
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// POST /api/task/:station/claim — agent claims a pending task (requires auth)
app.post("/api/task/:station/claim", requireAuth, stateLimiter, (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
  if (!asset) return res.status(404).json({ error: "Task station not found" });

  let state = { status: "idle", result: null };
  try {
    if (asset.content?.data) state = JSON.parse(asset.content.data);
  } catch {}

  if (state.status !== "pending") {
    return res.status(409).json({ error: "No pending task to claim" });
  }
  if (state.claimedBy) {
    return res.status(409).json({ error: `Already claimed by ${state.claimedBy}` });
  }

  const agentId = req.body?.agent_id || "unknown";
  if (asset.assigned_to && !agentId.startsWith(asset.assigned_to)) {
    return res.status(403).json({ error: `Task assigned to "${asset.assigned_to}" only` });
  }
  state.claimedBy = agentId;
  asset.content = { type: "task", data: JSON.stringify(state) };

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true, instructions: asset.instructions, prompt: state.prompt || null });
});

// POST /api/task/:station/result — agent posts a result (requires auth)
app.post("/api/task/:station/result", requireAuth, stateLimiter, (req, res) => {
  const validation = schemas.taskResultSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
  if (!asset) return res.status(404).json({ error: "Task station not found" });

  let state = { status: "idle", result: null };
  try {
    if (asset.content?.data) state = JSON.parse(asset.content.data);
  } catch {}

  if (state.status !== "pending") {
    return res.status(409).json({ error: "No pending task" });
  }

  state.status = "done";
  state.result = validation.data.result;
  state.completedAt = new Date().toISOString();
  asset.content = { type: "task", data: JSON.stringify(state) };

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// PATCH /api/task/:station — update task settings (requires auth)
app.patch("/api/task/:station", requireAuth, stateLimiter, (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
  if (!asset) return res.status(404).json({ error: "Task station not found" });

  if (typeof req.body.instructions === "string") {
    asset.instructions = req.body.instructions.slice(0, 5000);
  }
  if (typeof req.body.task_public === "boolean") {
    asset.task_public = req.body.task_public;
  }
  if (req.body.assigned_to !== undefined) {
    if (req.body.assigned_to === null || req.body.assigned_to === "") {
      delete asset.assigned_to;
    } else if (typeof req.body.assigned_to === "string") {
      asset.assigned_to = req.body.assigned_to.slice(0, 100);
    }
  }

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// POST /api/task/:station/clear — reset task to idle
app.post("/api/task/:station/clear", stateLimiter, (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
  if (!asset) return res.status(404).json({ error: "Task station not found" });

  if (!asset.task_public && API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "This task requires authentication" });
  }

  asset.content = { type: "task", data: JSON.stringify({ status: "idle", result: null }) };
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true });
});

// --- Bulletin board endpoints (experimental, set ENABLE_BOARD=true to activate) ---
const ENABLE_BOARD = process.env.ENABLE_BOARD === "true";
if (ENABLE_BOARD) console.log("[hub] Bulletin board endpoints enabled");

function requireBoard(_req, res, next) {
  if (!ENABLE_BOARD) return res.status(404).json({ error: "Bulletin board is not enabled (set ENABLE_BOARD=true)" });
  next();
}

// GET /api/board/:station — read a station's content and log (public, no auth)
app.get("/api/board/:station", requireBoard, (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station);
  if (!asset) {
    return res.status(404).json({ error: `Station "${station}" not found` });
  }
  res.json({
    station,
    content: asset.content || null,
    log: asset.log || null,
  });
});

// POST /api/board/:station — post content to a station's bulletin board
app.post("/api/board/:station", requireBoard, requireAuth, stateLimiter, (req, res) => {
  const station = req.params.station;
  const validation = schemas.boardPostSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }

  if (!currentProperty?.assets) {
    return res.status(404).json({ error: "No property loaded" });
  }
  const asset = currentProperty.assets.find(a => a.station === station);
  if (!asset) {
    return res.status(404).json({ error: `Station "${station}" not found` });
  }

  const { data, type } = validation.data;
  asset.content = { type: type || "text", data, publishedAt: new Date().toISOString() };
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  console.log(`[hub] Board "${station}" updated (${data.length} chars)`);
  res.json({ ok: true });
});

// --- Inbox endpoints ---

// Find inbox asset by name (defaults to "inbox")
function findInbox(name) {
  const station = name || "inbox";
  if (!currentProperty?.assets) return null;
  return currentProperty.assets.find(a => a.station === station && a.station.startsWith("inbox"));
}

// POST /api/inbox or /api/inbox/:name — append a message to a named inbox
function handleInboxPost(req, res) {
  const validation = schemas.inboxMessageSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error.issues[0].message });
  }
  const asset = findInbox(req.params.name);
  if (!asset) {
    const target = req.params.name || "inbox";
    return res.status(404).json({ error: `No inbox "${target}" found — add an asset with station="${target}" to your property` });
  }

  let messages = [];
  try {
    if (asset.content?.data) messages = JSON.parse(asset.content.data);
    if (!Array.isArray(messages)) messages = [];
  } catch { messages = []; }

  const { from, text } = validation.data;
  const id = Math.random().toString(36).slice(2, 8);
  messages.push({ id, from, text, timestamp: new Date().toISOString() });

  // Cap at 50 messages
  while (messages.length > 50) messages.shift();

  asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  console.log(`[hub] Inbox "${asset.station}" message from "${from}" (${messages.length} total)`);
  res.json({ ok: true, count: messages.length });
}
app.post("/api/inbox", requireAuth, stateLimiter, handleInboxPost);
app.post("/api/inbox/:name", requireAuth, stateLimiter, handleInboxPost);

// DELETE /api/inbox or /api/inbox/:name — clear a named inbox
function handleInboxDelete(req, res) {
  const asset = findInbox(req.params.name);
  if (!asset) {
    const target = req.params.name || "inbox";
    return res.status(404).json({ error: `No inbox "${target}" found — add an asset with station="${target}" to your property` });
  }

  asset.content = { type: "json", data: "[]", publishedAt: new Date().toISOString() };
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  console.log(`[hub] Inbox "${asset.station}" cleared`);
  res.json({ ok: true });
}
app.delete("/api/inbox", requireAuth, stateLimiter, handleInboxDelete);
app.delete("/api/inbox/:name", requireAuth, stateLimiter, handleInboxDelete);

// DELETE /api/inbox/:name/:id — delete a single message by id
function handleInboxDeleteOne(req, res) {
  const asset = findInbox(req.params.name);
  if (!asset) return res.status(404).json({ error: `No inbox "${req.params.name}" found` });

  let messages = [];
  try {
    if (asset.content?.data) messages = JSON.parse(asset.content.data);
    if (!Array.isArray(messages)) messages = [];
  } catch { messages = []; }

  const before = messages.length;
  messages = messages.filter(m => m.id !== req.params.id);
  if (messages.length === before) return res.status(404).json({ error: "Message not found" });

  asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };
  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  res.json({ ok: true, remaining: messages.length });
}
app.delete("/api/inbox/:name/:id", requireAuth, stateLimiter, handleInboxDeleteOne);

// POST /api/inbox/:name/:id/process — process an inbox message to a task station (card travel)
app.post("/api/inbox/:name/:id/process", requireAuth, stateLimiter, (req, res) => {
  const validation = schemas.processInboxSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ error: validation.error.issues[0].message });

  const asset = findInbox(req.params.name);
  if (!asset) return res.status(404).json({ error: `No inbox "${req.params.name}" found` });

  let messages = [];
  try {
    if (asset.content?.data) messages = JSON.parse(asset.content.data);
    if (!Array.isArray(messages)) messages = [];
  } catch { messages = []; }

  const msgIdx = messages.findIndex(m => m.id === req.params.id);
  if (msgIdx === -1) return res.status(404).json({ error: "Message not found" });

  const { target_station } = validation.data;
  const taskAsset = currentProperty?.assets?.find(a => a.station === target_station && a.task);
  if (!taskAsset) return res.status(404).json({ error: `Task station "${target_station}" not found` });

  let taskState = { status: "idle", result: null };
  try { if (taskAsset.content?.data) taskState = JSON.parse(taskAsset.content.data); } catch {}
  if (taskState.status !== "idle") return res.status(409).json({ error: "Task station is busy" });

  const msg = messages[msgIdx];
  const cardId = `card_${Math.random().toString(36).slice(2, 8)}`;

  // Remove message from inbox
  messages.splice(msgIdx, 1);
  asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };

  // Set task to pending with card
  taskState.status = "pending";
  taskState.result = null;
  taskState.claimedBy = null;
  taskState.startedAt = new Date().toISOString();
  taskState.prompt = `Process inbox message from ${msg.from}: ${msg.text}`;
  taskState.card = { id: cardId, from: msg.from, text: msg.text, timestamp: msg.timestamp, source: "inbox" };
  taskAsset.content = { type: "task", data: JSON.stringify(taskState) };

  // Fire signal for task station
  broadcast({ type: "signal", station: target_station, trigger: "manual", timestamp: Date.now(), payload: { station: target_station, instructions: taskAsset.instructions } });

  // Broadcast card travel animation
  const fromPos = asset.position || { x: 0, y: 0 };
  const toPos = taskAsset.position || { x: 0, y: 0 };
  broadcast({ type: "card_travel", card_id: cardId, from_pos: fromPos, to_pos: toPos });

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  console.log(`[hub] Inbox "${asset.station}" → task "${target_station}" (card ${cardId})`);
  res.json({ ok: true, card_id: cardId });
});

// POST /api/archive/:station — archive a completed card from a task station
app.post("/api/archive/:station", requireAuth, stateLimiter, (req, res) => {
  const station = req.params.station;
  const taskAsset = currentProperty?.assets?.find(a => a.station === station && a.task);
  if (!taskAsset) return res.status(404).json({ error: `Task station "${station}" not found` });

  let taskState = { status: "idle", result: null };
  try { if (taskAsset.content?.data) taskState = JSON.parse(taskAsset.content.data); } catch {}
  if (taskState.status !== "done" || !taskState.card) {
    return res.status(409).json({ error: "Task must be done with a card to archive" });
  }

  const archiveAsset = currentProperty?.assets?.find(a => a.archive);
  if (!archiveAsset) return res.status(404).json({ error: "No archive station found on property" });

  // Push completed card to archive
  let archiveData = [];
  try {
    if (archiveAsset.content?.data) archiveData = JSON.parse(archiveAsset.content.data);
    if (!Array.isArray(archiveData)) archiveData = [];
  } catch { archiveData = []; }

  archiveData.unshift({
    ...taskState.card,
    result: taskState.result,
    completedAt: taskState.completedAt || new Date().toISOString(),
  });
  while (archiveData.length > 200) archiveData.pop();
  archiveAsset.content = { type: "json", data: JSON.stringify(archiveData), publishedAt: new Date().toISOString() };

  // Clear task to idle
  taskAsset.content = { type: "task", data: JSON.stringify({ status: "idle", result: null }) };

  // Broadcast card travel animation
  const fromPos = taskAsset.position || { x: 0, y: 0 };
  const toPos = archiveAsset.position || { x: 0, y: 0 };
  broadcast({ type: "card_travel", card_id: taskState.card.id, from_pos: fromPos, to_pos: toPos });

  broadcast({ type: "property_update", property: currentProperty });
  savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
  console.log(`[hub] Archived card from "${station}" to archive`);
  res.json({ ok: true });
});

// --- Remote board proxy (feature-flagged) ---
function requireRemoteBoard(_req, res, next) {
  if (!ENABLE_REMOTE_BOARDS) return res.status(404).json({ error: "Remote boards are not enabled (set ENABLE_REMOTE_BOARDS=true)" });
  next();
}

app.get("/api/board/:station/remote", requireBoard, requireRemoteBoard, async (req, res) => {
  const station = req.params.station;
  const asset = currentProperty?.assets?.find(a => a.station === station);
  if (!asset) {
    return res.status(404).json({ error: `Station "${station}" not found` });
  }
  if (!asset.remote_url || !asset.remote_station) {
    return res.status(400).json({ error: `Station "${station}" has no remote board configured` });
  }

  // SSRF check: only allow http/https to non-private hosts
  try {
    const parsed = new URL(asset.remote_url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "Remote URL must use http or https" });
    }
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") || host === "::1") {
      return res.status(400).json({ error: "Remote URL cannot point to private/local addresses" });
    }
  } catch {
    return res.status(400).json({ error: "Invalid remote URL" });
  }

  try {
    const remoteRes = await fetch(`${asset.remote_url}/api/board/${encodeURIComponent(asset.remote_station)}`);
    if (!remoteRes.ok) {
      return res.status(502).json({ error: `Remote hub returned ${remoteRes.status}` });
    }
    const data = await remoteRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: IS_PRODUCTION ? "Failed to fetch remote board" : err.message });
  }
});

// DELETE /api/agents/:id — remove a single agent (requires auth)
app.delete("/api/agents/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  if (!agents.has(id)) return res.status(404).json({ error: "Agent not found" });
  agents.delete(id);
  broadcast({ type: "agent_removed", agent_id: id });
  res.json({ ok: true });
});

// DELETE /api/agents — clear all agents (requires auth)
app.delete("/api/agents", requireAuth, (req, res) => {
  const count = agents.size;
  for (const [id] of agents) {
    broadcast({ type: "agent_removed", agent_id: id });
  }
  agents.clear();
  console.log(`[hub] Cleared ${count} agents`);
  res.json({ ok: true, cleared: count });
});

// Heartbeat: remove agents not seen for 3 minutes
setInterval(() => {
  const cutoff = Date.now() - 180_000;
  for (const [id, entry] of agents) {
    if (entry.last_seen < cutoff) {
      agents.delete(id);
      broadcast({ type: "agent_removed", agent_id: id });
      console.log(`[hub] Removed stale agent ${id}`);
    }
  }
}, 15_000);

// Centralized error handling middleware
app.use((err, req, res, next) => {
  // Log error details
  console.error("[hub] Error:", {
    message: err.message,
    stack: IS_PRODUCTION ? undefined : err.stack,
    url: req.url,
    method: req.method
  });

  // Send appropriate response
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: IS_PRODUCTION ? "Internal server error" : err.message,
    ...(IS_PRODUCTION ? {} : { stack: err.stack })
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

loadProperty().then(() => {
  httpServer.listen(PORT, HOST, () => {
    console.log(`[hub] Server listening on ${HOST}:${PORT}`);
    console.log(`[hub] HTTP: http://localhost:${PORT}/api/agents`);
    console.log(`[hub] WebSocket: ws://localhost:${PORT}`);
    if (process.send) process.send({ type: "ready" });
  });
});

// Graceful shutdown handler
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[hub] Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new connections
  httpServer.close(() => {
    console.log("[hub] HTTP server closed");
  });

  // Close all WebSocket connections
  console.log(`[hub] Closing ${viewers.size} WebSocket connections...`);
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "server_shutdown", message: "Server is shutting down" }));
      ws.close(1001, "Server shutting down");
    }
  }
  viewers.clear();

  // Save current property to disk
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

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("[hub] Uncaught exception:", err);
  gracefulShutdown("uncaughtException");
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("[hub] Unhandled rejection at:", promise, "reason:", reason);
  gracefulShutdown("unhandledRejection");
});
