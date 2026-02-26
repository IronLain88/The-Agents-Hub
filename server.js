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
  { name: "idle",         group: "idle",       color: "#808080" },
];

const PORT = parseInt(process.env.PORT || "3000");
const HOST = process.env.HOST || "localhost";
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

// Security: Disable payload transmission to prevent prompt injection (set ALLOW_SIGNAL_PAYLOADS=true to enable)
const ALLOW_SIGNAL_PAYLOADS = process.env.ALLOW_SIGNAL_PAYLOADS === "true";

console.log(`[hub] Environment: ${NODE_ENV}`);
console.log(`[hub] Signal payloads: ${ALLOW_SIGNAL_PAYLOADS ? 'ENABLED' : 'DISABLED (set ALLOW_SIGNAL_PAYLOADS=true to enable)'}`);

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
  crossOriginEmbedderPolicy: false // Allow loading assets
}));

// CORS configuration
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
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
app.use(express.raw({ type: "image/*", limit: "2mb" }));

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
app.get("/", (_req, res) => res.redirect("/viewer/"));
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

  const { name, tileset, tx, ty, x, y, station, approach, collision } = validation.data;
  const id = `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
  const asset = {
    id,
    name,
    sprite: { tileset: tileset || "interiors", tx: tx || 0, ty: ty || 0 },
    position: x !== undefined && y !== undefined ? { x, y } : null,
    collision: collision ?? false,
    ...(station && { station }),
    ...(approach && { approach }),
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
  try {
    // Try user catalog first, fall back to default
    try {
      const data = await readFile(CATALOG_FILE, "utf-8");
      res.type("json").send(data);
      return;
    } catch {
      const data = await readFile(join(__dirname, "..", "assets", "config", "tile_catalog.json"), "utf-8");
      res.type("json").send(data);
    }
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
  // different ID (e.g. MCP restarted with a new random suffix), remove the old one.
  // Only dedup main agents (not subagents) to avoid removing legitimate parallel subagents.
  if (!parent_agent_id) {
    for (const [existingId, existing] of agents) {
      if (existingId !== agent_id
        && existing.agent_name === entry.agent_name
        && existing.owner_id === entry.owner_id
        && !existing.parent_agent_id) {
        agents.delete(existingId);
        broadcast({ type: "agent_removed", agent_id: existingId });
      }
    }
  }

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

// Heartbeat: remove agents not seen for 60 seconds
setInterval(() => {
  const cutoff = Date.now() - 60_000;
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
