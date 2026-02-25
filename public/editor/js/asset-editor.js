import {
	TILE_SIZE, STATION_COLORS,
	loadTilesets, getTilesetImage, TILESET_URIS,
	loadTileCatalog, loadAnimatedFiles, loadAnimatedImage,
	fetchStates, getStatesData,
} from "./editor-shared.js";

// --- State ---
let catalog = { categories: [] };
let animatedFiles = [];
let activeCatalogTab = 0;

// Selection state
let selectedTileset = "room_builder";
let selection = null;  // { tx, ty, w, h } tile coords in tileset
let selectStart = null;
let selectedAnimFile = null;
let gridOffsetX = 0;  // pixel offset for grid alignment
let gridOffsetY = 0;

// Character preview state
const CHAR_H = 32;
const CHAR_FRAMES = 6;
const characterSprites = {}; // pose -> Image
let animFrame = 0;
let animTimer = null;
let approachPositions = [null, null, null]; // Up to 3 agent positions
let placingSlot = -1; // -1 = not placing, 0/1/2 = which slot to place

// --- DOM ---
const statusEl = document.getElementById("status");
const tilesetSelect = document.getElementById("tileset-select");
const tilesetCanvas = document.getElementById("tileset-canvas");
const tilesetCtx = tilesetCanvas.getContext("2d");
const approachCanvas = document.getElementById("approach-canvas");
const approachCtx = approachCanvas.getContext("2d");
const animatedList = document.getElementById("animated-list");
const catalogTabs = document.getElementById("catalog-tabs");
const catalogItems = document.getElementById("catalog-items");

// --- Tileset browser ---

function populateTilesetDropdown() {
	tilesetSelect.innerHTML = "";
	for (const key of Object.keys(TILESET_URIS)) {
		const opt = document.createElement("option");
		opt.value = key; opt.textContent = key;
		if (key === selectedTileset) opt.selected = true;
		tilesetSelect.appendChild(opt);
	}
}

tilesetSelect.onchange = () => {
	selectedTileset = tilesetSelect.value;
	selection = null;
	selectedAnimFile = null;
	approachPos = null;
	renderTileset();
	renderApproachPreview();
};

document.getElementById("grid-offset-x").oninput = (e) => {
	gridOffsetX = parseInt(e.target.value) || 0;
	renderTileset();
};
document.getElementById("grid-offset-y").oninput = (e) => {
	gridOffsetY = parseInt(e.target.value) || 0;
	renderTileset();
};

function renderTileset() {
	const img = getTilesetImage(selectedTileset);
	if (!img) { tilesetCanvas.width = 0; return; }
	const scale = 2;
	tilesetCanvas.width = img.naturalWidth * scale;
	tilesetCanvas.height = img.naturalHeight * scale;
	tilesetCtx.imageSmoothingEnabled = false;
	tilesetCtx.drawImage(img, 0, 0, tilesetCanvas.width, tilesetCanvas.height);

	// Draw grid overlay with offset
	if (gridOffsetX !== 0 || gridOffsetY !== 0) {
		tilesetCtx.strokeStyle = "rgba(255,255,255,0.15)";
		tilesetCtx.lineWidth = 1;
		for (let x = gridOffsetX * scale; x <= tilesetCanvas.width; x += TILE_SIZE * scale) {
			tilesetCtx.beginPath();
			tilesetCtx.moveTo(x, 0);
			tilesetCtx.lineTo(x, tilesetCanvas.height);
			tilesetCtx.stroke();
		}
		for (let y = gridOffsetY * scale; y <= tilesetCanvas.height; y += TILE_SIZE * scale) {
			tilesetCtx.beginPath();
			tilesetCtx.moveTo(0, y);
			tilesetCtx.lineTo(tilesetCanvas.width, y);
			tilesetCtx.stroke();
		}
	}

	if (selection) {
		tilesetCtx.strokeStyle = "#5a8fff";
		tilesetCtx.lineWidth = 2;
		tilesetCtx.strokeRect(
			(selection.tx * TILE_SIZE + gridOffsetX) * scale,
			(selection.ty * TILE_SIZE + gridOffsetY) * scale,
			selection.w * TILE_SIZE * scale,
			selection.h * TILE_SIZE * scale
		);
	}
}

