// Slim single-property viewer — no village map, no build mode
const CONFIG = window.VILLAGE_CONFIG || {};
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('apiKey')) CONFIG.apiKey = urlParams.get('apiKey');
const HUB_WS_URL = CONFIG.hubWsUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
const HUB_HTTP_URL = CONFIG.hubHttpUrl || '';
const ASSET_BASE = CONFIG.assetBase || '/assets';
let TILESET_URIS = CONFIG.tilesetUris || {};
const CHARACTER_BASE = CONFIG.characterBase || `${ASSET_BASE}/characters`;
const CHARACTER_NAME = CONFIG.characterName || "Yuki";
const ANIMATED_BASE = CONFIG.animatedBase || `${ASSET_BASE}/animated`;
const SPRITE_BASE = CONFIG.spriteBase || `${ASSET_BASE}/sprites`;

const POSE_SPRITES = {
  idle: "_idle_anim.png",
  sit: "_sit3.png",
  phone: "_phone.png",
  run: "_run.png",
};

var { TILE_SIZE, GRID_W, GRID_H, collectStations, resolveStation, buildCollisionMap, findPath, simplifyPath } = StationLogic;
const LERP_SPEED = 8;
const ANIM_FPS = 6;
const BUBBLE_PAD = 8;
const BUBBLE_MAX_WIDTH = 320;
const BUBBLE_LINE_HEIGHT = 12;
const WAYPOINT_THRESHOLD = 2; // Pixels - how close before advancing to next waypoint

