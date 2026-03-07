// Slim single-property viewer — no village map, no build mode
const CONFIG = window.VILLAGE_CONFIG || {};
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('apiKey')) CONFIG.apiKey = urlParams.get('apiKey');
if (!CONFIG.apiKey) CONFIG.apiKey = localStorage.getItem("editor_api_key") || "";

// Auth UI
{
  const el = document.getElementById("auth-status");
  if (el) {
    const render = () => {
      const key = CONFIG.apiKey;
      el.textContent = key ? "\ud83d\udd13 Logged in" : "\ud83d\udd12 Login";
      el.title = key ? "Click to log out" : "Click to enter API key";
    };
    el.onclick = () => {
      if (CONFIG.apiKey) {
        CONFIG.apiKey = "";
        localStorage.removeItem("editor_api_key");
      } else {
        const key = prompt("Enter API key:");
        if (key?.trim()) {
          CONFIG.apiKey = key.trim();
          localStorage.setItem("editor_api_key", key.trim());
        }
      }
      render();
    };
    render();

    // Clear agents button (authed only)
    if (CONFIG.apiKey) {
      const clearBtn = document.createElement('span');
      clearBtn.textContent = '\u21bb Clear agents';
      clearBtn.className = 'nav-clear-btn';
      clearBtn.title = 'Remove all agents from the viewer';
      clearBtn.onclick = async () => {
        const res = await fetch(`${HUB_HTTP_URL}/api/agents`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${CONFIG.apiKey}` },
        });
        if (res.ok) { const d = await res.json(); clearBtn.textContent = `\u2713 Cleared ${d.cleared}`; setTimeout(() => clearBtn.textContent = '\u21bb Clear agents', 2000); }
      };
      el.after(clearBtn);
    }
  }

  // Nav drawer toggle
  const hamburger = document.getElementById('nav-hamburger');
  const drawer = document.getElementById('nav-drawer');
  if (hamburger && drawer) {
    hamburger.onclick = () => drawer.classList.toggle('open');
    // Close drawer when clicking a link
    drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', () => drawer.classList.remove('open')));
  }
}
const HUB_WS_URL = CONFIG.hubWsUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
const HUB_HTTP_URL = CONFIG.hubHttpUrl || '';
const ASSET_BASE = CONFIG.assetBase || '/assets';
let TILESET_URIS = CONFIG.tilesetUris || {};
const CHARACTER_BASE = CONFIG.characterBase || `${ASSET_BASE}/characters`;
const CHARACTER_NAME = CONFIG.characterName || "Aeon";
const ANIMATED_BASE = CONFIG.animatedBase || `${ASSET_BASE}/animated`;
const SPRITE_BASE = CONFIG.spriteBase || `${ASSET_BASE}/sprites`;

const POSE_SPRITES = {
  idle: "_idle_anim.png",
  sit: "_sit3.png",
  phone: "_phone.png",
  run: "_run.png",
};

var { TILE_SIZE, DEFAULT_GRID_W, DEFAULT_GRID_H, collectStations, resolveStation, buildCollisionMap, findPath, simplifyPath } = StationLogic;
function gridW() { return property?.width || DEFAULT_GRID_W; }
function gridH() { return property?.height || DEFAULT_GRID_H; }
const LERP_SPEED = 8;
const ANIM_FPS = 6;
const BUBBLE_PAD = 8;
const BUBBLE_MAX_WIDTH = 320;
const BUBBLE_LINE_HEIGHT = 12;
const WAYPOINT_THRESHOLD = 2; // Pixels - how close before advancing to next waypoint

// --- Drawing helpers ---
const FRAME_STYLES = {
  gold:  ['#5a3a1a', '#8b6914', '#c8a84e'],
  dark:  ['#1a1a1a', '#333333', '#555555'],
  white: ['#888888', '#cccccc', '#f0f0f0'],
  wood:  ['#3b2507', '#6b4226', '#a0703c'],
  black: ['#000000', '#1a1a1a', '#333333'],
};
const FEET_H = 14;

function drawFeet(ctx, dx, dy, w, h, style) {
  const color = FRAME_STYLES[style]?.[0] || FRAME_STYLES.gold[0];
  ctx.fillStyle = color;
  ctx.fillRect(dx + 3, dy + h, 3, FEET_H);
  ctx.fillRect(dx + w - 6, dy + h, 3, FEET_H);
}

function drawFrame(ctx, dx, dy, w, h, p, style) {
  if (p <= 0) return;
  const c = FRAME_STYLES[style] || FRAME_STYLES.gold;
  ctx.fillStyle = c[0];
  ctx.fillRect(dx, dy, w, h);
  ctx.fillStyle = c[1];
  ctx.fillRect(dx + 1, dy + 1, w - 2, h - 2);
  ctx.fillStyle = c[2];
  ctx.fillRect(dx + p - 1, dy + p - 1, w - (p - 1) * 2, h - (p - 1) * 2);
}

// --- State ---
const agents = new Map();
const characters = new Map();
const agentLastSeen = new Map();
const tilesetImages = {};
const animatedImages = new Map();
const cutoutImages = new Map();
const imageAssets = new Map();
const characterSprites = {}; // { charName: { pose: Image } }
let animTime = 0;
const signalFlash = new Map(); // station -> Date.now() of last fire
const taskPrevStatus = new Map(); // station -> previous task status
const travelingCards = new Map(); // card_id -> { fromX, fromY, toX, toY, startTime, duration }
const bubbleShowUntil = new Map(); // agentId -> timestamp when bubble auto-hides
const bubblePinned = new Set(); // agentIds with pinned (clicked) bubbles

// Single property state
let property = null;            // property data (v2 format)
const stationOccupants = new Map();
const furnitureBehaviors = {};   // behaviors: { station -> { pose, approach, facing } }
let collisionMap = [];          // 2D array of blocked tiles

// --- Canvas & Camera ---
const canvas = document.getElementById("village");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const camera = { x: 0, y: 0, zoom: 2 };
let dragging = false, dragStart = { x: 0, y: 0 }, camStart = { x: 0, y: 0 };

// --- Asset Loading ---

async function loadAssets() {
  if (!CONFIG.tilesetUris) {
    try {
      const res = await fetch(`${HUB_HTTP_URL}/api/tilesets`);
      if (res.ok) {
        const data = await res.json();
        // Prefix relative URIs with hub URL so they work in VS Code webviews
        for (const [k, v] of Object.entries(data)) {
          data[k] = v.startsWith('/') ? `${HUB_HTTP_URL}${v}` : v;
        }
        TILESET_URIS = data;
      }
    } catch { /* use empty */ }
  }
  const promises = Object.entries(TILESET_URIS).map(([key, uri]) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { tilesetImages[key] = img; resolve(); };
      img.onerror = () => resolve();
      img.src = uri;
    })
  );

  await Promise.all(promises);
  await loadCharacterSprites(CHARACTER_NAME);
}

function loadCharacterSprites(name) {
  if (characterSprites[name]) return Promise.resolve();
  characterSprites[name] = {};
  return Promise.all(Object.entries(POSE_SPRITES).map(([pose, suffix]) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { characterSprites[name][pose] = img; resolve(); };
      img.onerror = () => resolve();
      img.src = `${CHARACTER_BASE}/${name}${suffix}`;
    })
  ));
}

// --- Property Handling ---

function applyPropertyData(propData) {
  property = propData;
  stationOccupants.clear();
  collisionMap = buildCollisionMap(propData);

  // Preload animated sprites and cutouts
  const animatedList = propData.animated || [];
  for (const asset of propData.assets || []) {
    if (asset.sprite?.file) animatedList.push({ file: asset.sprite.file });
    if (asset.sprite?.cutout && !cutoutImages.has(asset.sprite.cutout)) {
      const img = new Image();
      img.src = `${HUB_HTTP_URL}/assets/cutouts/${asset.sprite.cutout}`;
      cutoutImages.set(asset.sprite.cutout, img);
    }
    if (asset.sprite?.image && !imageAssets.has(asset.sprite.image)) {
      const img = new Image();
      img.src = `${HUB_HTTP_URL}/assets/images/${asset.sprite.image}`;
      imageAssets.set(asset.sprite.image, img);
    }
  }
  for (const a of animatedList) {
    if (!animatedImages.has(a.file)) {
      const img = new Image();
      img.src = a.file.startsWith("animated_")
        ? `${ANIMATED_BASE}/${a.file}`
        : `${SPRITE_BASE}/${a.file}`;
      animatedImages.set(a.file, img);
    }
  }

  // Re-route all agents to new stations
  for (const [agentId, data] of agents) {
    updateAgentPath(agentId, data);
  }
}

// --- Station Routing ---

function getTargetPosition(agentId, data) {
  if (!property) return { x: gridW() * TILE_SIZE / 2, y: gridH() * TILE_SIZE / 2, facing: "down", pose: "idle" };

  const state = data.state || "idle";
  const fallback = { x: gridW() * TILE_SIZE / 2, y: gridH() * TILE_SIZE / 2, facing: "down", pose: "idle" };

  const allStations = collectStations(property);
  if (!allStations.length) return fallback;

  const behavior = furnitureBehaviors[state];
  const result = resolveStation(agentId, state, allStations, stationOccupants, behavior, { x: 0, y: 0 });

  return result || fallback;
}

// --- WebSocket ---

let ws = null;

function connect() {
  const wsUrl = CONFIG.wsUrl || CONFIG.hubWsUrl || HUB_WS_URL;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "snapshot":
        if (msg.property) {
          applyPropertyData(msg.property);
        } else if (msg.properties) {
          const first = Object.values(msg.properties)[0];
          if (first) applyPropertyData(first);
        }
        for (const [id, data] of Object.entries(msg.agents)) {
          handleAgentUpdate(id, data);
        }
        break;
      case "property_update":
        applyPropertyData(msg.property);
        // Detect task completions and show toasts
        for (const asset of msg.property?.assets || []) {
          if (!asset.task) continue;
          let status = 'idle';
          try {
            const d = typeof asset.content?.data === 'string' ? JSON.parse(asset.content.data) : asset.content?.data;
            if (d?.status) status = d.status;
          } catch {}
          const prev = taskPrevStatus.get(asset.station);
          taskPrevStatus.set(asset.station, status);
          if (status === 'done' && prev && prev !== 'done') {
            let preview = '';
            try {
              const d = typeof asset.content?.data === 'string' ? JSON.parse(asset.content.data) : asset.content?.data;
              if (d?.result) preview = String(d.result).replace(/<[^>]*>/g, '').slice(0, 80);
            } catch {}
            showTaskToast(asset, preview);
          }
        }
        // Auto-refresh open modals (skip if user is editing a text field)
        const modalEl = document.getElementById('station-modal');
        const isEditing = modalEl && modalEl.contains(document.activeElement) &&
          (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT');
        if (!isEditing) {
          if (openReceptionStation && msg.property?.assets) {
            const asset = msg.property.assets.find(a => a.station === openReceptionStation && a.reception);
            if (asset) showReception(asset);
          }
          if (openTaskStation && msg.property?.assets) {
            const asset = msg.property.assets.find(a => a.station === openTaskStation && a.task);
            if (asset) showTask(asset);
          }
        }
        break;
      case "agent_update":
        handleAgentUpdate(msg.agent_id, msg);
        break;
      case "agent_removed":
        agents.delete(msg.agent_id);
        characters.delete(msg.agent_id);
        agentLastSeen.delete(msg.agent_id);
        bubbleShowUntil.delete(msg.agent_id);
        bubblePinned.delete(msg.agent_id);
        for (const [, occ] of stationOccupants) occ.delete(msg.agent_id);
        break;
      case "card_travel": {
        const fp = msg.from_pos, tp = msg.to_pos;
        travelingCards.set(msg.card_id, {
          fromX: (fp.x + 0.5) * TILE_SIZE, fromY: (fp.y + 0.5) * TILE_SIZE,
          toX: (tp.x + 0.5) * TILE_SIZE, toY: (tp.y + 0.5) * TILE_SIZE,
          startTime: performance.now(), duration: 1500,
        });
        break;
      }
      case "signal":
        if (msg.station) signalFlash.set(msg.station, Date.now());
        if (msg.payload !== undefined) {
          handleSignalWithPayload(msg);
        }
        break;
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "Disconnected - reconnecting...";
    statusEl.className = "status disconnected";
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

window.reconnectWebSocket = function() {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  agents.clear();
  characters.clear();
  connect();
};

function handleSignalWithPayload(msg) {
  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const payloadStr = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload, null, 2);

  const toast = document.createElement('div');
  toast.className = 'toast';

  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = `🔔 Signal: ${msg.station}`;

  const details = document.createElement('div');
  details.className = 'toast-details';
  details.textContent = `${time} • ${msg.trigger}`;

  const payloadEl = document.createElement('pre');
  payloadEl.className = 'toast-payload';
  payloadEl.textContent = payloadStr;

  toast.appendChild(title);
  toast.appendChild(details);
  toast.appendChild(payloadEl);
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOutDown 0.3s ease-in';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

function showTaskToast(asset, preview) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cursor = 'pointer';

  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = `✅ Task complete: ${asset.station.replace(/_/g, ' ')}`;

  toast.appendChild(title);
  if (preview) {
    const prev = document.createElement('div');
    prev.className = 'toast-details';
    prev.textContent = preview;
    toast.appendChild(prev);
  }
  toast.onclick = () => { toast.remove(); showTask(asset); };
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOutDown 0.3s ease-in';
    setTimeout(() => toast.remove(), 300);
  }, 8000);
}

function updateAgentPath(agentId, data) {
  const target = getTargetPosition(agentId, data);
  const ch = characters.get(agentId);

  if (!ch) {
    // New character - spawn at target
    characters.set(agentId, {
      drawX: target.x, drawY: target.y,
      targetX: target.x, targetY: target.y,
      frame: 0, frameTimer: 0,
      facing: target.facing,
      pose: target.pose,
      targetPose: target.pose,
      targetFacing: target.facing,
      path: [],
      pathIndex: 0,
    });
    return;
  }

  // Calculate path from current position to target
  const startTX = Math.floor(ch.drawX / TILE_SIZE);
  const startTY = Math.floor(ch.drawY / TILE_SIZE);
  const targetTX = Math.floor(target.x / TILE_SIZE);
  const targetTY = Math.floor(target.y / TILE_SIZE);

  const path = findPath(collisionMap, startTX, startTY, targetTX, targetTY, true, target.stationBounds);

  if (path && path.length > 0) {
    // Simplify path to remove unnecessary waypoints
    const simplified = simplifyPath(path);

    // Convert tile path to pixel waypoints
    const waypoints = simplified.map(p => ({
      x: (p.x + 0.5) * TILE_SIZE,
      y: (p.y + 0.5) * TILE_SIZE,
    }));
    waypoints.push({ x: target.x, y: target.y });
    ch.path = waypoints;
    ch.pathIndex = 0;
    ch.targetX = waypoints[0].x;
    ch.targetY = waypoints[0].y;
    ch.pose = "run"; // Walk with run animation
  } else if (path && path.length === 0) {
    // Already at destination - no movement needed
    ch.path = [];
    ch.pathIndex = 0;
    ch.targetX = target.x;
    ch.targetY = target.y;
    ch.pose = target.pose;
    ch.facing = target.facing;
  } else {
    // No path found - fallback to direct movement (ignore collision)
    ch.path = [];
    ch.pathIndex = 0;
    ch.targetX = target.x;
    ch.targetY = target.y;
    ch.pose = "run"; // Walk to destination
  }

  ch.targetPose = target.pose;
  ch.targetFacing = target.facing;
}

function handleAgentUpdate(agentId, data) {
  const prev = agents.get(agentId);
  if (!prev || prev.detail !== data.detail || prev.state !== data.state) {
    bubbleShowUntil.set(agentId, Date.now() + 8000);
  }
  agents.set(agentId, data);
  agentLastSeen.set(agentId, Date.now());
  const spriteName = data.sprite || CHARACTER_NAME;
  if (!characterSprites[spriteName]) loadCharacterSprites(spriteName);
  updateAgentPath(agentId, data);
}

// --- Rendering ---

function drawPropertyTiles() {
  if (!property) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, 0, gridW() * TILE_SIZE, gridH() * TILE_SIZE);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, gridW() * TILE_SIZE, gridH() * TILE_SIZE);
    ctx.fillStyle = "#666";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("No property configured", gridW() * TILE_SIZE / 2, gridH() * TILE_SIZE / 2);
    return;
  }

  drawTileLayer(property.floor || property.ground, 0, 0);

  // Floor-level animated assets
  for (const asset of property.assets || []) {
    if (!asset.floor || !asset.position || !asset.sprite?.file) continue;
    drawAnimatedSprite(asset.sprite.file, asset.position.x, asset.position.y, asset.sprite.width || 1, 8, 0, 0);
  }

  drawTileLayer(property.objects, 0, 0);

  // Static tileset, cutout, and image assets — walls first, then furniture
  for (const isWallPass of [true, false]) {
  for (const asset of property.assets || []) {
    if ((asset.layer === 'wall') !== isWallPass) continue;
    if (!asset.position || asset.sprite?.file) continue;
    const sprite = asset.sprite;
    if (sprite?.cutout || sprite?.image) {
      const img = sprite.cutout ? cutoutImages.get(sprite.cutout) : imageAssets.get(sprite.image);
      if (img?.complete && img.naturalWidth) {
        const w = sprite.pw || (sprite.width || 1) * TILE_SIZE;
        const h = sprite.ph || (sprite.height || 1) * TILE_SIZE;
        const p = sprite.padding || 0;
        // Center pixel-sized assets within their tile bounding box
        const bw = Math.ceil(w / TILE_SIZE) * TILE_SIZE;
        const bh = Math.ceil(h / TILE_SIZE) * TILE_SIZE;
        const dx = asset.position.x * TILE_SIZE + (bw - w) / 2;
        const dy = asset.position.y * TILE_SIZE + (bh - h) / 2;
        drawFrame(ctx, dx, dy, w, h, p, sprite.frame);
        if (sprite.feet) drawFeet(ctx, dx, dy, w, h, sprite.frame);
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight,
          dx + p, dy + p, w - p * 2, h - p * 2);
      }
      drawAssetIndicators(asset, 0, 0);
      continue;
    }
    if (!sprite?.tileset) continue;
    const img = tilesetImages[sprite.tileset];
    if (!img) continue;
    const w = sprite.width || 1;
    const h = sprite.height || 1;
    const ox = sprite.ox || 0;
    const oy = sprite.oy || 0;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        ctx.drawImage(img,
          (sprite.tx + dx) * TILE_SIZE + ox, (sprite.ty + dy) * TILE_SIZE + oy, TILE_SIZE, TILE_SIZE,
          (asset.position.x + dx) * TILE_SIZE, (asset.position.y + dy) * TILE_SIZE, TILE_SIZE, TILE_SIZE
        );
      }
    }
    drawAssetIndicators(asset, 0, 0);
  }
  }
}

function drawFloatingIcon(cx, topY, icon, count, badgeColor) {
  const bob = Math.sin(animTime * 2.5) * 2;
  const iy = topY + 4 + bob;
  ctx.save();
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(icon, cx, iy);
  if (count > 0) {
    const bx = cx + 6;
    const by = iy - 9;
    ctx.fillStyle = badgeColor || '#e33';
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 6px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(count > 99 ? '99+' : String(count), bx, by);
  }
  ctx.restore();
}

function drawAssetIndicators(asset, propX, propY) {
  if (!asset.position) return;
  const w = asset.width || 1;
  const h = asset.height || 1;
  const px = propX + asset.position.x * TILE_SIZE;
  const py = propY + asset.position.y * TILE_SIZE;
  const pw = w * TILE_SIZE;
  const ph = h * TILE_SIZE;
  const cx = px + pw / 2;

  // Welcome board: floating icon when content set
  if (asset.welcome) {
    if (asset.content?.data) drawFloatingIcon(cx, py, '📋', 0);
    return;
  }

  // Archive: floating icon + count badge
  if (asset.archive && asset.content?.data) {
    let cards = [];
    try {
      const d = typeof asset.content.data === 'string' ? JSON.parse(asset.content.data) : asset.content.data;
      if (Array.isArray(d)) cards = d;
    } catch {}
    if (cards.length) drawFloatingIcon(cx, py, '📦', cards.length, '#c8a84e');
    return;
  }

  // Inbox: floating icon + count badge
  if (asset.station === 'inbox' && asset.content?.data) {
    let msgs = [];
    try {
      const d = typeof asset.content.data === 'string' ? JSON.parse(asset.content.data) : asset.content.data;
      if (Array.isArray(d)) msgs = d;
    } catch {}
    if (msgs.length) drawFloatingIcon(cx, py, '📬', msgs.length, '#e33');
    return;
  }

  // Task station: floating icon based on state
  if (asset.task) {
    let status = 'idle';
    try {
      const d = typeof asset.content?.data === 'string' ? JSON.parse(asset.content.data) : asset.content?.data;
      if (d?.status) status = d.status;
    } catch {}
    const key = `${asset.position.x},${asset.position.y}`;
    const hasAgent = stationOccupants.has(key);
    if (status === 'pending') {
      drawFloatingIcon(cx, py, asset.openclaw_task ? '🔵' : '❗', 0);
    } else if (status === 'done') {
      drawFloatingIcon(cx, py, '✅', 0);
    } else if (hasAgent && status === 'idle') {
      drawFloatingIcon(cx, py, '🟢', 0);
    } else if (asset.openclaw_task && status === 'idle') {
      drawFloatingIcon(cx, py, '🔹', 0);
    }
    return;
  }

  // Signal indicator
  if (asset.trigger) {
    const cy = py + ph / 2;

    if (asset.trigger === 'manual') {
      // Manual: static dot, expanding ring only when recently fired
      const lastFire = signalFlash.get(asset.station) || 0;
      const elapsed = Date.now() - lastFire;
      if (elapsed < 2000) {
        const phase = (animTime * 4) % 1;
        const radius = 4 + phase * 12;
        const alpha = 0.6 * (1 - phase);
        ctx.strokeStyle = `rgba(255, 160, 50, ${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 160, 50, 0.7)';
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Heartbeat: expanding ring only when recently fired
      const lastFire = signalFlash.get(asset.station) || 0;
      const elapsed = Date.now() - lastFire;
      if (elapsed < 2000) {
        const phase = (animTime * 4) % 1;
        const radius = 4 + phase * 12;
        const alpha = 0.6 * (1 - phase);
        ctx.strokeStyle = `rgba(80, 160, 255, ${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    return;
  }

  // Board content dot
  if (asset.content) {
    ctx.fillStyle = 'rgba(255, 215, 0, 0.9)';
    ctx.beginPath();
    ctx.arc(px + pw - 3, py + 3, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTileLayer(tiles, ox, oy) {
  if (!tiles) return;
  const PAD = 0.5; // overdraw to prevent subpixel gaps
  for (const t of tiles) {
    const img = tilesetImages[t.src];
    if (!img) continue;
    const ax = t.ax ?? t.tx ?? 0;
    const ay = t.ay ?? t.ty ?? 0;
    ctx.drawImage(img,
      ax * TILE_SIZE, ay * TILE_SIZE, TILE_SIZE, TILE_SIZE,
      ox + t.x * TILE_SIZE - PAD, oy + t.y * TILE_SIZE - PAD, TILE_SIZE + PAD * 2, TILE_SIZE + PAD * 2
    );
  }
}

function drawAnimatedLayer() {
  if (!property) return;
  for (const a of property.animated || []) {
    drawAnimatedSprite(a.file, a.x, a.y, a.w || 1, a.fps || 8, 0, 0);
  }
  for (const asset of property.assets || []) {
    if (!asset.position || !asset.sprite?.file || asset.floor) continue;
    drawAnimatedSprite(asset.sprite.file, asset.position.x, asset.position.y, asset.sprite.width || 1, 8, 0, 0);
    drawAssetIndicators(asset, 0, 0);
  }
}

function drawAnimatedSprite(file, x, y, w, fps, propX, propY) {
  const img = animatedImages.get(file);
  if (!img?.complete || !img.naturalWidth) return;
  const fw = w * TILE_SIZE;
  const frameCount = img.naturalWidth / fw;
  const frame = Math.floor(animTime * fps) % frameCount;
  ctx.drawImage(img,
    frame * fw, 0, fw, img.naturalHeight,
    propX + x * TILE_SIZE, propY + y * TILE_SIZE, fw, img.naturalHeight
  );
}

function drawTravelingCards(now) {
  for (const [id, card] of travelingCards) {
    const elapsed = now - card.startTime;
    const t = Math.min(elapsed / card.duration, 1);
    if (t >= 1) { travelingCards.delete(id); continue; }

    // Ease in-out
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = card.fromX + (card.toX - card.fromX) * ease;
    const y = card.fromY + (card.toY - card.fromY) * ease - 20 * Math.sin(t * Math.PI);

    // Sparkle trail
    for (let i = 0; i < 3; i++) {
      const st = Math.max(0, t - (i + 1) * 0.04);
      const se = st < 0.5 ? 2 * st * st : 1 - Math.pow(-2 * st + 2, 2) / 2;
      const sx = card.fromX + (card.toX - card.fromX) * se;
      const sy = card.fromY + (card.toY - card.fromY) * se - 20 * Math.sin(st * Math.PI);
      const alpha = 0.4 * (1 - t) * (1 - i * 0.3);
      ctx.fillStyle = `rgba(240, 216, 136, ${alpha})`;
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }

    // Envelope body
    ctx.fillStyle = '#f0d888';
    ctx.fillRect(x - 5, y - 3, 10, 7);
    // Flap
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 3);
    ctx.lineTo(x, y + 1);
    ctx.lineTo(x + 5, y - 3);
    ctx.closePath();
    ctx.fillStyle = '#d4bc6a';
    ctx.fill();
  }
}

function drawCharacter(ch, data) {
  const isSubagent = !!data.parent_agent_id;
  const scale = isSubagent ? 0.7 : 1;
  const facing = ch.facing || "down";
  const pose = ch.pose || "idle";

  const WAITING_MS = 90_000;
  const state = data.state || "idle";
  const isWaiting = state !== "idle" && (Date.now() - (agentLastSeen.get(data.agent_id) ?? Date.now())) > WAITING_MS;

  const spriteName = data.sprite || CHARACTER_NAME;
  const sprites = characterSprites[spriteName] || characterSprites[CHARACTER_NAME] || {};
  const sprite = sprites[pose] || sprites.idle;

  let indicatorY = ch.drawY - TILE_SIZE * scale;

  if (sprite && sprite.naturalWidth) {
    const idleDirMap = { left: 2, up: 1, right: 0, down: 3 };
    const sitDirMap = { right: 0, left: 1, up: 0, down: 0 };
    const isAnimatedPose = pose === "idle" || pose === "run";
    const dir = isAnimatedPose ? (idleDirMap[facing] ?? 3) : (sitDirMap[facing] ?? 0);

    // Auto-detect frame dimensions from sprite
    const charH = sprite.naturalHeight;
    const framesPerDir = isAnimatedPose
      ? Math.floor(sprite.naturalWidth / (4 * charH))  // assume square-ish frames, 4 dirs
      : 3;
    const charW = Math.floor(sprite.naturalWidth / (framesPerDir * 4));

    const frameX = (dir * framesPerDir + (isAnimatedPose ? ch.frame % framesPerDir : 0)) * charW;
    const maxH = TILE_SIZE * 3;
    const fitScale = charH > maxH ? maxH / charH : 1;
    const drawW = charW * scale * fitScale;
    const drawH = charH * scale * fitScale;

    // Center sprite on character position
    const drawY = ch.drawY - drawH / 2;
    indicatorY = drawY - 4;

    ctx.drawImage(sprite,
      frameX, 0, charW, charH,
      ch.drawX - drawW / 2, drawY, drawW, drawH
    );

    // Name label
    ctx.fillStyle = isSubagent ? "#7ff" : "#fff";
    ctx.font = isSubagent ? "bold 6px monospace" : "bold 8px monospace";
    ctx.textAlign = "center";
    ctx.fillText(data.agent_name || "Agent", ch.drawX, drawY - 2);

    const showBubble = bubblePinned.has(data.agent_id) || Date.now() < (bubbleShowUntil.get(data.agent_id) || 0);
    if (data.detail && showBubble) {
      const bubbleText = bubblePinned.has(data.agent_id) ? `[${data.state || 'idle'}] ${data.detail}` : data.detail;
      drawBubble(ch.drawX, drawY - 10, bubbleText);
    }
  } else {
    // Fallback circle
    const sz = TILE_SIZE * scale;
    indicatorY = ch.drawY - sz / 2 - 4;

    ctx.fillStyle = "#7BBF7B";
    ctx.beginPath();
    ctx.arc(ch.drawX, ch.drawY, sz / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isSubagent ? "#7ff" : "#fff";
    ctx.font = isSubagent ? "bold 6px monospace" : "bold 8px monospace";
    ctx.textAlign = "center";
    ctx.fillText(data.agent_name || "Agent", ch.drawX, ch.drawY - sz / 2 - 2);

    const showBubble = bubblePinned.has(data.agent_id) || Date.now() < (bubbleShowUntil.get(data.agent_id) || 0);
    if (data.detail && showBubble) {
      const bubbleText = bubblePinned.has(data.agent_id) ? `[${data.state || 'idle'}] ${data.detail}` : data.detail;
      drawBubble(ch.drawX, ch.drawY - sz / 2 - 10, bubbleText);
    }
  }

  if (isWaiting) {
    drawWaitingIndicator(ch.drawX, indicatorY);
  }
}

function drawWaitingIndicator(x, y) {
  const r = 6;
  const pulse = 0.6 + 0.4 * Math.sin(animTime * 3);
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.fillStyle = "#ffe066";
  ctx.beginPath();
  ctx.arc(x, y - r, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "bold 8px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", x, y - r);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

function drawBubble(x, y, text) {
  ctx.font = "9px monospace";

  // Wrap text into multiple lines
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > BUBBLE_MAX_WIDTH && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }

  // Limit to 4 lines
  const maxLines = 4;
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, -3) + '...';
  }

  // Calculate bubble dimensions
  const maxLineWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
  const bw = maxLineWidth + BUBBLE_PAD * 2;
  const bh = lines.length * BUBBLE_LINE_HEIGHT + BUBBLE_PAD * 2;
  const bx = x - bw / 2;
  const by = y - bh;

  // Draw bubble background
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.fill();

  // Draw text lines
  ctx.fillStyle = "#eee";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    ctx.fillText(line, x, by + BUBBLE_PAD + i * BUBBLE_LINE_HEIGHT);
  });
  ctx.textBaseline = "alphabetic";
}

// --- Camera Input ---

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const oldZoom = camera.zoom;
  camera.zoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  camera.zoom = Math.max(0.5, Math.min(6, camera.zoom));

  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left - rect.width / 2;
  const my = e.clientY - rect.top - rect.height / 2;
  const worldBefore = { x: mx / oldZoom - camera.x, y: my / oldZoom - camera.y };
  camera.x = mx / camera.zoom - worldBefore.x;
  camera.y = my / camera.zoom - worldBefore.y;
}, { passive: false });

// Pinch-to-zoom
let pinchStartDist = 0;
let pinchStartZoom = 1;
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
    pinchStartZoom = camera.zoom;
  }
}, { passive: false });
canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    camera.zoom = Math.max(0.5, Math.min(6, pinchStartZoom * (dist / pinchStartDist)));
  }
}, { passive: false });

let pointerDownPos = null;
let hasDragged = false;

canvas.addEventListener("pointerdown", (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY, pointerType: e.pointerType };
  hasDragged = false;
  dragStart = { x: e.clientX, y: e.clientY };
  camStart = { x: camera.x, y: camera.y };
  canvas.setPointerCapture(e.pointerId);
  // Close nav drawer on canvas interaction
  const drawer = document.getElementById('nav-drawer');
  if (drawer) drawer.classList.remove('open');
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  // Require movement before treating as drag (20px for touch, 10px for mouse)
  const threshold = pointerDownPos.pointerType === 'touch' ? 20 : 10;
  if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
    dragging = true;
    hasDragged = true;
  }
  if (!dragging) return;
  camera.x = camStart.x + (e.clientX - dragStart.x) / camera.zoom;
  camera.y = camStart.y + (e.clientY - dragStart.y) / camera.zoom;
});

canvas.addEventListener("pointerup", (e) => {
  if (!hasDragged && pointerDownPos) {
    handleCanvasClick(e);
  }
  dragging = false;
  pointerDownPos = null;
  hasDragged = false;
});

// --- Title Logo ---

function drawTitle() {
  const cx = 22;
  const cy = (canvas.clientHeight || canvas.height) - 26;
  const dw = 7;
  const dh = 11;

  // Diamond shape
  ctx.beginPath();
  ctx.moveTo(cx, cy - dh);
  ctx.lineTo(cx + dw, cy);
  ctx.lineTo(cx, cy + dh);
  ctx.lineTo(cx - dw, cy);
  ctx.closePath();
  ctx.fillStyle = "rgba(33, 185, 107, 0.8)";
  ctx.fill();

  // Title text
  ctx.font = "italic bold 18px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("The Agents", cx + dw + 6, cy);
  ctx.textAlign = "center";
}

// --- Render Loop ---

let lastTime = 0;
let needsCenter = true;

function centerCamera() {
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (cssW > 0 && cssH > 0) {
    const worldW = gridW() * TILE_SIZE;
    const worldH = gridH() * TILE_SIZE;
    camera.x = -worldW / 2;
    camera.y = -worldH / 2;
    const zoomX = cssW / worldW;
    const zoomY = cssH / worldH;
    camera.zoom = Math.max(0.5, Math.min(6, Math.min(zoomX, zoomY) * 0.9));
  }
}

function loop(time) {
  try {
    const dt = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    if (needsCenter && (canvas.clientWidth || canvas.width) > 0) {
      centerCamera();
      needsCenter = false;
    }

    // Update character positions + animation
    for (const [, ch] of characters) {
      const dx = ch.targetX - ch.drawX;
      const dy = ch.targetY - ch.drawY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > WAYPOINT_THRESHOLD) {
        const t = 1 - Math.exp(-LERP_SPEED * dt);
        ch.drawX += dx * t;
        ch.drawY += dy * t;

        // Update facing direction while moving
        if (Math.abs(dx) > Math.abs(dy)) {
          ch.facing = dx > 0 ? "right" : "left";
        } else if (Math.abs(dy) > 0.5) {
          ch.facing = dy > 0 ? "down" : "up";
        }
      } else {
        // Close enough to current waypoint
        ch.drawX = ch.targetX;
        ch.drawY = ch.targetY;

        // Advance to next waypoint if path exists
        if (ch.path && ch.path.length > 0 && ch.pathIndex < ch.path.length - 1) {
          ch.pathIndex++;
          ch.targetX = ch.path[ch.pathIndex].x;
          ch.targetY = ch.path[ch.pathIndex].y;
        } else if (ch.path && ch.path.length > 0 && ch.pathIndex === ch.path.length - 1) {
          // Reached final destination - apply target pose and facing
          ch.pose = ch.targetPose || "idle";
          ch.facing = ch.targetFacing || ch.facing;
          ch.path = []; // Clear path
        }
      }

      ch.frameTimer += dt;
      if (ch.frameTimer >= 1 / ANIM_FPS) {
        ch.frameTimer -= 1 / ANIM_FPS;
        ch.frame = (ch.frame + 1) % 60; // wrap at high value; drawCharacter uses % framesPerDir
      }
    }

    // Draw
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    ctx.fillStyle = "#0e1e2a";
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.translate(cssW / 2, cssH / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(camera.x, camera.y);

    animTime += dt;

    // Property tiles
    drawPropertyTiles();
    drawAnimatedLayer();

    // Characters (sorted by Y for depth)
    const charList = [];
    for (const [agentId, ch] of characters) {
      const data = agents.get(agentId);
      if (!data) continue;
      charList.push({ ch, data });
    }
    charList.sort((a, b) => a.ch.drawY - b.ch.drawY);
    for (const { ch, data } of charList) {
      drawCharacter(ch, data);
    }

    // Traveling cards
    drawTravelingCards(time);

    ctx.restore();

    // Title logo — "The Agents" bottom-left
    drawTitle();
  } catch (err) {
    console.error("[viewer] Render error:", err);
  }
  requestAnimationFrame(loop);
}

// --- Init ---

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  if (w > 0 && h > 0) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

// --- Station Click Handler ---

const STATION_DESCRIPTIONS = {
  thinking: "Agents come here when analyzing problems, reasoning through logic, or considering approaches.",
  planning: "Agents come here when designing architectures, planning implementations, or strategizing solutions.",
  reflecting: "Agents come here when reviewing their work, reconsidering approaches, or learning from results.",
  reading: "Agents come here when reading files, documentation, or understanding existing code.",
  searching: "Agents come here when searching for files, code patterns, or specific functionality.",
  browsing: "Agents come here when browsing the web, fetching URLs, or researching online.",
  querying: "Agents come here when querying databases, APIs, or external services.",
  writing_code: "Agents come here when writing or editing code files.",
  writing_text: "Agents come here when writing documentation, messages, or text content.",
  generating: "Agents come here when generating assets, outputs, or derived content.",
  idle: "Agents wait here when finished with tasks or awaiting further instructions.",
  user_input: "Agents come here when asking questions or requesting user input.",
};

function screenToWorld(screenX, screenY) {
  const rect = canvas.getBoundingClientRect();
  const canvasX = screenX - rect.left;
  const canvasY = screenY - rect.top;
  const cssW = rect.width;
  const cssH = rect.height;
  const worldX = (canvasX - cssW / 2) / camera.zoom - camera.x;
  const worldY = (canvasY - cssH / 2) / camera.zoom - camera.y;
  return { x: worldX, y: worldY };
}

function findAssetAt(worldX, worldY) {
  if (!property || !property.assets) return null;
  const tileX = Math.floor(worldX / TILE_SIZE);
  const tileY = Math.floor(worldY / TILE_SIZE);

  let wallHit = null;
  for (const asset of property.assets) {
    if (!asset.position) continue;
    const ax = asset.position.x;
    const ay = asset.position.y;
    const sprite = asset.sprite;
    if (sprite?.pw || sprite?.ph) {
      const px = ax * TILE_SIZE;
      const py = ay * TILE_SIZE;
      if (worldX >= px && worldX < px + (sprite.pw || TILE_SIZE) &&
          worldY >= py && worldY < py + (sprite.ph || TILE_SIZE)) {
        if (asset.layer === 'wall') { wallHit = wallHit || asset; continue; }
        return asset;
      }
      continue;
    }
    const w = sprite?.width || 1;
    const h = sprite?.height || 1;
    if (tileX >= ax && tileX < ax + w && tileY >= ay && tileY < ay + h) {
      if (asset.layer === 'wall') { wallHit = wallHit || asset; continue; }
      return asset;
    }
  }
  return wallHit;
}

function showTapRipple(x, y) {
  const ripple = document.createElement('div');
  ripple.className = 'tap-ripple';
  ripple.style.left = x + 'px';
  ripple.style.top = y + 'px';
  document.body.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove());
}

async function handleCanvasClick(e) {
  const world = screenToWorld(e.clientX, e.clientY);

  // Check if clicking on a character (toggle bubble)
  const hitRadius = TILE_SIZE * 0.8;
  for (const [id, ch] of characters) {
    const dx = world.x - ch.drawX;
    const dy = world.y - ch.drawY;
    if (dx * dx + dy * dy < hitRadius * hitRadius) {
      if (bubblePinned.has(id)) bubblePinned.delete(id);
      else bubblePinned.add(id);
      showTapRipple(e.clientX, e.clientY);
      return;
    }
  }

  const asset = findAssetAt(world.x, world.y);

  if (!asset) return;

  // Tap feedback
  showTapRipple(e.clientX, e.clientY);

  // Determine what type of info to show (reception before trigger — reception has trigger: "manual")
  if (asset.reception) {
    showReception(asset);
  } else if (asset.task) {
    showTask(asset);
  } else if (asset.trigger) {
    showSignalInfo(asset);
  } else if (asset.logger || asset.name?.toLowerCase().includes('log')) {
    await showActivityLog(asset);
  } else if (asset.welcome) {
    showWelcomeBoard(asset);
  } else if (asset.archive) {
    showArchive(asset);
  } else if (asset.station === 'inbox') {
    showInboxMessages(asset);
  } else if (asset.remote_url && asset.remote_station) {
    await showRemoteBoard(asset);
  } else if (asset.station) {
    showStationInfo(asset);
  } else if (asset.sprite?.image) {
    showImageLightbox(asset);
  } else if (!asset.layer) {
    showModal(asset.name || 'Furniture', 'A piece of furniture on the property.');
  }
}

function showImageLightbox(asset) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  const img = document.createElement('img');
  img.src = `${HUB_HTTP_URL}/assets/images/${asset.sprite.image}`;
  overlay.appendChild(img);
  document.body.appendChild(overlay);
  const openedAt = Date.now();
  const close = () => overlay.remove();
  overlay.addEventListener('click', () => { if (Date.now() - openedAt > 400) close(); });
  document.addEventListener('keydown', e => e.key === 'Escape' && close(), { once: true });
}

function getTaskTargets() {
  const targets = [];
  // Task stations (both regular and openclaw)
  for (const a of property?.assets || []) {
    if (!a.task || !a.station) continue;
    let status = 'idle';
    try { if (a.content?.data) status = JSON.parse(a.content.data).status || 'idle'; } catch {}
    const icon = a.openclaw_task ? ' \ud83e\udd16' : '';
    targets.push({ type: 'task', station: a.station, label: a.station.replace(/_/g, ' ') + icon, busy: status !== 'idle' });
  }
  // Signal stations (for Claude Code agents)
  for (const a of property?.assets || []) {
    if (!a.trigger || a.trigger !== 'manual' || a.task) continue;
    targets.push({ type: 'signal', station: a.station, label: `${a.station.replace(/_/g, ' ')} (signal)`, busy: false });
  }
  return targets;
}

function buildTargetSelect(targets) {
  const select = document.createElement('select');
  select.className = 'form-input';
  select.style.fontSize = '11px';
  select.style.padding = '2px 4px';
  select.style.maxWidth = '180px';
  const placeholder = document.createElement('option');
  placeholder.textContent = 'Route to...';
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  for (const t of targets) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ type: t.type, station: t.station });
    opt.textContent = t.label + (t.busy ? ' (busy)' : '');
    opt.disabled = t.busy;
    select.appendChild(opt);
  }
  return select;
}

async function processInboxMessage(target, messageText, sender, btn) {
  btn.disabled = true;
  btn.textContent = 'Sending...';
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.apiKey) headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;

  try {
    const res = await fetch(`${HUB_HTTP_URL}/api/signals/fire`, {
      method: 'POST', headers,
      body: JSON.stringify({ station: target.station, payload: { from: sender, text: messageText } }),
    });
    if (res.ok) { btn.textContent = 'Fired'; return; }
    btn.textContent = 'Error';
  } catch { btn.textContent = 'Failed'; }
  btn.disabled = false;
}

function buildPropertySummary() {
  const assets = property?.assets || [];
  const ownerName = property?.owner_name || 'Unknown';
  const stations = [];
  const tasks = [];
  const signals = [];
  const receptions = [];
  let hasInbox = false;

  for (const a of assets) {
    if (!a.station) continue;
    if (a.task) {
      tasks.push({ name: a.station, instructions: a.instructions || null, openclaw: !!a.openclaw_task });
    } else if (a.reception) {
      receptions.push(a.station);
    } else if (a.trigger) {
      signals.push({ name: a.station, trigger: a.trigger, interval: a.trigger_interval });
    } else if (a.station.startsWith('inbox')) {
      hasInbox = true;
    } else if (!a.welcome && !a.archive && !a.logger) {
      stations.push(a.station);
    }
  }

  const activeAgents = [];
  for (const [, ag] of agents) {
    if (ag.parent_agent_id) continue;
    activeAgents.push({ name: ag.agent_name, state: ag.state, detail: ag.detail });
  }

  return { ownerName, stations, tasks, signals, receptions, hasInbox, activeAgents };
}

function renderPropertySummary(container) {
  const s = buildPropertySummary();

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:12px;margin-bottom:4px;';
  heading.textContent = `${s.ownerName}'s property`;
  container.appendChild(heading);

  const intro = document.createElement('div');
  intro.className = 'text-muted section-mb';
  intro.style.fontSize = '11px';
  intro.textContent = 'This is an AI agent workspace. Agents walk to furniture as they work. Click on any piece of furniture to see what it does or interact with it.';
  container.appendChild(intro);

  // Active agents
  if (s.activeAgents.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'section-mb';
    const label = document.createElement('div');
    label.className = 'text-muted';
    label.style.fontSize = '11px';
    label.textContent = 'Active agents:';
    sec.appendChild(label);
    for (const ag of s.activeAgents) {
      const line = document.createElement('div');
      line.style.cssText = 'font-size:12px;padding:2px 0;';
      line.textContent = `  ${ag.name} — ${ag.state}${ag.detail ? ': ' + ag.detail.slice(0, 60) : ''}`;
      sec.appendChild(line);
    }
    container.appendChild(sec);
  }

  // Stations
  if (s.stations.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'section-mb';
    const label = document.createElement('div');
    label.className = 'text-muted';
    label.style.fontSize = '11px';
    label.textContent = 'Stations — places agents walk to for different activities:';
    sec.appendChild(label);
    const val = document.createElement('div');
    val.style.cssText = 'font-size:12px;padding:2px 0;';
    val.textContent = `  ${s.stations.map(st => st.replace(/_/g, ' ')).join(', ')}`;
    sec.appendChild(val);
    container.appendChild(sec);
  }

  // Tasks
  if (s.tasks.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'section-mb';
    const label = document.createElement('div');
    label.className = 'text-muted';
    label.style.fontSize = '11px';
    label.textContent = 'Task stations — click these to send a request to an agent:';
    sec.appendChild(label);
    for (const t of s.tasks) {
      const line = document.createElement('div');
      line.style.cssText = 'font-size:12px;padding:2px 0;';
      line.textContent = `  ${t.name.replace(/_/g, ' ')}${t.instructions ? ' — ' + t.instructions.slice(0, 50) : ''}${t.openclaw ? ' (auto)' : ''}`;
      sec.appendChild(line);
    }
    container.appendChild(sec);
  }

  // Receptions
  if (s.receptions.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'section-mb';
    const label = document.createElement('div');
    label.className = 'text-muted';
    label.style.fontSize = '11px';
    label.textContent = 'Reception desks — ask a question and get an answer:';
    sec.appendChild(label);
    const val = document.createElement('div');
    val.style.cssText = 'font-size:12px;padding:2px 0;';
    val.textContent = `  ${s.receptions.map(r => r.replace(/_/g, ' ')).join(', ')}`;
    sec.appendChild(val);
    container.appendChild(sec);
  }

  // Signals
  if (s.signals.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'section-mb';
    const label = document.createElement('div');
    label.className = 'text-muted';
    label.style.fontSize = '11px';
    label.textContent = 'Signals — triggers that tell agents to do something:';
    sec.appendChild(label);
    for (const sig of s.signals) {
      const line = document.createElement('div');
      line.style.cssText = 'font-size:12px;padding:2px 0;';
      const name = sig.name.replace(/_/g, ' ');
      line.textContent = `  ${name}${sig.trigger === 'heartbeat' ? ` (every ${sig.interval || 60}s)` : ' (manual)'}`;
      sec.appendChild(line);
    }
    container.appendChild(sec);
  }

  if (s.hasInbox) {
    const sec = document.createElement('div');
    sec.className = 'section-mb';
    const label = document.createElement('div');
    label.className = 'text-muted';
    label.style.fontSize = '11px';
    label.textContent = 'Inbox — add messages for agents:';
    sec.appendChild(label);
    const val = document.createElement('div');
    val.style.cssText = 'font-size:12px;padding:2px 0;';
    val.textContent = '  available';
    sec.appendChild(val);
    container.appendChild(sec);
  }

  if (s.stations.length === 0 && s.tasks.length === 0 && s.signals.length === 0 && s.receptions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'text-muted';
    empty.style.fontSize = '12px';
    empty.textContent = 'No stations configured yet.';
    container.appendChild(empty);
  }
}

function showPropertyInfo() {
  const existing = document.getElementById('station-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'station-modal';
  modal.className = 'modal-backdrop';

  const box = document.createElement('div');
  box.className = 'modal-box scrollable';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'About This Property';
  box.appendChild(title);

  renderPropertySummary(box);

  const tip = document.createElement('div');
  tip.className = 'text-muted section-mt';
  tip.style.fontSize = '11px';
  tip.textContent = 'Click on any furniture to interact with it.';
  box.appendChild(tip);

  modal.appendChild(box);
  const openedAt = Date.now();
  modal.addEventListener('click', (e) => {
    if (e.target === modal && Date.now() - openedAt > 400) modal.remove();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(modal);
}

async function showWelcomeBoard(asset) {
  const isAuthed = !!CONFIG.apiKey;

  // Non-authed visitors just see the property info
  if (!isAuthed) return showPropertyInfo();

  let currentText = asset.content?.data || '';

  // Fetch default welcome text if no custom content exists
  if (!currentText) {
    try {
      const res = await fetch(`${HUB_HTTP_URL}/api/welcome/default`);
      if (res.ok) { const { text } = await res.json(); currentText = text; }
    } catch {}
  }

  const existing = document.getElementById('station-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'station-modal';
  modal.className = 'modal-backdrop';

  const box = document.createElement('div');
  box.className = 'modal-box scrollable';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = 'About This Property';
  box.appendChild(title);

  // Human-readable property summary
  renderPropertySummary(box);

  // Divider before agent section
  if (isAuthed) {
    const divider = document.createElement('hr');
    divider.style.cssText = 'border:none;border-top:1px solid #333;margin:12px 0;';
    box.appendChild(divider);

    const agentLabel = document.createElement('div');
    agentLabel.className = 'text-muted section-mb';
    agentLabel.style.fontSize = '11px';
    agentLabel.textContent = 'Agent welcome message (shown to agents on connect):';
    box.appendChild(agentLabel);

    const textarea = document.createElement('textarea');
    textarea.rows = 10;
    textarea.className = 'form-textarea';
    textarea.style.cssText = 'width:100%;font-family:monospace;font-size:11px;resize:vertical;';
    textarea.value = currentText;
    box.appendChild(textarea);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'btn btn-primary';
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const res = await fetch(`${HUB_HTTP_URL}/api/assets/${encodeURIComponent(asset.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
          body: JSON.stringify({ content: { type: 'markdown', data: textarea.value } }),
        });
        if (res.ok) { saveBtn.textContent = 'Saved'; setTimeout(() => saveBtn.textContent = 'Save', 2000); }
        else { saveBtn.textContent = 'Failed'; }
      } catch { saveBtn.textContent = 'Failed'; }
      saveBtn.disabled = false;
    };
    btnRow.appendChild(saveBtn);

    const genBtn = document.createElement('button');
    genBtn.textContent = 'Generate Default';
    genBtn.className = 'btn btn-accent';
    genBtn.onclick = async () => {
      genBtn.disabled = true;
      genBtn.textContent = 'Generating...';
      try {
        const res = await fetch(`${HUB_HTTP_URL}/api/welcome/default`);
        if (res.ok) {
          const { text } = await res.json();
          textarea.value = text;
          genBtn.textContent = 'Generated';
          setTimeout(() => genBtn.textContent = 'Generate Default', 2000);
        } else { genBtn.textContent = 'Failed'; }
      } catch { genBtn.textContent = 'Failed'; }
      genBtn.disabled = false;
    };
    btnRow.appendChild(genBtn);

    if (currentText) {
      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear';
      clearBtn.className = 'btn btn-danger';
      clearBtn.onclick = async () => {
        clearBtn.disabled = true;
        try {
          await fetch(`${HUB_HTTP_URL}/api/assets/${encodeURIComponent(asset.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
            body: JSON.stringify({ content: { type: 'markdown', data: '' } }),
          });
          textarea.value = '';
        } catch {}
        clearBtn.disabled = false;
      };
      btnRow.appendChild(clearBtn);
    }

    box.appendChild(btnRow);
  }

  modal.appendChild(box);
  const openedAt = Date.now();
  modal.addEventListener('click', (e) => {
    if (e.target === modal && Date.now() - openedAt > 400) modal.remove();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(modal);
}

function showArchive(asset) {
  let cards = [];
  try {
    if (asset.content?.data) {
      const parsed = typeof asset.content.data === 'string' ? JSON.parse(asset.content.data) : asset.content.data;
      if (Array.isArray(parsed)) cards = parsed;
    }
  } catch {}

  showModal('\ud83d\udce6 Archive', cards.length ? '' : 'No archived cards.', cards.length > 0, null, null, null, (box) => {
    if (!cards.length) return;
    const contentEl = box.querySelector('.modal-content');
    if (contentEl) contentEl.remove();

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:8px;';

    for (const c of cards) {
      const card = document.createElement('div');
      card.style.cssText = 'border-left:3px solid #f0d888;border-radius:6px;padding:8px;background:linear-gradient(135deg,rgba(30,25,15,0.6),rgba(0,0,0,0.2));';

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#aaa;margin-bottom:4px;';
      const from = document.createElement('span');
      from.style.cssText = 'font-weight:bold;color:#f0d888;';
      from.textContent = '\u2709\ufe0f ' + (c.from || 'Unknown');
      const headerRight = document.createElement('span');
      headerRight.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const time = document.createElement('span');
      time.textContent = c.completedAt ? new Date(c.completedAt).toLocaleString() : '';
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Delete card';
      delBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:13px;padding:0 2px;line-height:1;';
      delBtn.onmouseenter = () => delBtn.style.color = '#e55';
      delBtn.onmouseleave = () => delBtn.style.color = '#888';
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        // Recalculate index from current DOM order
        const currentCards = [...list.children];
        const idx = currentCards.indexOf(card);
        if (idx === -1) return;
        try {
          const res = await fetch(`${HUB_HTTP_URL}/api/archive/${idx}`, {
            method: 'DELETE',
            headers: CONFIG.apiKey ? { Authorization: `Bearer ${CONFIG.apiKey}` } : {},
          });
          if (res.ok) card.remove();
        } catch { /* ignore */ }
        delBtn.disabled = false;
      };
      headerRight.appendChild(time);
      headerRight.appendChild(delBtn);
      header.appendChild(from);
      header.appendChild(headerRight);

      const text = document.createElement('div');
      text.style.cssText = 'font-size:12px;white-space:pre-wrap;word-break:break-word;margin-bottom:6px;';
      text.textContent = c.text || '';

      card.appendChild(header);
      card.appendChild(text);

      if (c.result) {
        const result = document.createElement('div');
        result.className = 'rich-content';
        result.style.cssText = 'font-size:11px;border-top:1px solid rgba(255,255,255,0.1);padding-top:6px;';
        result.innerHTML = sanitizeHTML(c.result);
        card.appendChild(result);
      }

      list.appendChild(card);
    }
    box.insertBefore(list, box.querySelector('.inline-row'));
  });
}

function showInboxMessages(asset) {
  let messages = [];
  try {
    if (asset.content?.data) {
      const parsed = typeof asset.content.data === 'string'
        ? JSON.parse(asset.content.data) : asset.content.data;
      if (Array.isArray(parsed)) messages = parsed;
    }
  } catch { /* ignore parse errors */ }

  const targets = getTaskTargets();

  showModal('📬 Inbox', messages.length ? '' : 'No messages.', messages.length > 0, null, null, null, (box) => {
    // Message list
    if (messages.length) {
      const contentEl = box.querySelector('.modal-content');
      if (contentEl) contentEl.remove();

      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:8px;';

      for (const m of messages) {
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid rgba(255,255,255,0.1);border-left:3px solid #f0d888;border-radius:6px;padding:8px;background:linear-gradient(135deg,rgba(30,25,15,0.6),rgba(0,0,0,0.2));box-shadow:0 1px 4px rgba(0,0,0,0.3),inset 0 1px 0 rgba(240,216,136,0.05);';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#aaa;margin-bottom:4px;';
        const from = document.createElement('span');
        from.style.fontWeight = 'bold';
        from.style.color = '#f0d888';
        from.textContent = '\u2709\ufe0f ' + (m.from || 'Unknown');
        const headerRight = document.createElement('span');
        headerRight.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const time = document.createElement('span');
        time.textContent = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.title = 'Delete message';
        delBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:13px;padding:0 2px;line-height:1;';
        delBtn.onmouseenter = () => delBtn.style.color = '#e55';
        delBtn.onmouseleave = () => delBtn.style.color = '#888';
        delBtn.onclick = async () => {
          delBtn.disabled = true;
          const inboxName = asset.station || 'inbox';
          try {
            const res = await fetch(`${HUB_HTTP_URL}/api/inbox/${encodeURIComponent(inboxName)}/${encodeURIComponent(m.id)}`, {
              method: 'DELETE',
              headers: CONFIG.apiKey ? { Authorization: `Bearer ${CONFIG.apiKey}` } : {},
            });
            if (res.ok) card.remove();
          } catch { /* ignore */ }
          delBtn.disabled = false;
        };
        headerRight.appendChild(time);
        headerRight.appendChild(delBtn);
        header.appendChild(from);
        header.appendChild(headerRight);

        const body = document.createElement('div');
        body.style.cssText = 'font-size:12px;white-space:pre-wrap;word-break:break-word;margin-bottom:6px;';
        body.textContent = m.text || '(empty)';

        card.appendChild(header);
        if (m.mood) {
          const moodEl = document.createElement('div');
          moodEl.style.cssText = 'font-size:10px;color:#aaa;font-style:italic;margin-bottom:4px;';
          moodEl.textContent = `mood: ${m.mood}`;
          card.appendChild(moodEl);
        }
        card.appendChild(body);

        // Process row
        if (targets.length > 0) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:4px;align-items:center;';
          const select = buildTargetSelect(targets);
          const processBtn = document.createElement('button');
          processBtn.textContent = 'Process';
          processBtn.className = 'btn btn-accent';
          processBtn.style.cssText = 'font-size:11px;padding:2px 8px;';
          processBtn.onclick = async () => {
            if (!select.value) return;
            const target = JSON.parse(select.value);
            // Use card travel endpoint for task targets
            if (target.type === 'task' && m.id) {
              processBtn.disabled = true;
              processBtn.textContent = 'Sending...';
              const inboxName = asset.station || 'inbox';
              const headers = { 'Content-Type': 'application/json' };
              if (CONFIG.apiKey) headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
              try {
                const res = await fetch(`${HUB_HTTP_URL}/api/inbox/${encodeURIComponent(inboxName)}/${encodeURIComponent(m.id)}/process`, {
                  method: 'POST', headers,
                  body: JSON.stringify({ target_station: target.station }),
                });
                if (res.ok) {
                  card.style.opacity = '0.3';
                  card.style.transition = 'opacity 0.5s';
                  processBtn.textContent = 'Sent';
                } else {
                  const err = await res.json().catch(() => ({}));
                  processBtn.textContent = res.status === 409 ? 'Busy' : (err.error || 'Error');
                  processBtn.disabled = false;
                }
              } catch { processBtn.textContent = 'Failed'; processBtn.disabled = false; }
            } else {
              processInboxMessage(target, m.text || '', m.from || 'Unknown', processBtn);
            }
          };
          row.appendChild(select);
          row.appendChild(processBtn);
          card.appendChild(row);
        }

        list.appendChild(card);
      }
      box.insertBefore(list, box.querySelector('.inline-row'));
    }

    // Send form
    const form = document.createElement('div');
    form.className = 'inline-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a message...';
    input.maxLength = 2000;
    input.className = 'form-input';
    const btn = document.createElement('button');
    btn.textContent = 'Add';
    btn.className = 'btn btn-primary';
    btn.onclick = async () => {
      const text = input.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const res = await fetch(`${HUB_HTTP_URL}/api/inbox`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
          body: JSON.stringify({ from: 'Viewer', text }),
        });
        if (res.ok) {
          input.value = '';
          const modal = document.getElementById('station-modal');
          if (modal) modal.remove();
          const prop = await fetch(`${HUB_HTTP_URL}/api/property`).then(r => r.json());
          const refreshed = prop.assets?.find(a => a.station === 'inbox');
          if (refreshed) showInboxMessages(refreshed);
        }
      } catch { /* ignore */ }
      btn.disabled = false;
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    form.appendChild(input);
    form.appendChild(btn);

    if (messages.length > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear all';
      clearBtn.className = 'btn btn-danger';
      clearBtn.onclick = async () => {
        clearBtn.disabled = true;
        try {
          const res = await fetch(`${HUB_HTTP_URL}/api/inbox`, {
            method: 'DELETE',
            headers: CONFIG.apiKey ? { Authorization: `Bearer ${CONFIG.apiKey}` } : {},
          });
          if (res.ok) {
            const modal = document.getElementById('station-modal');
            if (modal) modal.remove();
            const prop = await fetch(`${HUB_HTTP_URL}/api/property`).then(r => r.json());
            const refreshed = prop.assets?.find(a => a.station === 'inbox');
            if (refreshed) showInboxMessages(refreshed);
          }
        } catch { /* ignore */ }
        clearBtn.disabled = false;
      };
      form.appendChild(clearBtn);
    }

    box.appendChild(form);
  });
}

// --- Reception station ---

let openReceptionStation = null;

function sanitizeHTML(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allowed = new Set(['P','BR','H1','H2','H3','H4','H5','H6','UL','OL','LI',
    'STRONG','EM','B','I','A','IMG','CODE','PRE','BLOCKQUOTE','TABLE','TR','TH','TD',
    'SPAN','DIV','HR','THEAD','TBODY']);
  const allowedAttrs = { A: ['href'], IMG: ['src', 'alt'] };

  function walk(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) { // element
        if (!allowed.has(child.tagName)) {
          // Replace with text content
          child.replaceWith(document.createTextNode(child.textContent));
          continue;
        }
        // Strip disallowed attributes
        const keep = allowedAttrs[child.tagName] || [];
        for (const attr of [...child.attributes]) {
          if (!keep.includes(attr.name)) {
            child.removeAttribute(attr.name);
          } else if ((attr.name === 'href' || attr.name === 'src') && attr.value.trim().toLowerCase().startsWith('javascript:')) {
            child.removeAttribute(attr.name);
          }
        }
        // Links open in new tab
        if (child.tagName === 'A') {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        walk(child);
      }
    }
  }
  walk(doc.body);
  return doc.body.innerHTML;
}

function showReception(asset) {
  const station = asset.station;
  openReceptionStation = station;

  // Agent presence
  const here = [];
  if (asset.position) {
    const key = `${asset.position.x},${asset.position.y}`;
    const occupantIds = stationOccupants.get(key);
    if (occupantIds) {
      for (const id of occupantIds) {
        const agent = agents.get(id);
        if (agent) here.push(agent);
      }
    }
  }

  let state = { status: 'idle', question: null, answer: null };
  try {
    if (asset.content?.data) state = JSON.parse(typeof asset.content.data === 'string' ? asset.content.data : JSON.stringify(asset.content.data));
  } catch {}

  const isOpen = here.length > 0;
  const agentNames = here.map(a => a.agent_name || a.agent_id).join(', ');

  // Build custom modal
  const existing = document.getElementById('station-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'station-modal';
  modal.className = 'modal-backdrop';

  const box = document.createElement('div');
  box.className = 'modal-box scrollable';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = `\ud83d\udc64 ${station.replace(/_/g, ' ')}`;
  box.appendChild(title);

  // Copy-paste agent prompt for reception
  const recPrompt = `Man the "${station}" reception desk. Subscribe to "${station}", then loop: check_events → read_reception("${station}") → answer the question → answer_reception("${station}", "<your HTML answer>") → repeat.`;
  const recPromptWrap = document.createElement('div');
  recPromptWrap.className = 'section-mb';
  const recPromptLabel = document.createElement('div');
  recPromptLabel.className = 'text-muted';
  recPromptLabel.style.fontSize = '11px';
  recPromptLabel.style.marginBottom = '4px';
  recPromptLabel.textContent = 'Paste this into your agent to man this station:';
  const recPromptRow = document.createElement('div');
  recPromptRow.className = 'settings-row';
  const recPromptCode = document.createElement('code');
  recPromptCode.className = 'text-info';
  recPromptCode.style.flex = '1';
  recPromptCode.style.wordBreak = 'break-word';
  recPromptCode.textContent = recPrompt;
  const recCopyBtn = document.createElement('button');
  recCopyBtn.textContent = 'Copy';
  recCopyBtn.className = 'btn btn-accent';
  recCopyBtn.onclick = () => {
    navigator.clipboard.writeText(recPrompt).then(() => {
      recCopyBtn.textContent = '✓ Copied';
      setTimeout(() => recCopyBtn.textContent = 'Copy', 2000);
    });
  };
  recPromptRow.appendChild(recPromptCode);
  recPromptRow.appendChild(recCopyBtn);
  recPromptWrap.appendChild(recPromptLabel);
  recPromptWrap.appendChild(recPromptRow);
  box.appendChild(recPromptWrap);

  if (!isOpen) {
    const closed = document.createElement('div');
    closed.className = 'text-muted section-pad';
    closed.textContent = 'Nobody at the desk right now.';
    box.appendChild(closed);
  } else if (state.status === 'idle') {
    const info = document.createElement('div');
    info.className = 'text-green section-mb';
    info.textContent = `${agentNames} is here`;
    box.appendChild(info);

    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.maxLength = 2000;
    textarea.placeholder = 'Ask a question...';
    textarea.className = 'form-textarea';
    box.appendChild(textarea);

    const btn = document.createElement('button');
    btn.textContent = 'Ask';
    btn.className = 'btn btn-primary section-mt';
    btn.onclick = async () => {
      const q = textarea.value.trim();
      if (!q) return;
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const res = await fetch(`${HUB_HTTP_URL}/api/reception/${encodeURIComponent(station)}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          btn.textContent = err.error || 'Error';
          btn.disabled = false;
        }
        // Modal will auto-refresh via WebSocket property_update
      } catch {
        btn.textContent = 'Failed';
        btn.disabled = false;
      }
    };
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btn.click(); }
    });
    box.appendChild(btn);
  } else if (state.status === 'pending') {
    const info = document.createElement('div');
    info.className = 'text-yellow section-mb';
    info.textContent = `${agentNames} is thinking...`;
    box.appendChild(info);

    const q = document.createElement('div');
    q.className = 'code-block';
    q.textContent = state.question;
    box.appendChild(q);

    const spinner = document.createElement('div');
    spinner.className = 'text-muted text-italic';
    spinner.textContent = 'Waiting for answer...';
    box.appendChild(spinner);
  } else if (state.status === 'answered') {
    const q = document.createElement('div');
    q.className = 'code-block text-info';
    q.textContent = state.question;
    box.appendChild(q);

    const answerEl = document.createElement('div');
    answerEl.className = 'rich-content';
    answerEl.innerHTML = sanitizeHTML(state.answer);
    box.appendChild(answerEl);

    const again = document.createElement('button');
    again.textContent = 'Ask another question';
    again.className = 'btn btn-primary section-mt';
    again.onclick = async () => {
      again.disabled = true;
      try {
        await fetch(`${HUB_HTTP_URL}/api/reception/${encodeURIComponent(station)}/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
        });
        // Will auto-refresh via property_update
      } catch {}
    };
    box.appendChild(again);
  }

  modal.appendChild(box);
  const openedAt = Date.now();
  modal.addEventListener('click', (e) => {
    if (e.target === modal && Date.now() - openedAt > 400) { modal.remove(); openReceptionStation = null; }
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { modal.remove(); openReceptionStation = null; document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(modal);
}

// --- Task station ---

let openTaskStation = null;

function showTask(asset) {
  const station = asset.station;
  openTaskStation = station;

  // Agent presence
  const here = [];
  if (asset.position) {
    const key = `${asset.position.x},${asset.position.y}`;
    const occupantIds = stationOccupants.get(key);
    if (occupantIds) {
      for (const id of occupantIds) {
        const agent = agents.get(id);
        if (agent) here.push(agent);
      }
    }
  }

  let state = { status: 'idle', result: null };
  try {
    if (asset.content?.data) state = JSON.parse(typeof asset.content.data === 'string' ? asset.content.data : JSON.stringify(asset.content.data));
  } catch {}

  const isOpen = here.length > 0;
  const agentNames = here.map(a => a.agent_name || a.agent_id).join(', ');

  const existing = document.getElementById('station-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'station-modal';
  modal.className = 'modal-backdrop';

  const box = document.createElement('div');
  box.className = 'modal-box scrollable';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = `${asset.openclaw_task ? '\ud83e\udd16' : '\u2699'} ${station.replace(/_/g, ' ')}`;
  box.appendChild(title);

  const isAuthed = !!CONFIG.apiKey;
  const canRun = asset.task_public !== false || isAuthed;

  // Task instructions — editable for authed users
  if (asset.instructions || isAuthed) {
    const descWrap = document.createElement('div');
    descWrap.className = 'section-mb';

    const desc = document.createElement('div');
    desc.className = 'text-info';
    desc.textContent = asset.instructions || '(no instructions)';
    descWrap.appendChild(desc);

    if (isAuthed) {
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Edit';
      editBtn.className = 'btn btn-ghost section-mt';
      editBtn.onclick = () => {
        desc.style.display = 'none';
        editBtn.style.display = 'none';
        const textarea = document.createElement('textarea');
        textarea.value = asset.instructions || '';
        textarea.rows = 4;
        textarea.className = 'form-textarea';
        descWrap.appendChild(textarea);
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.className = 'btn btn-primary section-mt';
        saveBtn.onclick = async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          try {
            const res = await fetch(`${HUB_HTTP_URL}/api/task/${encodeURIComponent(station)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
              body: JSON.stringify({ instructions: textarea.value }),
            });
            if (!res.ok) { saveBtn.textContent = 'Failed'; saveBtn.disabled = false; }
          } catch { saveBtn.textContent = 'Failed'; saveBtn.disabled = false; }
        };
        descWrap.appendChild(saveBtn);
        textarea.focus();
      };
      descWrap.appendChild(editBtn);
    }
    box.appendChild(descWrap);
  }

  // Assigned-to setting (openclaw stations only, authed only)
  if (CONFIG.apiKey && asset.openclaw_task) {
    const assignWrap = document.createElement('div');
    assignWrap.className = 'section-mb';
    const assignLabel = document.createElement('div');
    assignLabel.className = 'text-muted';
    assignLabel.style.fontSize = '11px';
    assignLabel.style.marginBottom = '4px';
    assignLabel.textContent = 'Assigned to:';
    const assignRow = document.createElement('div');
    assignRow.className = 'settings-row';
    const assignSelect = document.createElement('select');
    assignSelect.className = 'form-input';
    // "Anyone" option
    const anyOpt = document.createElement('option');
    anyOpt.value = '';
    anyOpt.textContent = 'Anyone';
    assignSelect.appendChild(anyOpt);
    // Add agents from the property
    const seen = new Set();
    for (const [, a] of agents) {
      const name = a.agent_name || a.agent_id;
      if (seen.has(name)) continue;
      seen.add(name);
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (asset.assigned_to && name === asset.assigned_to) opt.selected = true;
      assignSelect.appendChild(opt);
    }
    // If assigned_to is set but agent isn't online, still show it
    if (asset.assigned_to && !seen.has(asset.assigned_to)) {
      const opt = document.createElement('option');
      opt.value = asset.assigned_to;
      opt.textContent = asset.assigned_to + ' (offline)';
      opt.selected = true;
      assignSelect.appendChild(opt);
    }
    assignSelect.onchange = async () => {
      assignSelect.disabled = true;
      try {
        const res = await fetch(`${HUB_HTTP_URL}/api/task/${encodeURIComponent(station)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
          body: JSON.stringify({ assigned_to: assignSelect.value || null }),
        });
        if (!res.ok) assignSelect.disabled = false;
      } catch { assignSelect.disabled = false; }
      assignSelect.disabled = false;
    };
    assignRow.appendChild(assignSelect);
    assignWrap.appendChild(assignLabel);
    assignWrap.appendChild(assignRow);
    box.appendChild(assignWrap);
  }

  // Copy-paste agent prompt (not for openclaw_task — agent spawns on demand)
  if (!asset.openclaw_task) {
    const agentPrompt = `Do your duty. Call subscribe() then check_events() in a loop. When a task arrives, do the work and call answer_task with the result, then check_events() again.`;
    const promptWrap = document.createElement('div');
    promptWrap.className = 'section-mb';
    const promptLabel = document.createElement('div');
    promptLabel.className = 'text-muted';
    promptLabel.style.fontSize = '11px';
    promptLabel.style.marginBottom = '4px';
    promptLabel.textContent = 'Paste this into your agent to man this station:';
    const promptRow = document.createElement('div');
    promptRow.className = 'settings-row';
    const promptCode = document.createElement('code');
    promptCode.className = 'text-info';
    promptCode.style.flex = '1';
    promptCode.style.wordBreak = 'break-word';
    promptCode.textContent = agentPrompt;
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.className = 'btn btn-accent';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(agentPrompt).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => copyBtn.textContent = 'Copy', 2000);
      });
    };
    promptRow.appendChild(promptCode);
    promptRow.appendChild(copyBtn);
    promptWrap.appendChild(promptLabel);
    promptWrap.appendChild(promptRow);
    box.appendChild(promptWrap);
  }

  const isOcTask = !!asset.openclaw_task;

  // Helper: build Run button
  function buildRunUI() {
    const btn = document.createElement('button');
    btn.textContent = 'Run';
    btn.className = 'btn btn-primary';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Starting...';
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (CONFIG.apiKey) headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
        const res = await fetch(`${HUB_HTTP_URL}/api/task/${encodeURIComponent(station)}/run`, {
          method: 'POST', headers, body: JSON.stringify({}),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          btn.textContent = err.error || 'Error';
          btn.disabled = false;
        }
      } catch {
        btn.textContent = 'Failed';
        btn.disabled = false;
      }
    };
    return btn;
  }

  if (!isOpen && !isOcTask) {
    const closed = document.createElement('div');
    closed.className = 'text-muted section-pad';
    closed.textContent = 'No agent on duty \u2014 task will run when one arrives.';
    box.appendChild(closed);
  } else if (state.status === 'idle') {
    if (isOpen) {
      const info = document.createElement('div');
      info.className = 'text-green section-mb';
      info.textContent = `${agentNames} on duty`;
      box.appendChild(info);
    }

    if (canRun) {
      box.appendChild(buildRunUI());
    } else {
      const locked = document.createElement('div');
      locked.className = 'text-muted text-italic';
      locked.textContent = 'Login required to run this task.';
      box.appendChild(locked);
    }
  } else if (state.status === 'pending') {
    // Show card origin if present
    if (state.card) {
      const cardEl = document.createElement('div');
      cardEl.style.cssText = 'border-left:3px solid #f0d888;padding:6px 10px;margin-bottom:10px;background:rgba(240,216,136,0.06);border-radius:0 6px 6px 0;font-size:12px;';
      const cardHeader = document.createElement('div');
      cardHeader.style.cssText = 'color:#f0d888;font-weight:bold;margin-bottom:2px;';
      cardHeader.textContent = `\u2709\ufe0f ${state.card.from || 'Unknown'} (${state.card.source || 'inbox'})`;
      const cardText = document.createElement('div');
      cardText.style.cssText = 'color:#ccc;white-space:pre-wrap;word-break:break-word;';
      cardText.textContent = state.card.text || '';
      cardEl.appendChild(cardHeader);
      cardEl.appendChild(cardText);
      box.appendChild(cardEl);
    }

    const info = document.createElement('div');
    info.className = 'text-yellow section-mb';
    info.textContent = isOpen ? `${agentNames} is working...` : 'Agent is spinning up...';
    box.appendChild(info);

    const spinner = document.createElement('div');
    spinner.className = 'text-muted text-italic';
    spinner.textContent = 'Task in progress...';
    box.appendChild(spinner);

    if (CONFIG.apiKey) {
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.className = 'btn btn-danger section-mt';
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          await fetch(`${HUB_HTTP_URL}/api/task/${encodeURIComponent(station)}/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
          });
        } catch {}
      };
      box.appendChild(cancel);
    }
  } else if (state.status === 'done') {
    // Show card origin if present
    if (state.card) {
      const cardEl = document.createElement('div');
      cardEl.style.cssText = 'border-left:3px solid #f0d888;padding:6px 10px;margin-bottom:10px;background:rgba(240,216,136,0.06);border-radius:0 6px 6px 0;font-size:12px;';
      const cardHeader = document.createElement('div');
      cardHeader.style.cssText = 'color:#f0d888;font-weight:bold;margin-bottom:2px;';
      cardHeader.textContent = `\u2709\ufe0f ${state.card.from || 'Unknown'} (${state.card.source || 'inbox'})`;
      const cardText = document.createElement('div');
      cardText.style.cssText = 'color:#ccc;white-space:pre-wrap;word-break:break-word;';
      cardText.textContent = state.card.text || '';
      cardEl.appendChild(cardHeader);
      cardEl.appendChild(cardText);
      box.appendChild(cardEl);
    }

    const resultEl = document.createElement('div');
    resultEl.className = 'rich-content section-mb';
    resultEl.innerHTML = sanitizeHTML(state.result);
    box.appendChild(resultEl);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

    const canRerun = isOpen || isOcTask;
    const clearBtn = document.createElement('button');
    clearBtn.textContent = canRerun ? 'Accept' : 'Clear results';
    clearBtn.className = `btn ${canRerun ? 'btn-primary' : 'btn-danger'}`;
    clearBtn.onclick = async () => {
      clearBtn.disabled = true;
      try {
        await fetch(`${HUB_HTTP_URL}/api/task/${encodeURIComponent(station)}/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
        });
      } catch {}
    };
    btnRow.appendChild(clearBtn);

    // Archive button when done + has card + archive station exists
    if (state.card && property?.assets?.some(a => a.archive)) {
      const archiveBtn = document.createElement('button');
      archiveBtn.textContent = 'Archive';
      archiveBtn.className = 'btn btn-accent';
      archiveBtn.onclick = async () => {
        archiveBtn.disabled = true;
        archiveBtn.textContent = 'Archiving...';
        try {
          const headers = { 'Content-Type': 'application/json' };
          if (CONFIG.apiKey) headers['Authorization'] = `Bearer ${CONFIG.apiKey}`;
          const res = await fetch(`${HUB_HTTP_URL}/api/archive/${encodeURIComponent(station)}`, { method: 'POST', headers });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            archiveBtn.textContent = err.error || 'Error';
            archiveBtn.disabled = false;
          }
        } catch { archiveBtn.textContent = 'Failed'; archiveBtn.disabled = false; }
      };
      btnRow.appendChild(archiveBtn);
    }

    box.appendChild(btnRow);
  }

  modal.appendChild(box);
  const openedAt = Date.now();
  modal.addEventListener('click', (e) => {
    if (e.target === modal && Date.now() - openedAt > 400) { modal.remove(); openTaskStation = null; }
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { modal.remove(); openTaskStation = null; document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(modal);
}

async function showRemoteBoard(asset) {
  const station = asset.station || asset.name || 'Remote Board';
  try {
    const res = await fetch(`${HUB_HTTP_URL}/api/board/${encodeURIComponent(asset.station)}/remote`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      showModal(`📡 ${station}`, err.error || 'Failed to fetch remote board', false);
      return;
    }
    const board = await res.json();
    let text = `Remote: ${asset.remote_url}\nStation: ${asset.remote_station}\n\n`;
    if (board.content) {
      text += `--- Content (${board.content.type || 'text'}) ---\n${board.content.data}`;
      if (board.content.publishedAt) text += `\n\nPublished: ${board.content.publishedAt}`;
    } else {
      text += 'No content posted yet.';
    }
    if (board.log) text += `\n\n--- Activity Log ---\n${board.log}`;
    showModal(`📡 ${station}`, text, true);
  } catch (err) {
    showModal(`📡 ${station}`, `Failed to fetch remote board: ${err.message}`, false);
  }
}

function showStationInfo(asset) {
  const station = asset.station;
  const desc = STATION_DESCRIPTIONS[station] || "A station where agents perform work.";
  const icon = station === 'idle' ? '💤' : station.includes('writing') ? '✍️' : station.includes('reading') ? '📚' : station.includes('thinking') ? '💭' : station.includes('planning') ? '📋' : '⚙️';

  // Agent presence — match by tile position, not just station name
  let text = desc + '\n';
  const here = [];
  const key = `${asset.position.x},${asset.position.y}`;
  const occupantIds = stationOccupants.get(key);
  if (occupantIds) {
    for (const id of occupantIds) {
      const agent = agents.get(id);
      if (agent) here.push(agent);
    }
  }
  if (here.length) {
    text += '\n' + here.map(a => `${a.agent_name || a.agent_id} is here — ${a.detail || station}`).join('\n');
  } else {
    text += '\nNo one here right now.';
  }

  // Board content
  if (asset.content?.data) {
    const data = asset.content.data;
    const type = asset.content.type || 'text';
    text += `\n\n── Board ──\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
    if (asset.content.publishedAt) {
      text += `\n\nUpdated: ${new Date(asset.content.publishedAt).toLocaleString()}`;
    }
  }

  const setup = `HOW TO SET UP:\n\n1. In Property Editor, place furniture\n2. Set "Station" field to: "${station}"\n3. Agents walk here when calling:\n   update_state({ state: "${station}" })`;

  showModal(`${icon} ${station.replace(/_/g, ' ')}`, text, true, setup);
}

function showSignalInfo(asset) {
  const station = asset.station || 'Unnamed Signal';
  const trigger = asset.trigger;
  const interval = asset.trigger_interval || 60;
  const allowPayload = asset.allow_payload === true;
  const hasPayload = asset.trigger_payload !== undefined;

  let desc = `Trigger: ${trigger}\n`;
  desc += `Payload: ${allowPayload ? '✓ Enabled' : '✗ Disabled'}${hasPayload && allowPayload ? ' (configured)' : ''}\n`;
  desc += '\n';

  let setup = '';
  let editableInterval = null;

  if (trigger === 'manual') {
    desc += 'Fires manually via API or git hooks.';
    setup = 'HOW TO USE:\n\n';
    setup += '1. Tell your agent:\n';
    setup += `   "Listen to ${station} and [task] when\n`;
    setup += '   it fires"\n\n';
    setup += '2. Or add to .md agent file:\n';
    setup += `   subscribe({ name: "${station}" })\n`;
    setup += '   In a loop: check_events()\n\n';
    setup += '3. Fire the signal:\n';
    setup += `   POST /api/signals/fire\n`;
    setup += `   {"station": "${station}"`;
    if (allowPayload) {
      setup += `,\n    "payload": {"dynamic": "data"}`;
    }
    setup += `}\n\n`;
    setup += '4. Or use git hook:\n';
    setup += '   .git/hooks/post-commit calls the API\n\n';
    if (allowPayload) {
      setup += 'DUAL PAYLOAD SYSTEM:\n';
      setup += '• signal_payload: Default payload (above)\n';
      setup += '  Always sent if configured\n';
      setup += '• dynamic_payload: API request payload\n';
      setup += '  Sent when provided in API call\n';
      setup += '• Agent receives both in check_events()\n\n';
      setup += 'Example received payload:\n';
      setup += '{\n';
      if (hasPayload) {
        setup += '  "signal_payload": <default data>,\n';
      }
      setup += '  "dynamic_payload": <API data>\n';
      setup += '}\n\n';
    }
    setup += 'TIP: For .md agents, add this pattern:\n';
    setup += '━━━━━━━━━━━━━━━━\n';
    setup += `subscribe({ name: "${station}" })\n`;
    setup += 'while (true) {\n';
    setup += '  check_events()  // waits for signal\n';
    setup += '  // do your task here\n';
    setup += '}';
  } else if (trigger === 'heartbeat') {
    desc += `Fires automatically every ${interval} second${interval !== 1 ? 's' : ''}.`;
    setup = 'HOW TO USE:\n\n';
    setup += '1. Tell your agent:\n';
    setup += `   "Every ${interval} seconds, check [thing]\n`;
    setup += `   by subscribing to ${station}"\n\n`;
    setup += '2. Or add to .md agent file:\n';
    setup += `   subscribe({ name: "${station}" })\n`;
    setup += '   Loop with check_events()\n\n';
    setup += '3. Change interval: Edit above ↑\n\n';
    if (allowPayload && hasPayload) {
      setup += 'PAYLOAD:\n';
      setup += '• Signal has configured payload\n';
      setup += '• Hub must set ALLOW_SIGNAL_PAYLOADS=true\n';
      setup += '• Payload sent with each heartbeat\n\n';
    }
    setup += 'TIP: For .md agents, add this pattern:\n';
    setup += '━━━━━━━━━━━━━━━━\n';
    setup += `subscribe({ name: "${station}" })\n`;
    setup += 'while (true) {\n';
    setup += '  check_events()  // fires every interval\n';
    setup += '  // run periodic task here\n';
    setup += '}';

    editableInterval = { station, currentInterval: interval };
  }

  // Copy-paste agent prompt
  let agentPrompt;
  if (trigger === 'manual') {
    agentPrompt = `Subscribe to "${station}" and loop: check_events() → when it fires, do your task → repeat.`;
  } else {
    agentPrompt = `Subscribe to "${station}" and loop: check_events() (fires every ${interval}s) → do your periodic task → repeat.`;
  }

  const fireBtn = trigger === 'manual' ? { station } : null;
  const hasBoard = !!asset.content?.data;
  showModal(`🔔 ${station}`, desc, hasBoard, setup, editableInterval, asset, (box) => {
    // Show board content if agent has posted to this signal
    if (hasBoard) {
      const boardWrap = document.createElement('div');
      boardWrap.className = 'section-mb';
      const boardLabel = document.createElement('div');
      boardLabel.className = 'text-muted';
      boardLabel.style.cssText = 'font-size:11px;margin-bottom:6px;';
      const age = asset.content.publishedAt ? ' — ' + new Date(asset.content.publishedAt).toLocaleString() : '';
      boardLabel.textContent = `Board content (${asset.content.type || 'text'})${age}`;

      if (asset.content.type === 'html') {
        const iframe = document.createElement('iframe');
        iframe.sandbox = 'allow-same-origin';
        iframe.style.cssText = 'width:100%;border:1px solid rgba(255,255,255,0.1);border-radius:6px;background:#1a1a2e;min-height:120px;';
        iframe.srcdoc = asset.content.data;
        iframe.onload = () => {
          const h = iframe.contentDocument?.documentElement?.scrollHeight;
          if (h) iframe.style.height = Math.min(h + 4, 400) + 'px';
        };
        boardWrap.appendChild(boardLabel);
        boardWrap.appendChild(iframe);
      } else {
        const boardPre = document.createElement('pre');
        boardPre.className = 'modal-content';
        boardPre.style.cssText = 'max-height:200px;overflow:auto;margin:0;';
        boardPre.textContent = asset.content.data;
        boardWrap.appendChild(boardLabel);
        boardWrap.appendChild(boardPre);
      }

      const titleEl = box.querySelector('.modal-title');
      if (titleEl && titleEl.nextSibling) {
        box.insertBefore(boardWrap, titleEl.nextSibling);
      } else {
        box.appendChild(boardWrap);
      }
    }

    // Agent prompt section
    const promptWrap = document.createElement('div');
    promptWrap.className = 'section-mb';
    const promptLabel = document.createElement('div');
    promptLabel.className = 'text-muted';
    promptLabel.style.fontSize = '11px';
    promptLabel.style.marginBottom = '4px';
    promptLabel.textContent = 'Paste this into your agent to man this station:';
    const promptRow = document.createElement('div');
    promptRow.className = 'settings-row';
    const promptCode = document.createElement('code');
    promptCode.className = 'text-info';
    promptCode.style.flex = '1';
    promptCode.style.wordBreak = 'break-word';
    promptCode.textContent = agentPrompt;
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.className = 'btn btn-accent';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(agentPrompt).then(() => {
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => copyBtn.textContent = 'Copy', 2000);
      });
    };
    promptRow.appendChild(promptCode);
    promptRow.appendChild(copyBtn);
    promptWrap.appendChild(promptLabel);
    promptWrap.appendChild(promptRow);
    // Insert after board content (or after title if no board)
    const contentEl = box.querySelector('.modal-content');
    if (contentEl) {
      box.insertBefore(promptWrap, contentEl);
    } else {
      box.appendChild(promptWrap);
    }
  }, fireBtn);
}

function showPayloadWarning() {
  return new Promise((resolve) => {
    const warningModal = document.createElement('div');
    warningModal.className = 'modal-backdrop z-high';

    const warningBox = document.createElement('div');
    warningBox.className = 'modal-box warning';
    warningBox.style.padding = '20px';

    const warningTitle = document.createElement('div');
    warningTitle.className = 'modal-title warning';
    warningTitle.textContent = '⚠️ Security Warning';

    const warningText = document.createElement('div');
    warningText.className = 'warning-text';
    warningText.innerHTML = `
      <p><strong>Enabling payloads allows external data to be sent to AI agents.</strong></p>
      <p><strong class="risk">⚠ Risks:</strong></p>
      <ul>
        <li>Prompt injection attacks</li>
        <li>Malicious instructions in payloads</li>
        <li>Unauthorized agent actions</li>
      </ul>
      <p><strong class="safe">✓ Only enable if:</strong></p>
      <ul>
        <li>You control the payload source</li>
        <li>Payloads are validated/sanitized</li>
        <li>This is not a public-facing instance</li>
      </ul>
    `;

    const buttonRow = document.createElement('div');
    buttonRow.className = 'btn-row';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'btn btn-muted';
    cancelBtn.onclick = () => {
      warningModal.remove();
      resolve(false);
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'I Understand, Enable Payload';
    confirmBtn.className = 'btn btn-danger-bold';
    confirmBtn.onclick = () => {
      warningModal.remove();
      resolve(true);
    };

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(confirmBtn);

    warningBox.appendChild(warningTitle);
    warningBox.appendChild(warningText);
    warningBox.appendChild(buttonRow);
    warningModal.appendChild(warningBox);
    document.body.appendChild(warningModal);

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        warningModal.remove();
        resolve(false);
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

async function showActivityLog(asset) {
  const response = await fetch('/api/activity-log');
  const log = await response.json();

  let content = 'Last 100 messages, showing 20 most recent.\n\n';

  if (log.length === 0) {
    content += '(No activity yet)';
  } else {
    const recent = log.slice(-20).reverse(); // Show last 20, most recent first
    for (const entry of recent) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const detail = entry.detail.length > 60 ? entry.detail.slice(0, 60) + '...' : entry.detail;
      content += `[${time}] ${entry.agent_name}:\n  ${detail}\n\n`;
    }
  }

  let setup = 'HOW TO SET UP:\n\n';
  setup += '1. Place any furniture (bulletin board,\n';
  setup += '   logbook, etc.)\n';
  setup += '2. Name it something with "log" in it,\n';
  setup += '   OR set custom field:\n';
  setup += '   logger=true\n\n';
  setup += '3. Click on it to view activity log\n\n';
  setup += 'Logs are stored in hub memory and\n';
  setup += 'cleared on restart.';

  showModal('📋 Activity Log', content, true, setup);
}

function showModal(title, content, scrollable = false, setupInstructions = null, editableInterval = null, signalAsset = null, onReady = null, fireBtn = null) {
  // Remove existing modal if any
  const existing = document.getElementById('station-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'station-modal';
  modal.className = 'modal-backdrop';

  const box = document.createElement('div');
  box.className = 'modal-box' + (scrollable ? ' scrollable' : '');

  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;

  const contentEl = document.createElement('pre');
  contentEl.className = 'modal-content';
  contentEl.textContent = content;

  box.appendChild(titleEl);
  box.appendChild(contentEl);

  // Add payload toggle for signal assets
  if (signalAsset && signalAsset.trigger) {
    const payloadContainer = document.createElement('div');
    payloadContainer.className = 'settings-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'payload-checkbox';
    checkbox.checked = signalAsset.allow_payload === true;
    checkbox.className = 'form-checkbox';

    const label = document.createElement('label');
    label.htmlFor = 'payload-checkbox';
    label.className = 'text-label';
    label.textContent = 'Allow payload';

    const statusMsg = document.createElement('span');
    statusMsg.className = 'text-status';

    // Payload editor (shown when checkbox is checked)
    const payloadEditorContainer = document.createElement('div');
    payloadEditorContainer.className = 'section-mt';
    payloadEditorContainer.style.display = signalAsset.allow_payload ? 'block' : 'none';

    const payloadLabel = document.createElement('div');
    payloadLabel.className = 'text-muted';
    payloadLabel.style.fontSize = '11px';
    payloadLabel.style.marginBottom = '4px';
    payloadLabel.textContent = signalAsset.trigger === 'manual'
      ? 'Default payload (sent with every fire):'
      : 'Payload (JSON or text):';

    const payloadTextarea = document.createElement('textarea');
    payloadTextarea.rows = 4;
    payloadTextarea.placeholder = '{"key": "value"} or simple text';
    const currentPayload = signalAsset.trigger_payload;
    payloadTextarea.value = currentPayload !== undefined
      ? (typeof currentPayload === 'string' ? currentPayload : JSON.stringify(currentPayload, null, 2))
      : '';
    payloadTextarea.className = 'form-textarea';

    const payloadSaveBtn = document.createElement('button');
    payloadSaveBtn.textContent = 'Save Payload';
    payloadSaveBtn.className = 'btn btn-accent section-mt';

    const payloadStatusMsg = document.createElement('span');
    payloadStatusMsg.className = 'text-status';

    payloadSaveBtn.onclick = async () => {
      try {
        const propResponse = await fetch('/api/property');
        const property = await propResponse.json();
        const asset = property.assets.find(a => a.id === signalAsset.id);

        if (!asset) {
          payloadStatusMsg.textContent = '❌ Asset not found';
          payloadStatusMsg.style.color = '#d04040';
          return;
        }

        const val = payloadTextarea.value.trim();
        if (val === '') {
          delete asset.trigger_payload;
        } else {
          try {
            asset.trigger_payload = JSON.parse(val);
          } catch {
            asset.trigger_payload = val;
          }
        }

        const saveResponse = await fetch('/api/property', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
          body: JSON.stringify(property)
        });

        if (saveResponse.ok) {
          signalAsset.trigger_payload = asset.trigger_payload;
          payloadStatusMsg.textContent = '✓ Saved';
          payloadStatusMsg.style.color = '#60d060';
        } else {
          payloadStatusMsg.textContent = '❌ Save failed';
          payloadStatusMsg.style.color = '#d04040';
        }
      } catch (err) {
        payloadStatusMsg.textContent = '❌ Error';
        payloadStatusMsg.style.color = '#d04040';
      }

      setTimeout(() => payloadStatusMsg.textContent = '', 3000);
    };

    payloadEditorContainer.appendChild(payloadLabel);
    payloadEditorContainer.appendChild(payloadTextarea);
    payloadEditorContainer.appendChild(payloadSaveBtn);
    payloadEditorContainer.appendChild(payloadStatusMsg);

    checkbox.onchange = async () => {
      // Show warning when enabling payloads
      if (checkbox.checked) {
        const confirmed = await showPayloadWarning();
        if (!confirmed) {
          checkbox.checked = false;
          return;
        }
      }

      try {
        // Fetch current property
        const propResponse = await fetch('/api/property');
        const property = await propResponse.json();

        // Find and update the asset
        const asset = property.assets.find(a => a.id === signalAsset.id);
        if (!asset) {
          statusMsg.textContent = '❌ Asset not found';
          statusMsg.style.color = '#d04040';
          return;
        }

        if (checkbox.checked) {
          asset.allow_payload = true;
          statusMsg.textContent = '✓ Enabled';
          statusMsg.style.color = '#60d060';
          payloadEditorContainer.style.display = 'block';
        } else {
          delete asset.allow_payload;
          delete asset.trigger_payload;
          statusMsg.textContent = '✓ Disabled';
          statusMsg.style.color = '#60d060';
          payloadEditorContainer.style.display = 'none';
          payloadTextarea.value = '';
        }

        // Save updated property
        const saveResponse = await fetch('/api/property', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
          body: JSON.stringify(property)
        });

        if (saveResponse.ok) {
          // Update local reference
          signalAsset.allow_payload = checkbox.checked ? true : undefined;
          // Update description text
          contentEl.textContent = contentEl.textContent.replace(
            /Payload: [^\n]+/,
            `Payload: ${checkbox.checked ? '✓ Enabled' : '✗ Disabled'}`
          );
        } else {
          statusMsg.textContent = '❌ Save failed';
          statusMsg.style.color = '#d04040';
          checkbox.checked = !checkbox.checked;
        }
      } catch (err) {
        statusMsg.textContent = '❌ Error';
        statusMsg.style.color = '#d04040';
        checkbox.checked = !checkbox.checked;
      }

      setTimeout(() => statusMsg.textContent = '', 3000);
    };

    payloadContainer.appendChild(checkbox);
    payloadContainer.appendChild(label);
    payloadContainer.appendChild(statusMsg);

    box.appendChild(payloadContainer);
    box.appendChild(payloadEditorContainer);
  }

  // Add editable interval for heartbeat signals
  if (editableInterval) {
    const intervalContainer = document.createElement('div');
    intervalContainer.className = 'settings-row';

    const label = document.createElement('span');
    label.className = 'text-label';
    label.textContent = 'Interval:';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.value = editableInterval.currentInterval;
    input.className = 'form-input-sm';

    const unit = document.createElement('span');
    unit.className = 'text-muted';
    unit.textContent = 'seconds';

    const updateBtn = document.createElement('button');
    updateBtn.textContent = 'Update';
    updateBtn.className = 'btn btn-accent';
    updateBtn.style.marginLeft = 'auto';

    const statusMsg = document.createElement('span');
    statusMsg.className = 'text-status';

    updateBtn.onclick = async () => {
      const newInterval = parseInt(input.value);
      if (newInterval < 1) {
        statusMsg.textContent = '❌ Must be ≥ 1';
        statusMsg.style.color = '#d04040';
        return;
      }

      try {
        const response = await fetch('/api/signals/set-interval', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
          body: JSON.stringify({ station: editableInterval.station, interval: newInterval })
        });

        if (response.ok) {
          statusMsg.textContent = '✓ Saved';
          statusMsg.style.color = '#60d060';
          editableInterval.currentInterval = newInterval;
          // Update the description text
          contentEl.textContent = contentEl.textContent.replace(
            /every \d+ second(s)?/,
            `every ${newInterval} second${newInterval !== 1 ? 's' : ''}`
          );
        } else {
          statusMsg.textContent = '❌ Failed';
          statusMsg.style.color = '#d04040';
        }
      } catch (err) {
        statusMsg.textContent = '❌ Error';
        statusMsg.style.color = '#d04040';
      }
    };

    intervalContainer.appendChild(label);
    intervalContainer.appendChild(input);
    intervalContainer.appendChild(unit);
    intervalContainer.appendChild(updateBtn);
    intervalContainer.appendChild(statusMsg);

    box.appendChild(intervalContainer);
  }

  // Add fire button for manual signals
  if (fireBtn) {
    const fireContainer = document.createElement('div');
    fireContainer.className = 'settings-row';

    const fireButton = document.createElement('button');
    fireButton.textContent = '🔥 Fire Signal';
    fireButton.className = 'btn btn-fire';

    const fireStatus = document.createElement('span');
    fireStatus.className = 'text-status';

    fireButton.onclick = async () => {
      fireButton.disabled = true;
      fireButton.style.opacity = '0.6';
      try {
        const response = await fetch('/api/signals/fire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(CONFIG.apiKey && { Authorization: `Bearer ${CONFIG.apiKey}` }) },
          body: JSON.stringify({ station: fireBtn.station })
        });
        if (response.ok) {
          fireStatus.textContent = '✓ Fired!';
          fireStatus.style.color = '#60d060';
        } else {
          const err = await response.json().catch(() => ({}));
          fireStatus.textContent = `❌ ${err.error || 'Failed'}`;
          fireStatus.style.color = '#d04040';
        }
      } catch {
        fireStatus.textContent = '❌ Error';
        fireStatus.style.color = '#d04040';
      }
      fireButton.disabled = false;
      fireButton.style.opacity = '1';
      setTimeout(() => fireStatus.textContent = '', 3000);
    };

    fireContainer.appendChild(fireButton);
    fireContainer.appendChild(fireStatus);
    box.appendChild(fireContainer);
  }

  // Add collapsible setup instructions if provided
  if (setupInstructions) {
    const separator = document.createElement('div');
    separator.className = 'separator';

    const toggleLink = document.createElement('div');
    toggleLink.className = 'toggle-link';
    toggleLink.textContent = '► Show setup instructions';

    const setupEl = document.createElement('pre');
    setupEl.className = 'setup-content';
    setupEl.textContent = setupInstructions;

    let expanded = false;
    toggleLink.onclick = () => {
      expanded = !expanded;
      toggleLink.textContent = expanded ? '▼ Hide setup instructions' : '► Show setup instructions';
      setupEl.style.display = expanded ? 'block' : 'none';
    };

    box.appendChild(separator);
    box.appendChild(toggleLink);
    box.appendChild(setupEl);
  }

  if (onReady) onReady(box);

  modal.appendChild(box);
  document.body.appendChild(modal);

  // Close on click outside or ESC (delay to prevent synthetic touch click)
  const openedAt = Date.now();
  modal.addEventListener('click', (e) => {
    if (e.target === modal && Date.now() - openedAt > 400) modal.remove();
  });
  document.addEventListener('keydown', function closeOnEsc(e) {
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', closeOnEsc);
    }
  });
}

function showWelcome() {
  if (localStorage.getItem('the-agents-visited')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop z-top';

  const box = document.createElement('div');
  box.className = 'welcome-box';
  box.innerHTML = `
    <div class="modal-title" style="font-size:20px;">Welcome</div>
    <div>This is an agent's workspace.<br>Click furniture to see what's happening.<br>Agents walk to stations as they work.</div>
    <div class="text-muted section-mt" style="font-size:12px;">Press <strong>?</strong> or click the <strong>?</strong> button anytime for property info.</div>
    <div class="text-muted" style="font-size:12px;margin-top:4px;">Tap anywhere to continue</div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const dismiss = () => {
    overlay.remove();
    localStorage.setItem('the-agents-visited', '1');
    document.removeEventListener('keydown', dismiss);
  };
  overlay.addEventListener('click', dismiss);
  document.addEventListener('keydown', dismiss);
}

function createInfoButton() {
  const btn = document.createElement('button');
  btn.id = 'info-btn';
  btn.className = 'info-btn';
  btn.textContent = '?';
  btn.title = 'About this property';
  btn.onclick = () => showPropertyInfo();
  document.body.appendChild(btn);
}

window.addEventListener("resize", resize);
resize();

document.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H" || e.key === "Home") centerCamera();
  if (e.key === "?" && !document.getElementById('station-modal')) showPropertyInfo();
});

loadAssets().then(() => {
  connect();
  requestAnimationFrame(loop);
  showWelcome();
  createInfoButton();
});