tilesetCanvas.addEventListener("pointerdown", (e) => {
	const rect = tilesetCanvas.getBoundingClientRect();
	const scale = tilesetCanvas.width / rect.width;
	const px = (e.clientX - rect.left) * scale;
	const py = (e.clientY - rect.top) * scale;
	const tx = Math.floor((px - gridOffsetX * 2) / (TILE_SIZE * 2));
	const ty = Math.floor((py - gridOffsetY * 2) / (TILE_SIZE * 2));
	selectStart = { tx, ty };
	selection = { tx, ty, w: 1, h: 1 };
	selectedAnimFile = null;
	approachPositions = [null, null, null];
	placingSlot = -1;
	renderTileset();
	updateConfigFromSelection();
	tilesetCanvas.setPointerCapture(e.pointerId);
});

tilesetCanvas.addEventListener("pointermove", (e) => {
	if (!selectStart) return;
	const rect = tilesetCanvas.getBoundingClientRect();
	const scale = tilesetCanvas.width / rect.width;
	const px = (e.clientX - rect.left) * scale;
	const py = (e.clientY - rect.top) * scale;
	const tx = Math.floor((px - gridOffsetX * 2) / (TILE_SIZE * 2));
	const ty = Math.floor((py - gridOffsetY * 2) / (TILE_SIZE * 2));
	const x0 = Math.min(selectStart.tx, tx);
	const y0 = Math.min(selectStart.ty, ty);
	const x1 = Math.max(selectStart.tx, tx);
	const y1 = Math.max(selectStart.ty, ty);
	selection = { tx: x0, ty: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
	renderTileset();
	updateConfigFromSelection();
});

tilesetCanvas.addEventListener("pointerup", () => { selectStart = null; });

function updateConfigFromSelection() {
	if (selection) {
		document.getElementById("cfg-w").value = selection.w;
		document.getElementById("cfg-h").value = selection.h;
		document.getElementById("cfg-label").value = "";
	}
	document.getElementById("cfg-category").value = "Furniture";
	document.getElementById("cfg-signal").value = "";
	document.getElementById("cfg-interval").value = "1";
	document.getElementById("cfg-interval-label").style.display = "none";
	approachPositions = [null, null, null];
	placingSlot = -1;
	updatePosButtons();
	buildConfigCategoryTabs();
	updateFieldVisibility();
	renderApproachPreview();
}

// --- Approach canvas click ---

approachCanvas.addEventListener("click", (e) => {
	if (!selection && !selectedAnimFile) return;
	if (placingSlot < 0) return;
	const rect = approachCanvas.getBoundingClientRect();
	const scale = 4;
	const assetX = 1;
	const assetY = 2;
	const rawX = (e.clientX - rect.left) / (TILE_SIZE * scale) - assetX;
	const rawY = (e.clientY - rect.top) / (TILE_SIZE * scale) - assetY;
	const relX = Math.round(rawX * 2) / 2;
	const relY = Math.round(rawY * 2) / 2;
	approachPositions[placingSlot] = { x: relX, y: relY };
	placingSlot = -1;
	updatePosButtons();
	const w = parseInt(document.getElementById("cfg-w").value) || 1;
	const h = parseInt(document.getElementById("cfg-h").value) || 1;
	const validPos = approachPositions.filter(Boolean);
	if (validPos.length > 0) {
		document.getElementById("cfg-approach").value = getApproachDirFromPos(validPos[0], w, h);
	}
	renderApproachPreview();
});

// Position button handlers
document.querySelectorAll(".pos-btn").forEach(btn => {
	btn.addEventListener("click", () => {
		const slot = parseInt(btn.dataset.slot);
		if (placingSlot === slot) {
			placingSlot = -1;
		} else {
			placingSlot = slot;
		}
		updatePosButtons();
	});
	btn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const slot = parseInt(btn.dataset.slot);
		if (approachPositions[slot] && approachPositions.filter(Boolean).length > 1) {
			approachPositions[slot] = null;
			while (approachPositions.length > 1 && !approachPositions[approachPositions.length - 1]) {
				approachPositions.pop();
			}
			placingSlot = -1;
			updatePosButtons();
			renderApproachPreview();
		}
	});
});