// --- State ---
const agents = new Map();
const characters = new Map();
const tilesetImages = {};
const animatedImages = new Map();
const cutoutImages = new Map();
const characterSprites = {}; // { charName: { pose: Image } }
let animTime = 0;

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
  if (!property) return { x: GRID_W * TILE_SIZE / 2, y: GRID_H * TILE_SIZE / 2, facing: "down", pose: "idle" };

  const state = data.state || "idle";
  const fallback = { x: GRID_W * TILE_SIZE / 2, y: GRID_H * TILE_SIZE / 2, facing: "down", pose: "idle" };

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
        break;
      case "agent_update":
        handleAgentUpdate(msg.agent_id, msg);
        break;
      case "agent_removed":
        agents.delete(msg.agent_id);
        characters.delete(msg.agent_id);
        for (const [, occ] of stationOccupants) occ.delete(msg.agent_id);
        break;
      case "signal":
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

  // Create toast notification
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #2a2a48;
    border: 1px solid #5a8fff;
    border-radius: 6px;
    padding: 12px 16px;
    color: #ccc;
    font-family: monospace;
    font-size: 13px;
    max-width: 400px;
    z-index: 2000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    animation: slideIn 0.3s ease-out;
  `;

  const title = document.createElement('div');
  title.textContent = `🔔 Signal: ${msg.station}`;
  title.style.cssText = 'font-weight: bold; color: #5a8fff; margin-bottom: 6px;';

  const details = document.createElement('div');
  details.style.cssText = 'font-size: 11px; color: #888; margin-bottom: 6px;';
  details.textContent = `${time} • ${msg.trigger}`;

  const payloadEl = document.createElement('pre');
  payloadEl.textContent = payloadStr;
  payloadEl.style.cssText = `
    background: #1a1a2e;
    padding: 8px;
    border-radius: 3px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    font-size: 12px;
  `;

  toast.appendChild(title);
  toast.appendChild(details);
  toast.appendChild(payloadEl);
  document.body.appendChild(toast);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease-in';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// Add CSS animation for toast
if (!document.getElementById('signal-toast-styles')) {
  const style = document.createElement('style');
  style.id = 'signal-toast-styles';
  style.textContent = `
    @keyframes slideIn {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOut {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }
  `;
  document.head.appendChild(style);
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
  agents.set(agentId, data);
  const spriteName = data.sprite || CHARACTER_NAME;
  if (!characterSprites[spriteName]) loadCharacterSprites(spriteName);
  updateAgentPath(agentId, data);
}

// --- Rendering ---

function drawPropertyTiles() {
  if (!property) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, 0, GRID_W * TILE_SIZE, GRID_H * TILE_SIZE);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, GRID_W * TILE_SIZE, GRID_H * TILE_SIZE);
    ctx.fillStyle = "#666";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("No property configured", GRID_W * TILE_SIZE / 2, GRID_H * TILE_SIZE / 2);
    return;
  }

  drawTileLayer(property.floor || property.ground, 0, 0);

  // Floor-level animated assets
  for (const asset of property.assets || []) {
    if (!asset.floor || !asset.position || !asset.sprite?.file) continue;
    drawAnimatedSprite(asset.sprite.file, asset.position.x, asset.position.y, asset.sprite.width || 1, 8, 0, 0);
  }

  drawTileLayer(property.objects, 0, 0);

  // Static tileset and cutout assets
  for (const asset of property.assets || []) {
    if (!asset.position || asset.sprite?.file) continue;
    const sprite = asset.sprite;
    if (sprite?.cutout) {
      const img = cutoutImages.get(sprite.cutout);
      if (img?.complete && img.naturalWidth) {
        const w = (sprite.width || 1) * TILE_SIZE;
        const h = (sprite.height || 1) * TILE_SIZE;
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight,
          asset.position.x * TILE_SIZE, asset.position.y * TILE_SIZE, w, h);
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

function drawAssetIndicators(asset, propX, propY) {
  if (!asset.position) return;
  const w = asset.width || 1;
  const px = propX + asset.position.x * TILE_SIZE;
  const py = propY + asset.position.y * TILE_SIZE;
  const pw = w * TILE_SIZE;

  // Inbox: pulsing glow + count badge
  if (asset.station === 'inbox' && asset.content?.data) {
    let msgs = [];
    try {
      const d = typeof asset.content.data === 'string' ? JSON.parse(asset.content.data) : asset.content.data;
      if (Array.isArray(d)) msgs = d;
    } catch {}
    if (msgs.length) {
      const pulse = 0.25 + 0.15 * Math.sin(animTime * 3);
      ctx.fillStyle = `rgba(255, 215, 0, ${pulse})`;
      ctx.fillRect(px, py, pw, TILE_SIZE);
      // Red badge top-right
      const bx = px + pw - 4;
      const by = py + 4;
      ctx.fillStyle = '#e33';
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 7px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(msgs.length > 99 ? '99+' : String(msgs.length), bx, by);
    }
    return;
  }

  // Signal: expanding ring
  if (asset.trigger) {
    const interval = asset.trigger_interval || 60;
    const speed = Math.max(0.5, 6 / interval);
    const cx = px + pw / 2;
    const cy = py + TILE_SIZE / 2;
    const phase = (animTime * speed) % 1;
    const radius = 4 + phase * 12;
    const alpha = 0.6 * (1 - phase);
    ctx.strokeStyle = asset.trigger === 'heartbeat'
      ? `rgba(80, 160, 255, ${alpha})`
      : `rgba(255, 160, 50, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
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
  for (const t of tiles) {
    const img = tilesetImages[t.src];
    if (!img) continue;
    const ax = t.ax ?? t.tx ?? 0;
    const ay = t.ay ?? t.ty ?? 0;
    ctx.drawImage(img,
      ax * TILE_SIZE, ay * TILE_SIZE, TILE_SIZE, TILE_SIZE,
      ox + t.x * TILE_SIZE, oy + t.y * TILE_SIZE, TILE_SIZE, TILE_SIZE
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

function drawCharacter(ch, data) {
  const isSubagent = !!data.parent_agent_id;
  const scale = isSubagent ? 0.7 : 1;
  const facing = ch.facing || "down";
  const pose = ch.pose || "idle";

  const spriteName = data.sprite || CHARACTER_NAME;
  const sprites = characterSprites[spriteName] || characterSprites[CHARACTER_NAME] || {};
  const sprite = sprites[pose] || sprites.idle;

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

    ctx.drawImage(sprite,
      frameX, 0, charW, charH,
      ch.drawX - drawW / 2, drawY, drawW, drawH
    );

    // Name label
    const top = drawY;
    ctx.fillStyle = isSubagent ? "#7ff" : "#fff";
    ctx.font = isSubagent ? "bold 6px monospace" : "bold 8px monospace";
    ctx.textAlign = "center";
    ctx.fillText(data.agent_name || "Agent", ch.drawX, top - 2);

    if (data.detail) drawBubble(ch.drawX, top - 10, data.detail);
  } else {
    // Fallback circle
    const sz = TILE_SIZE * scale;
    ctx.fillStyle = "#7BBF7B";
    ctx.beginPath();
    ctx.arc(ch.drawX, ch.drawY, sz / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = isSubagent ? "#7ff" : "#fff";
    ctx.font = isSubagent ? "bold 6px monospace" : "bold 8px monospace";
    ctx.textAlign = "center";
    ctx.fillText(data.agent_name || "Agent", ch.drawX, ch.drawY - sz / 2 - 2);

    if (data.detail) drawBubble(ch.drawX, ch.drawY - sz / 2 - 10, data.detail);
  }
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
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const ratio = 1 - camera.zoom / oldZoom;
  camera.x += (mx / oldZoom - camera.x) * ratio * oldZoom / camera.zoom;
  camera.y += (my / oldZoom - camera.y) * ratio * oldZoom / camera.zoom;
}, { passive: false });

let pointerDownPos = null;
let hasDragged = false;

canvas.addEventListener("pointerdown", (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY };
  hasDragged = false;
  dragStart = { x: e.clientX, y: e.clientY };
  camStart = { x: camera.x, y: camera.y };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos.x;
  const dy = e.clientY - pointerDownPos.y;
  // Require 10 pixels of movement before treating as drag
  if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
    dragging = true;
    hasDragged = true;
  }
  if (!dragging) return;
  camera.x = camStart.x + (e.clientX - dragStart.x) / camera.zoom;
  camera.y = camStart.y + (e.clientY - dragStart.y) / camera.zoom;
});

canvas.addEventListener("pointerup", (e) => {
  if (!hasDragged && pointerDownPos) {
    // Click detected - check if user clicked on a station
    console.log('[CLICK] Detected click at', e.clientX, e.clientY);
    handleCanvasClick(e);
  }
  dragging = false;
  pointerDownPos = null;
  hasDragged = false;
});

// --- Title Logo ---

function drawTitle() {
  const cx = 22;
  const cy = canvas.height - 26;
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
  if (canvas.width > 0 && canvas.height > 0) {
    const worldW = GRID_W * TILE_SIZE;
    const worldH = GRID_H * TILE_SIZE;
    camera.x = -worldW / 2;
    camera.y = -worldH / 2;
    const zoomX = canvas.width / worldW;
    const zoomY = canvas.height / worldH;
    camera.zoom = Math.max(0.5, Math.min(6, Math.min(zoomX, zoomY) * 0.9));
  }
}

function loop(time) {
  try {
    const dt = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    if (needsCenter && canvas.width > 0) {
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
    ctx.fillStyle = "#0e1e2a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.translate(canvas.width / 2, canvas.height / 2);
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
  if (w > 0 && h > 0) {
    canvas.width = w;
    canvas.height = h;
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
  const worldX = (canvasX - canvas.width / 2) / camera.zoom - camera.x;
  const worldY = (canvasY - canvas.height / 2) / camera.zoom - camera.y;
  return { x: worldX, y: worldY };
}

function findAssetAt(worldX, worldY) {
  if (!property || !property.assets) return null;
  const tileX = Math.floor(worldX / TILE_SIZE);
  const tileY = Math.floor(worldY / TILE_SIZE);

  for (const asset of property.assets) {
    if (!asset.position) continue;
    const ax = asset.position.x;
    const ay = asset.position.y;
    const w = asset.sprite?.width || 1;
    const h = asset.sprite?.height || 1;
    if (tileX >= ax && tileX < ax + w && tileY >= ay && tileY < ay + h) {
      return asset;
    }
  }
  return null;
}

async function handleCanvasClick(e) {
  const world = screenToWorld(e.clientX, e.clientY);
  console.log('[CLICK] World coords:', world);
  const asset = findAssetAt(world.x, world.y);
  console.log('[CLICK] Found asset:', asset);

  if (!asset) {
    console.log('[CLICK] No asset found at this position');
    return;
  }

  // Determine what type of info to show
  if (asset.trigger) {
    showSignalInfo(asset);
  } else if (asset.logger || asset.name?.toLowerCase().includes('log')) {
    await showActivityLog(asset);
  } else if (asset.station === 'inbox') {
    showInboxMessages(asset);
  } else if (asset.remote_url && asset.remote_station) {
    await showRemoteBoard(asset);
  } else if (asset.station) {
    showStationInfo(asset);
  } else {
    showModal(asset.name || 'Furniture', 'A piece of furniture on the property.');
  }
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

  const lines = messages.length
    ? messages.map(m => {
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
        const from = m.from || 'Unknown';
        return `${from}${time ? '  (' + time + ')' : ''}\n  ${m.text || '(empty)'}`;
      }).join('\n\n')
    : 'No messages.';

  showModal('📬 Inbox', lines, messages.length > 0, null, null, null, (box) => {
    const form = document.createElement('div');
    form.style.cssText = 'display:flex;gap:6px;margin-top:12px;border-top:1px solid #3a3a5a;padding-top:10px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Send a message...';
    input.maxLength = 2000;
    input.style.cssText = 'flex:1;background:#1a1a30;border:1px solid #3a3a5a;border-radius:4px;color:#ccc;padding:6px 8px;font-family:monospace;font-size:12px;';
    const btn = document.createElement('button');
    btn.textContent = 'Send';
    btn.style.cssText = 'background:#3a5a8a;color:#ccc;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-family:monospace;font-size:12px;';
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
          // Refresh inbox modal
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
      clearBtn.style.cssText = 'background:#5a3a3a;color:#ccc;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-family:monospace;font-size:12px;';
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

  showModal(`🔔 ${station}`, desc, false, setup, editableInterval, asset);
}

function showPayloadWarning() {
  return new Promise((resolve) => {
    const warningModal = document.createElement('div');
    warningModal.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    `;

    const warningBox = document.createElement('div');
    warningBox.style.cssText = `
      background: #2a2240;
      border: 2px solid #d04040;
      border-radius: 6px;
      padding: 20px;
      max-width: 500px;
      color: #ccc;
      font-family: monospace;
      font-size: 13px;
    `;

    const warningTitle = document.createElement('div');
    warningTitle.textContent = '⚠️ Security Warning';
    warningTitle.style.cssText = `
      font-size: 18px;
      font-weight: bold;
      margin-bottom: 16px;
      color: #ff6060;
    `;

    const warningText = document.createElement('div');
    warningText.innerHTML = `
      <p style="margin: 0 0 12px 0; line-height: 1.6;">
        <strong>Enabling payloads allows external data to be sent to AI agents.</strong>
      </p>
      <p style="margin: 0 0 12px 0; line-height: 1.6;">
        <strong style="color: #ff8080;">⚠ Risks:</strong>
      </p>
      <ul style="margin: 0 0 12px 0; padding-left: 20px; line-height: 1.6;">
        <li>Prompt injection attacks</li>
        <li>Malicious instructions in payloads</li>
        <li>Unauthorized agent actions</li>
      </ul>
      <p style="margin: 0 0 16px 0; line-height: 1.6;">
        <strong style="color: #60d060;">✓ Only enable if:</strong>
      </p>
      <ul style="margin: 0 0 16px 0; padding-left: 20px; line-height: 1.6;">
        <li>You control the payload source</li>
        <li>Payloads are validated/sanitized</li>
        <li>This is not a public-facing instance</li>
      </ul>
    `;

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      background: #3a3a5a;
      border: none;
      border-radius: 3px;
      color: #ccc;
      cursor: pointer;
      font-family: monospace;
      font-size: 13px;
    `;
    cancelBtn.onmouseover = () => cancelBtn.style.background = '#4a4a6a';
    cancelBtn.onmouseout = () => cancelBtn.style.background = '#3a3a5a';
    cancelBtn.onclick = () => {
      warningModal.remove();
      resolve(false);
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'I Understand, Enable Payload';
    confirmBtn.style.cssText = `
      padding: 8px 16px;
      background: #d04040;
      border: none;
      border-radius: 3px;
      color: #fff;
      cursor: pointer;
      font-family: monospace;
      font-size: 13px;
      font-weight: bold;
    `;
    confirmBtn.onmouseover = () => confirmBtn.style.background = '#e05050';
    confirmBtn.onmouseout = () => confirmBtn.style.background = '#d04040';
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

    // Close on ESC key
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

function showModal(title, content, scrollable = false, setupInstructions = null, editableInterval = null, signalAsset = null, onReady = null) {
  // Remove existing modal if any
  const existing = document.getElementById('station-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'station-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: #222240;
    border: 1px solid #3a3a5a;
    border-radius: 6px;
    padding: 16px;
    max-width: 500px;
    max-height: 70vh;
    color: #ccc;
    font-family: monospace;
    font-size: 13px;
    ${scrollable ? 'overflow-y: auto;' : ''}
  `;

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = `
    font-size: 16px;
    font-weight: bold;
    margin-bottom: 12px;
    color: #fff;
  `;

  const contentEl = document.createElement('pre');
  contentEl.textContent = content;
  contentEl.style.cssText = `
    white-space: pre-wrap;
    margin: 0;
    line-height: 1.5;
  `;

  box.appendChild(titleEl);
  box.appendChild(contentEl);

  // Add payload toggle for signal assets
  if (signalAsset && signalAsset.trigger) {
    const payloadContainer = document.createElement('div');
    payloadContainer.style.cssText = `
      margin-top: 12px;
      padding: 8px;
      background: #2a2a48;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    `;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'payload-checkbox';
    checkbox.checked = signalAsset.allow_payload === true;
    checkbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';

    const label = document.createElement('label');
    label.htmlFor = 'payload-checkbox';
    label.textContent = 'Allow payload';
    label.style.cssText = 'color: #ccc; cursor: pointer; user-select: none;';

    const statusMsg = document.createElement('span');
    statusMsg.style.cssText = 'color: #888; font-size: 11px; margin-left: auto;';

    // Payload editor (shown when checkbox is checked)
    const payloadEditorContainer = document.createElement('div');
    payloadEditorContainer.style.cssText = `
      margin-top: 8px;
      display: ${signalAsset.allow_payload ? 'block' : 'none'};
    `;

    const payloadLabel = document.createElement('div');
    payloadLabel.textContent = signalAsset.trigger === 'manual'
      ? 'Default payload (sent with every fire):'
      : 'Payload (JSON or text):';
    payloadLabel.style.cssText = 'color: #888; font-size: 11px; margin-bottom: 4px;';

    const payloadTextarea = document.createElement('textarea');
    payloadTextarea.rows = 4;
    payloadTextarea.placeholder = '{"key": "value"} or simple text';
    const currentPayload = signalAsset.trigger_payload;
    payloadTextarea.value = currentPayload !== undefined
      ? (typeof currentPayload === 'string' ? currentPayload : JSON.stringify(currentPayload, null, 2))
      : '';
    payloadTextarea.style.cssText = `
      width: 100%;
      padding: 6px;
      background: #1a1a2e;
      border: 1px solid #3a3a5a;
      border-radius: 3px;
      color: #ccc;
      font-family: monospace;
      font-size: 12px;
      resize: vertical;
    `;

    const payloadSaveBtn = document.createElement('button');
    payloadSaveBtn.textContent = 'Save Payload';
    payloadSaveBtn.style.cssText = `
      margin-top: 4px;
      padding: 4px 12px;
      background: #5a8fff;
      border: none;
      border-radius: 3px;
      color: #fff;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;
    `;
    payloadSaveBtn.onmouseover = () => payloadSaveBtn.style.background = '#7aa4ff';
    payloadSaveBtn.onmouseout = () => payloadSaveBtn.style.background = '#5a8fff';

    const payloadStatusMsg = document.createElement('span');
    payloadStatusMsg.style.cssText = 'color: #888; font-size: 11px; margin-left: 8px;';

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
          headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
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
    intervalContainer.style.cssText = `
      margin-top: 12px;
      padding: 8px;
      background: #2a2a48;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    `;

    const label = document.createElement('span');
    label.textContent = 'Interval:';
    label.style.cssText = 'color: #ccc;';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.value = editableInterval.currentInterval;
    input.style.cssText = `
      width: 80px;
      padding: 4px 8px;
      background: #1a1a2e;
      border: 1px solid #3a3a5a;
      border-radius: 3px;
      color: #ccc;
      font-family: monospace;
      font-size: 13px;
    `;

    const unit = document.createElement('span');
    unit.textContent = 'seconds';
    unit.style.cssText = 'color: #888;';

    const updateBtn = document.createElement('button');
    updateBtn.textContent = 'Update';
    updateBtn.style.cssText = `
      padding: 4px 12px;
      background: #5a8fff;
      border: none;
      border-radius: 3px;
      color: #fff;
      cursor: pointer;
      font-family: monospace;
      font-size: 12px;
      margin-left: auto;
    `;
    updateBtn.onmouseover = () => updateBtn.style.background = '#7aa4ff';
    updateBtn.onmouseout = () => updateBtn.style.background = '#5a8fff';

    const statusMsg = document.createElement('span');
    statusMsg.style.cssText = 'color: #888; font-size: 11px; margin-left: 8px;';

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
          headers: { 'Content-Type': 'application/json' },
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

  // Add collapsible setup instructions if provided
  if (setupInstructions) {
    const separator = document.createElement('div');
    separator.style.cssText = `
      margin: 12px 0 8px 0;
      border-top: 1px solid #3a3a5a;
    `;

    const toggleLink = document.createElement('div');
    toggleLink.textContent = '► Show setup instructions';
    toggleLink.style.cssText = `
      margin-top: 8px;
      color: #5a8fff;
      cursor: pointer;
      user-select: none;
    `;
    toggleLink.onmouseover = () => toggleLink.style.color = '#7aa4ff';
    toggleLink.onmouseout = () => toggleLink.style.color = '#5a8fff';

    const setupEl = document.createElement('pre');
    setupEl.textContent = setupInstructions;
    setupEl.style.cssText = `
      white-space: pre-wrap;
      margin: 8px 0 0 0;
      line-height: 1.5;
      display: none;
    `;

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

  // Close on click outside or ESC
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
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
  overlay.style.cssText = `
    position:fixed;top:0;left:0;right:0;bottom:0;
    background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:3000;
  `;
  const box = document.createElement('div');
  box.style.cssText = `
    background:#222240;border:1px solid #3a3a5a;border-radius:8px;padding:24px 32px;
    max-width:420px;color:#ccc;font-family:monospace;font-size:14px;line-height:1.7;text-align:center;
  `;
  box.innerHTML = `
    <div style="font-size:20px;font-weight:bold;color:#fff;margin-bottom:12px;">Welcome</div>
    <div>This is an agent's workspace.<br>Click furniture to see what's happening.<br>Agents walk to stations as they work.</div>
    <div style="margin-top:16px;color:#666;font-size:12px;">Click anywhere to continue</div>
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

window.addEventListener("resize", resize);
resize();

document.addEventListener("keydown", (e) => {
  if (e.key === "h" || e.key === "H" || e.key === "Home") centerCamera();
});

loadAssets().then(() => {
  connect();
  requestAnimationFrame(loop);
  showWelcome();
});
