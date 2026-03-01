// Shared editor utilities — tileset loading, grid drawing, hub API, station colors

export const TILE_SIZE = 16;
export const GRID_W = 24;
export const GRID_H = 32;

export let TILESET_URIS = {};

// Fallback colors in case /api/states is unreachable
const DEFAULT_STATION_COLORS = {
	thinking: "#f0c040", planning: "#60c0f0", reflecting: "#c080f0",
	searching: "#f09040", reading: "#80d080", querying: "#40b0b0",
	browsing: "#d06060", writing_code: "#60f060", writing_text: "#60d0f0",
	generating: "#f060c0", idle: "#808080",
};

export let STATION_COLORS = { ...DEFAULT_STATION_COLORS };
let _statesData = null;

export async function fetchStates() {
	try {
		const res = await fetch("/api/states");
		if (!res.ok) return null;
		_statesData = await res.json();
		STATION_COLORS = {};
		for (const s of _statesData.built_in) {
			STATION_COLORS[s.name] = s.color;
		}
		return _statesData;
	} catch {
		return null;
	}
}

export function getStatesData() {
	return _statesData;
}

// --- Tileset image loading ---

const tilesetImages = {};

export async function loadTilesets() {
	try {
		const res = await fetch("/api/tilesets");
		if (res.ok) TILESET_URIS = await res.json();
	} catch { /* use empty */ }
	const promises = Object.entries(TILESET_URIS).map(([key, uri]) =>
		new Promise((resolve) => {
			const img = new Image();
			img.onload = () => { tilesetImages[key] = img; resolve(); };
			img.onerror = () => resolve();
			img.src = uri;
		})
	);
	await Promise.all(promises);
	return tilesetImages;
}

export function getTilesetImage(key) {
	return tilesetImages[key];
}

// --- Animated image loading ---

const animatedImages = new Map();

export function loadAnimatedImage(file) {
	if (animatedImages.has(file)) return animatedImages.get(file);
	const img = new Image();
	img.src = `/assets/animated/${file}`;
	animatedImages.set(file, img);
	return img;
}

export function getAnimatedImage(file) {
	return animatedImages.get(file);
}

// --- Cutout image loading ---

const cutoutImages = new Map();

export function loadCutoutImage(file) {
	if (cutoutImages.has(file)) return cutoutImages.get(file);
	const img = new Image();
	img.src = `/assets/cutouts/${file}`;
	cutoutImages.set(file, img);
	return img;
}

// --- Image loading ---

const imageAssets = new Map();

export function loadImageAsset(file) {
	if (imageAssets.has(file)) return imageAssets.get(file);
	const img = new Image();
	img.src = `/assets/images/${file}`;
	imageAssets.set(file, img);
	return img;
}

// --- Frame drawing helper ---

export const FRAME_STYLES = {
	gold:  ['#5a3a1a', '#8b6914', '#c8a84e'],
	dark:  ['#1a1a1a', '#333333', '#555555'],
	white: ['#888888', '#cccccc', '#f0f0f0'],
	wood:  ['#3b2507', '#6b4226', '#a0703c'],
	black: ['#000000', '#1a1a1a', '#333333'],
};

export const FEET_H = 14;

export function drawFeet(ctx, dx, dy, w, h, style) {
	const color = FRAME_STYLES[style]?.[0] || FRAME_STYLES.gold[0];
	ctx.fillStyle = color;
	ctx.fillRect(dx + 3, dy + h, 3, FEET_H);
	ctx.fillRect(dx + w - 6, dy + h, 3, FEET_H);
}

export function drawFrame(ctx, dx, dy, w, h, p, style) {
	if (p <= 0) return;
	const c = FRAME_STYLES[style] || FRAME_STYLES.gold;
	ctx.fillStyle = c[0];
	ctx.fillRect(dx, dy, w, h);
	ctx.fillStyle = c[1];
	ctx.fillRect(dx + 1, dy + 1, w - 2, h - 2);
	ctx.fillStyle = c[2];
	ctx.fillRect(dx + p - 1, dy + p - 1, w - (p - 1) * 2, h - (p - 1) * 2);
}

// --- Grid drawing ---

export function drawGrid(ctx, zoom) {
	ctx.strokeStyle = "rgba(255,255,255,0.1)";
	ctx.lineWidth = 1 / zoom;
	for (let x = 0; x <= GRID_W; x++) {
		ctx.beginPath();
		ctx.moveTo(x * TILE_SIZE, 0);
		ctx.lineTo(x * TILE_SIZE, GRID_H * TILE_SIZE);
		ctx.stroke();
	}
	for (let y = 0; y <= GRID_H; y++) {
		ctx.beginPath();
		ctx.moveTo(0, y * TILE_SIZE);
		ctx.lineTo(GRID_W * TILE_SIZE, y * TILE_SIZE);
		ctx.stroke();
	}
}

export function drawTile(ctx, src, ax, ay, dx, dy) {
	const img = tilesetImages[src];
	if (!img) return;
	ctx.drawImage(img,
		ax * TILE_SIZE, ay * TILE_SIZE, TILE_SIZE, TILE_SIZE,
		dx * TILE_SIZE, dy * TILE_SIZE, TILE_SIZE, TILE_SIZE
	);
}