function updatePosButtons() {
	document.querySelectorAll(".pos-btn").forEach(btn => {
		const slot = parseInt(btn.dataset.slot);
		btn.classList.toggle("active", placingSlot === slot);
		btn.classList.toggle("placed", !!approachPositions[slot]);
	});
	approachCanvas.style.cursor = placingSlot >= 0 ? "crosshair" : "pointer";
}

document.getElementById("cfg-station").addEventListener("input", renderApproachPreview);
document.getElementById("cfg-approach").addEventListener("change", () => {
	approachPositions = [null, null, null];
	placingSlot = -1;
	updatePosButtons();
	renderApproachPreview();
});
document.getElementById("cfg-signal").addEventListener("change", () => {
	const signalValue = document.getElementById("cfg-signal").value;
	const intervalLabel = document.getElementById("cfg-interval-label");
	intervalLabel.style.display = signalValue === "interval" ? "" : "none";
});
document.getElementById("cfg-pose").addEventListener("change", renderApproachPreview);
document.getElementById("cfg-facing").addEventListener("change", renderApproachPreview);
document.getElementById("cfg-w").addEventListener("input", () => {
	approachPositions = [null, null, null];
	placingSlot = -1;
	updatePosButtons();
	renderApproachPreview();
});
document.getElementById("cfg-h").addEventListener("input", () => {
	approachPositions = [null, null, null];
	placingSlot = -1;
	updatePosButtons();
	renderApproachPreview();
});

// --- Animated browser ---

function buildAnimatedList() {
	animatedList.innerHTML = "";
	for (const file of animatedFiles) {
		const item = document.createElement("div");
		item.className = "animated-item";
		if (file === selectedAnimFile) item.classList.add("selected");

		const img = document.createElement("img");
		img.src = `/assets/animated/${file}`;
		item.appendChild(img);

		const label = document.createElement("span");
		label.textContent = file.replace("animated_", "").replace(".png", "");
		label.style.fontSize = "11px";
		item.appendChild(label);

		item.onclick = () => {
			selectedAnimFile = file;
			selection = null;
			approachPositions = [null, null, null];
			placingSlot = -1;
			buildAnimatedList();
			updatePosButtons();
			document.getElementById("cfg-label").value = file.replace("animated_", "").replace(".png", "");
			document.getElementById("cfg-w").value = "1";
			document.getElementById("cfg-h").value = "2";
			document.getElementById("cfg-category").value = "Furniture";
			document.getElementById("cfg-signal").value = "";
			document.getElementById("cfg-interval").value = "1";
			document.getElementById("cfg-interval-label").style.display = "none";
			buildConfigCategoryTabs();
			updateFieldVisibility();
			renderTileset();
			renderApproachPreview();
		};
		animatedList.appendChild(item);
	}
}

// --- Approach preview helpers ---

function getApproachTileFromDir(approach, w, h) {
	switch (approach) {
		case "above": return { x: Math.floor(w / 2), y: -1 };
		case "left":  return { x: -1, y: Math.floor(h / 2) };
		case "right": return { x: w, y: Math.floor(h / 2) };
		case "on":    return { x: Math.floor(w / 2), y: Math.floor(h / 2) };
		default:      return { x: Math.floor(w / 2), y: h };
	}
}

function getFacingFromApproach(approach) {
	switch (approach) {
		case "above": return "down";
		case "below": return "up";
		case "left":  return "left";
		case "right": return "right";
		default:      return "down";
	}
}

function getApproachDirFromPos(pos, w, h) {
	if (pos.y < 0) return "above";
	if (pos.y >= h) return "below";
	if (pos.x < 0) return "left";
	if (pos.x >= w) return "right";
	return "on";
}

// --- Approach Preview ---

function renderApproachPreview() {
	const w = parseInt(document.getElementById("cfg-w").value) || 1;
	const h = parseInt(document.getElementById("cfg-h").value) || 1;
	const station = document.getElementById("cfg-station").value.trim();
	const approach = document.getElementById("cfg-approach").value || "below";

	const gridW = w + 2;
	const gridH = h + 3;
	const scale = 4;
	const assetX = 1;
	const assetY = 2;

	approachCanvas.width = gridW * TILE_SIZE * scale;
	approachCanvas.height = gridH * TILE_SIZE * scale;
	approachCtx.imageSmoothingEnabled = false;

	// Background
	approachCtx.fillStyle = "#1a1a2e";
	approachCtx.fillRect(0, 0, approachCanvas.width, approachCanvas.height);

	// Grid
	approachCtx.strokeStyle = "rgba(255,255,255,0.08)";
	approachCtx.lineWidth = 1;
	for (let x = 0; x <= gridW; x++) {
		approachCtx.beginPath();
		approachCtx.moveTo(x * TILE_SIZE * scale, 0);
		approachCtx.lineTo(x * TILE_SIZE * scale, approachCanvas.height);
		approachCtx.stroke();
	}
	for (let y = 0; y <= gridH; y++) {
		approachCtx.beginPath();
		approachCtx.moveTo(0, y * TILE_SIZE * scale);
		approachCtx.lineTo(approachCanvas.width, y * TILE_SIZE * scale);
		approachCtx.stroke();
	}

	// Draw asset
	let hasAsset = false;
	if (selectedAnimFile) {
		const img = loadAnimatedImage(selectedAnimFile);
		if (!img.complete) {
			img.onload = renderApproachPreview;
		} else {
			approachCtx.drawImage(img,
				0, 0, w * TILE_SIZE, img.naturalHeight,
				assetX * TILE_SIZE * scale, assetY * TILE_SIZE * scale,
				w * TILE_SIZE * scale, h * TILE_SIZE * scale
			);
			hasAsset = true;
		}
	} else if (selection) {
		const img = getTilesetImage(selectedTileset);
		if (img) {
			approachCtx.drawImage(img,
				selection.tx * TILE_SIZE + gridOffsetX, selection.ty * TILE_SIZE + gridOffsetY,
				w * TILE_SIZE, h * TILE_SIZE,
				assetX * TILE_SIZE * scale, assetY * TILE_SIZE * scale,
				w * TILE_SIZE * scale, h * TILE_SIZE * scale
			);
			hasAsset = true;
		}
	}

	if (!hasAsset) {
		document.getElementById("approach-info").textContent = "Select a tile from the tileset";
		return;
	}

	// Asset border with station color
	const color = station ? (STATION_COLORS[station] || "#5a8fff") : "rgba(255,255,255,0.2)";
	approachCtx.strokeStyle = color;
	approachCtx.lineWidth = 2;
	approachCtx.strokeRect(
		assetX * TILE_SIZE * scale, assetY * TILE_SIZE * scale,
		w * TILE_SIZE * scale, h * TILE_SIZE * scale
	);

	// Collect valid positions
	const validPositions = approachPositions.filter(Boolean);
	const positions = validPositions.length > 0 ? validPositions : [getApproachTileFromDir(approach, w, h)];

	// Draw crosshair markers and numbered labels for placed positions
	for (let i = 0; i < positions.length; i++) {
		const pos = positions[i];
		const px = (assetX + pos.x + 0.5) * TILE_SIZE * scale;
		const py = (assetY + pos.y + 0.5) * TILE_SIZE * scale;
		const half = TILE_SIZE * scale / 2;

		approachCtx.strokeStyle = color;
		approachCtx.lineWidth = 2;
		approachCtx.beginPath();
		approachCtx.moveTo(px - half, py);
		approachCtx.lineTo(px + half, py);
		approachCtx.moveTo(px, py - half);
		approachCtx.lineTo(px, py + half);
		approachCtx.stroke();

		if (validPositions.length > 1) {
			approachCtx.fillStyle = "#fff";
			approachCtx.font = "bold 14px monospace";
			approachCtx.textAlign = "left";
			approachCtx.textBaseline = "bottom";
			approachCtx.fillText((i + 1).toString(), px + 4, py - 4);
		}
	}

	// Draw characters at all positions
	const pose = document.getElementById("cfg-pose").value || "idle";
	const sprite = characterSprites[pose];
	if (sprite && approach) {
		for (let i = 0; i < positions.length; i++) {
			const ap = positions[i];

			// Determine facing
			const facingValue = document.getElementById("cfg-facing").value;
			const facing = facingValue === "auto"
				? getFacingFromApproach(getApproachDirFromPos(ap, w, h))
				: facingValue;

			// Sprite layout: idle has 4 dirs × 6 frames, sit/phone have 2 dirs × 3 frames
			let srcX, srcY = 0, spriteW = TILE_SIZE, spriteH = CHAR_H;
			if (pose === "idle") {
				const dirMap = { left: 2, up: 1, right: 0, down: 3 };
				const dir = dirMap[facing] ?? 3;
				const frame = (animFrame + i * 2) % CHAR_FRAMES;
				srcX = (dir * CHAR_FRAMES + frame) * TILE_SIZE;
			} else {
				const dirMap = { left: 1, right: 0, up: 0, down: 0 };
				const dir = dirMap[facing] ?? 0;
				srcX = dir * 3 * TILE_SIZE;
				spriteH = sprite.naturalHeight;
			}

			approachCtx.save();
			if (validPositions.length > 1) approachCtx.globalAlpha = 0.85;

			approachCtx.drawImage(sprite,
				srcX, srcY, spriteW, spriteH,
				(assetX + ap.x) * TILE_SIZE * scale,
				(assetY + ap.y - 1) * TILE_SIZE * scale,
				spriteW * scale, spriteH * scale
			);

			approachCtx.restore();
		}
	}

	// Station label
	if (station) {
		approachCtx.fillStyle = color;
		approachCtx.font = "bold 12px monospace";
		approachCtx.textAlign = "left";
		approachCtx.fillText(station, assetX * TILE_SIZE * scale, (assetY - 0.2) * TILE_SIZE * scale);
	}

	// Info text
	const info = document.getElementById("approach-info");
	const facingLabel = document.getElementById("cfg-facing").value;
	const posCount = validPositions.length;
	if (station) {
		info.textContent = `${w}\u00d7${h} | ${station} | ${posCount} position${posCount !== 1 ? 's' : ''} | facing ${facingLabel}`;
	} else {
		info.textContent = `${w}\u00d7${h} | Click "Agent 1/2/3" then click grid to place`;
	}
}