export function drawTileLayer(ctx, tiles) {
	if (!tiles) return;
	for (const t of tiles) {
		const ax = t.ax ?? t.tx ?? 0;
		const ay = t.ay ?? t.ty ?? 0;
		drawTile(ctx, t.src, ax, ay, t.x, t.y);
	}
}

export function drawAsset(ctx, asset) {
	if (!asset.position) return;
	const sprite = asset.sprite;
	if (sprite?.file) {
		const img = animatedImages.get(sprite.file);
		if (!img?.complete || !img.naturalWidth) return;
		const fw = (sprite.width || 1) * TILE_SIZE;
		ctx.drawImage(img, 0, 0, fw, img.naturalHeight,
			asset.position.x * TILE_SIZE, asset.position.y * TILE_SIZE, fw, img.naturalHeight
		);
	} else if (sprite?.cutout || sprite?.image) {
		const img = sprite.cutout ? cutoutImages.get(sprite.cutout) : imageAssets.get(sprite.image);
		if (!img?.complete || !img.naturalWidth) return;
		const w = sprite.pw || (sprite.width || 1) * TILE_SIZE;
		const h = sprite.ph || (sprite.height || 1) * TILE_SIZE;
		const p = sprite.padding || 0;
		const bw = Math.ceil(w / TILE_SIZE) * TILE_SIZE;
		const bh = Math.ceil(h / TILE_SIZE) * TILE_SIZE;
		const dx = asset.position.x * TILE_SIZE + (bw - w) / 2;
		const dy = asset.position.y * TILE_SIZE + (bh - h) / 2;
		drawFrame(ctx, dx, dy, w, h, p, sprite.frame);
		if (sprite.feet) drawFeet(ctx, dx, dy, w, h, sprite.frame);
		ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight,
			dx + p, dy + p, w - p * 2, h - p * 2
		);
	} else if (sprite?.tileset) {
		const img = tilesetImages[sprite.tileset];
		if (!img) return;
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
	}
}

export function drawStationOverlay(ctx, asset, zoom) {
	if (!asset.station || !asset.position) return;
	const color = STATION_COLORS[asset.station] || "#fff";
	const s = asset.sprite;
	const w = s?.pw || (s?.width || 1) * TILE_SIZE;
	const h = s?.ph || (s?.height || 1) * TILE_SIZE;
	const px = asset.position.x * TILE_SIZE;
	const py = asset.position.y * TILE_SIZE;
	ctx.strokeStyle = color;
	ctx.lineWidth = 2 / zoom;
	ctx.strokeRect(px, py, w, h);
	ctx.fillStyle = color;
	ctx.font = `${Math.max(6, 8 / zoom)}px monospace`;
	ctx.textAlign = "left";
	ctx.fillText(asset.station, px + 1, py - 2);

	// Draw approach position markers
	if (asset.approaches) {
		for (const ap of asset.approaches) {
			const cx = (asset.position.x + ap.x + 0.5) * TILE_SIZE;
			const cy = (asset.position.y + ap.y + 0.5) * TILE_SIZE;
			const r = 4;
			ctx.fillStyle = color;
			ctx.globalAlpha = 0.85;
			ctx.beginPath();
			ctx.moveTo(cx, cy - r);
			ctx.lineTo(cx + r, cy);
			ctx.lineTo(cx, cy + r);
			ctx.lineTo(cx - r, cy);
			ctx.closePath();
			ctx.fill();
			ctx.globalAlpha = 1;
		}
	}
}

// --- Auth ---

export function getApiKey() { return localStorage.getItem("editor_api_key") || ""; }
export function setApiKey(key) { localStorage.setItem("editor_api_key", key); }
export function clearApiKey() { localStorage.removeItem("editor_api_key"); }

export function authHeaders() {
	const key = getApiKey();
	const h = { "Content-Type": "application/json" };
	if (key) h["Authorization"] = `Bearer ${key}`;
	return h;
}

export function setupAuthUI() {
	const el = document.getElementById("auth-status");
	if (!el) return;
	const render = () => {
		const key = getApiKey();
		el.textContent = key ? "🔓 Logged in" : "🔒 Login";
		el.title = key ? "Click to log out" : "Click to enter API key";
	};
	el.onclick = () => {
		if (getApiKey()) {
			clearApiKey();
		} else {
			const key = prompt("Enter API key:");
			if (key?.trim()) setApiKey(key.trim());
		}
		render();
	};
	render();
}

// --- Hub API ---

export async function loadProperty() {
	const res = await fetch("/api/property");
	if (!res.ok) return null;
	return res.json();
}

export async function saveProperty(_unused, property) {
	return fetch("/api/property", {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(property),
	});
}

export async function loadTileCatalog() {
	const res = await fetch("/api/tile-catalog");
	if (!res.ok) return { categories: [] };
	return res.json();
}

export async function loadAnimatedFiles() {
	const res = await fetch("/api/animated-files");
	if (!res.ok) return [];
	return res.json();
}

// --- Coordinate helpers ---

export function screenToGrid(mx, my, camera) {
	const wx = (mx - camera.canvasW / 2) / camera.zoom - camera.x;
	const wy = (my - camera.canvasH / 2) / camera.zoom - camera.y;
	return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
}

export function inBounds(gx, gy) {
	return gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H;
}