function startAnimation() {
	animTimer = setInterval(() => {
		animFrame = (animFrame + 1) % CHAR_FRAMES;
		if ((selection || selectedAnimFile) && Object.keys(characterSprites).length > 0) renderApproachPreview();
	}, 125);
}

// --- Category tabs ---

function buildConfigCategoryTabs() {
	const container = document.getElementById("cfg-category-tabs");
	container.innerHTML = "";
	const input = document.getElementById("cfg-category");
	const current = input.value.trim();

	const categories = ["Furniture", "Floors", "Walls", "Decorations", "Signals"];

	for (const name of categories) {
		const btn = document.createElement("button");
		btn.textContent = name;
		btn.style.cssText = "font-size:10px;padding:2px 8px";
		btn.classList.toggle("active", name === current);
		btn.onclick = () => {
			input.value = name;
			buildConfigCategoryTabs();
			updateFieldVisibility();
		};
		container.appendChild(btn);
	}
}

function updateFieldVisibility() {
	const category = document.getElementById("cfg-category").value;

	// Fields that only show for Furniture and Signals
	const furnitureOnly = category === "Furniture" || category === "Signals";
	document.getElementById("cfg-station-label").style.display = furnitureOnly ? "" : "none";
	document.getElementById("cfg-approach-label").style.display = furnitureOnly ? "" : "none";
	document.getElementById("cfg-pose-label").style.display = furnitureOnly ? "" : "none";
	document.getElementById("cfg-facing-label").style.display = furnitureOnly ? "" : "none";

	// Signal fields only show for Signals category
	const isSignals = category === "Signals";
	document.getElementById("cfg-signal-label").style.display = isSignals ? "" : "none";
	// Interval visibility is handled by the signal dropdown change event
	if (!isSignals) {
		document.getElementById("cfg-interval-label").style.display = "none";
	}
}

// --- Station suggestions ---

function buildStationSuggestions() {
	const datalist = document.getElementById("station-list");
	datalist.innerHTML = "";
	const stations = new Set(Object.keys(STATION_COLORS));
	// Add states from fetched API data
	const statesData = getStatesData();
	if (statesData?.built_in) {
		for (const s of statesData.built_in) stations.add(s.name);
	}
	for (const cat of catalog.categories) {
		for (const tile of cat.tiles) {
			if (tile.station) stations.add(tile.station);
		}
	}
	for (const name of stations) {
		const opt = document.createElement("option");
		opt.value = name;
		datalist.appendChild(opt);
	}
}

// --- Catalog management ---

function buildCatalogTabs() {
	catalogTabs.innerHTML = "";
	catalog.categories.forEach((cat, i) => {
		const btn = document.createElement("button");
		btn.textContent = cat.name;
		btn.classList.toggle("active", i === activeCatalogTab);
		btn.onclick = () => { activeCatalogTab = i; buildCatalogTabs(); buildCatalogItems(); };
		catalogTabs.appendChild(btn);
	});
}

function buildCatalogItems() {
	catalogItems.innerHTML = "";
	const cat = catalog.categories[activeCatalogTab];
	if (!cat) return;

	for (let i = 0; i < cat.tiles.length; i++) {
		const tile = cat.tiles[i];
		const item = document.createElement("div");
		item.className = "catalog-item";

		const cvs = document.createElement("canvas");
		cvs.width = 32; cvs.height = 32;
		const c = cvs.getContext("2d");
		c.imageSmoothingEnabled = false;

		if (tile.file) {
			const img = new Image();
			img.src = `/assets/animated/${tile.file}`;
			img.onload = () => {
				const fw = (tile.w || 1) * TILE_SIZE;
				const scale = Math.min(32 / fw, 32 / img.naturalHeight);
				c.drawImage(img, 0, 0, fw, img.naturalHeight, 0, 0, fw * scale, img.naturalHeight * scale);
			};
		} else if (tile.cutout) {
			const img = new Image();
			img.src = `/assets/cutouts/${tile.cutout}`;
			img.onload = () => {
				const scale = Math.min(32 / img.naturalWidth, 32 / img.naturalHeight);
				c.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale);
			};
		} else {
			const img = getTilesetImage(tile.src);
			if (img) {
				const w = tile.w || 1, h = tile.h || 1;
				const scale = Math.min(32 / (w * TILE_SIZE), 32 / (h * TILE_SIZE));
				for (let dy = 0; dy < h; dy++) {
					for (let dx = 0; dx < w; dx++) {
						c.drawImage(img,
							(tile.tx + dx) * TILE_SIZE + (tile.ox || 0), (tile.ty + dy) * TILE_SIZE + (tile.oy || 0), TILE_SIZE, TILE_SIZE,
							dx * TILE_SIZE * scale, dy * TILE_SIZE * scale, TILE_SIZE * scale, TILE_SIZE * scale
						);
					}
				}
			}
		}
		item.appendChild(cvs);

		const info = document.createElement("div");
		info.className = "info";
		const label = document.createElement("b");
		label.textContent = tile.label || "Untitled";
		info.appendChild(label);
		info.appendChild(document.createElement("br"));
		if (tile.station) {
			const stationSpan = document.createElement("span");
			stationSpan.style.color = STATION_COLORS[tile.station] || "#fff";
			stationSpan.textContent = tile.station;
			info.appendChild(stationSpan);
		}
		if (tile.collision) {
			const collSpan = document.createElement("span");
			collSpan.style.color = "var(--danger)";
			collSpan.textContent = ` [${tile.collision}]`;
			info.appendChild(collSpan);
		}
		item.appendChild(info);

		const del = document.createElement("span");
		del.className = "del";
		del.textContent = "\u00d7";
		del.title = "Delete";
		del.onclick = (e) => {
			e.stopPropagation();
			cat.tiles.splice(i, 1);
			buildCatalogItems();
		};
		item.appendChild(del);

		item.onclick = () => {
			if (tile.file) {
				selectedAnimFile = tile.file;
				selection = null;
			} else {
				selectedAnimFile = null;
				selectedTileset = tile.src;
				tilesetSelect.value = tile.src;
				gridOffsetX = tile.ox || 0;
				gridOffsetY = tile.oy || 0;
				document.getElementById("grid-offset-x").value = gridOffsetX;
				document.getElementById("grid-offset-y").value = gridOffsetY;
				selection = { tx: tile.tx, ty: tile.ty, w: tile.w || 1, h: tile.h || 1 };
				renderTileset();
			}
			document.getElementById("cfg-label").value = tile.label || "";
			document.getElementById("cfg-station").value = tile.station || "";
			// Load signal fields
			const signalValue = !tile.trigger ? "" : tile.trigger === "manual" ? "manual" : "interval";
			document.getElementById("cfg-signal").value = signalValue;
			document.getElementById("cfg-interval").value = tile.trigger_interval || 1;
			document.getElementById("cfg-interval-label").style.display = signalValue === "interval" ? "" : "none";
			document.getElementById("cfg-approach").value = tile.approach || "below";
			document.getElementById("cfg-pose").value = tile.pose || "idle";
			document.getElementById("cfg-facing").value = tile.facing || "auto";
			document.getElementById("cfg-collision").value = tile.collision || "";
			document.getElementById("cfg-w").value = tile.w || 1;
			document.getElementById("cfg-h").value = tile.h || 1;
			document.getElementById("cfg-category").value = cat.name;
			// Restore approach positions
			if (tile.approaches && tile.approaches.length > 0) {
				approachPositions = tile.approaches.map(a => ({ x: a.x, y: a.y }));
				while (approachPositions.length < 3) approachPositions.push(null);
			} else {
				approachPositions = [null, null, null];
			}
			placingSlot = -1;
			buildConfigCategoryTabs();
			updateFieldVisibility();
			updatePosButtons();
			renderApproachPreview();
		};

		catalogItems.appendChild(item);
	}
}

// --- Add to catalog ---

function applyTileMetadata(tile) {
	const station = document.getElementById("cfg-station").value.trim() || undefined;
	const collision = document.getElementById("cfg-collision").value || undefined;
	const w = parseInt(document.getElementById("cfg-w").value) || 1;
	const h = parseInt(document.getElementById("cfg-h").value) || 1;

	if (station) {
		tile.station = station;
		const poseValue = document.getElementById("cfg-pose").value;
		if (poseValue && poseValue !== "idle") tile.pose = poseValue;
		const facingValue = document.getElementById("cfg-facing").value;
		if (facingValue !== "auto") tile.facing = facingValue;
		const validPositions = approachPositions.filter(Boolean);
		if (validPositions.length <= 1) {
			const pos = validPositions[0];
			if (pos) {
				const dir = getApproachDirFromPos(pos, w, h);
				const canonical = getApproachTileFromDir(dir, w, h);
				if (pos.x === canonical.x && pos.y === canonical.y) {
					tile.approach = dir;
				} else {
					tile.approach = dir;
					tile.approaches = [{ x: pos.x, y: pos.y, dir }];
				}
			} else {
				const approach = document.getElementById("cfg-approach").value;
				if (approach) tile.approach = approach;
			}
		} else {
			tile.approaches = validPositions.map(p => ({
				x: p.x, y: p.y, dir: getApproachDirFromPos(p, w, h)
			}));
		}
	}
	if (collision) tile.collision = collision;

	const signalValue = document.getElementById("cfg-signal").value;
	if (signalValue === "interval") {
		tile.trigger = "heartbeat";
		tile.trigger_interval = parseInt(document.getElementById("cfg-interval").value) || 1;
	} else if (signalValue === "manual") {
		tile.trigger = "manual";
	}
}

function addTileToCatalog(tile) {
	const label = document.getElementById("cfg-label").value.trim();
	const categoryName = document.getElementById("cfg-category").value.trim() || "Furniture";
	let cat = catalog.categories.find(c => c.name === categoryName);
	if (!cat) {
		cat = { name: categoryName, tiles: [] };
		catalog.categories.push(cat);
	}
	cat.tiles.push(tile);
	activeCatalogTab = catalog.categories.indexOf(cat);
	buildCatalogTabs();
	buildCatalogItems();
	buildConfigCategoryTabs();
	buildStationSuggestions();
	statusEl.textContent = `Added "${label || "tile"}" to ${categoryName}`;
}

// Add to Catalog - uses tileset coordinates (or animated file)
document.getElementById("btn-add").onclick = () => {
	const label = document.getElementById("cfg-label").value.trim();
	const w = parseInt(document.getElementById("cfg-w").value) || 1;
	const h = parseInt(document.getElementById("cfg-h").value) || 1;

	let tile;
	if (selectedAnimFile) {
		tile = { file: selectedAnimFile, w, h, label };
	} else if (selection) {
		tile = { src: selectedTileset, tx: selection.tx, ty: selection.ty, w, h, label };
		if (gridOffsetX) tile.ox = gridOffsetX;
		if (gridOffsetY) tile.oy = gridOffsetY;
	} else {
		statusEl.textContent = "Select a tileset region or animated sprite first";
		return;
	}

	applyTileMetadata(tile);
	addTileToCatalog(tile);
};

// --- Save / Export / Import ---

document.getElementById("btn-save").onclick = async () => {
	try {
		const res = await fetch("/api/tile-catalog", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(catalog),
		});
		if (res.ok) {
			statusEl.textContent = "Catalog saved to server";
		} else {
			statusEl.textContent = "Save failed";
		}
	} catch (err) {
		statusEl.textContent = `Save error: ${err.message}`;
	}
};

document.getElementById("btn-export").onclick = () => {
	const blob = new Blob([JSON.stringify(catalog, null, "\t")], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "tile_catalog.json";
	a.click();
	URL.revokeObjectURL(a.href);
};

document.getElementById("btn-import").onclick = () => document.getElementById("file-import").click();
document.getElementById("file-import").onchange = (e) => {
	const file = e.target.files[0];
	if (!file) return;
	const reader = new FileReader();
	reader.onload = () => {
		try {
			catalog = JSON.parse(reader.result);
			activeCatalogTab = 0;
			buildCatalogTabs();
			buildCatalogItems();
			buildConfigCategoryTabs();
			buildStationSuggestions();
			statusEl.textContent = `Imported ${file.name}`;
		} catch (err) {
			statusEl.textContent = `Import failed: ${err.message}`;
		}
	};
	reader.readAsText(file);
	e.target.value = "";
};

// --- Init ---

async function init() {
	statusEl.textContent = "Loading assets...";

	const poseFiles = {
		idle: "/assets/characters/Adam_idle_anim_16x16.png",
		sit: "/assets/characters/Adam_sit3_16x16.png",
		phone: "/assets/characters/Adam_phone_16x16.png",
	};

	const charPromises = Object.entries(poseFiles).map(([pose, src]) =>
		new Promise((resolve) => {
			const img = new Image();
			img.onload = () => { characterSprites[pose] = img; resolve(); };
			img.onerror = () => resolve();
			img.src = src;
		})
	);

	await Promise.all([loadTilesets(), fetchStates(), ...charPromises]);
	const keys = Object.keys(TILESET_URIS);
	if (keys.length > 0) selectedTileset = keys[0];
	catalog = await loadTileCatalog();
	animatedFiles = await loadAnimatedFiles();

	populateTilesetDropdown();
	renderTileset();
	buildAnimatedList();
	buildCatalogTabs();
	buildCatalogItems();
	buildConfigCategoryTabs();
	updateFieldVisibility();
	buildStationSuggestions();
	renderApproachPreview();
	startAnimation();
	statusEl.textContent = "Ready";
}

init();
