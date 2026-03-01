import {
	TILE_SIZE, GRID_W, GRID_H, STATION_COLORS,
	loadTilesets, getTilesetImage, loadAnimatedImage, getAnimatedImage, loadCutoutImage, loadImageAsset,
	drawGrid, drawTileLayer, drawAsset, drawStationOverlay,
	loadProperty, saveProperty, loadTileCatalog, loadAnimatedFiles,
	screenToGrid, inBounds, fetchStates,
	authHeaders, setupAuthUI,
} from "./editor-shared.js";
import { getApproachDirectionFor } from "../../viewer/station-logic.js";

// --- Helpers ---
function assetTileSize(sprite) {
	const w = sprite?.pw ? Math.ceil(sprite.pw / TILE_SIZE) : (sprite?.width || 1);
	const h = sprite?.ph ? Math.ceil(sprite.ph / TILE_SIZE) : (sprite?.height || 1);
	return { w, h };
}

// --- State ---
let tool = "paint";    // paint | erase | select
let catalog = { categories: [] };
let animatedFiles = [];
let imageFiles = [];
let selectedPalette = null; // { src, tx, ty, w, h, label, station, approach, collision, file }
let selectedAssetIndex = -1;
let placingApproach = false;
let showCollision = false;

const property = {
	version: 2,
	width: GRID_W,
	height: GRID_H,
	floor: [],
	assets: [],
	collision: [], // Absolute collision tiles: [{ x, y }, ...]
};

const camera = { x: 0, y: 0, zoom: 3, canvasW: 0, canvasH: 0 };
let dragging = false, dragStart = { x: 0, y: 0 }, camStart = { x: 0, y: 0 };
let painting = false;
let spaceHeld = false;

// --- DOM ---
const canvas = document.getElementById("editor-canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const paletteTabs = document.getElementById("palette-tabs");
const paletteGrid = document.getElementById("palette-grid");
const selectInfo = document.getElementById("select-info");
const selectForm = document.getElementById("select-form");

// --- Tools ---
document.getElementById("tool-paint").onclick = () => setTool("paint");
document.getElementById("tool-erase").onclick = () => setTool("erase");
document.getElementById("tool-select").onclick = () => setTool("select");

function setTool(t) {
	tool = t;
	placingApproach = false;
	document.getElementById("tool-paint").classList.toggle("active", t === "paint");
	document.getElementById("tool-erase").classList.toggle("active", t === "erase");
	document.getElementById("tool-select").classList.toggle("active", t === "select");
	if (t !== "select") { selectedAssetIndex = -1; hideSelectInfo(); }
}


document.addEventListener("keydown", (e) => {
	if (e.target.tagName === "INPUT") return;
	if (e.key === "p") setTool("paint");
	if (e.key === "e") setTool("erase");
	if (e.key === "s") setTool("select");
	if (e.key === "h" || e.key === "Home") centerCamera();
	if (e.key === " ") { spaceHeld = true; e.preventDefault(); }
	if (e.key === "Escape") placingApproach = false;
	if (e.key === "Delete" && selectedAssetIndex >= 0) {
		property.assets.splice(selectedAssetIndex, 1);
		selectedAssetIndex = -1;
		hideSelectInfo();
	}
});
document.addEventListener("keyup", (e) => {
	if (e.key === " ") spaceHeld = false;
});

// --- Save / Load ---
const saveBtn = document.getElementById("btn-save");
saveBtn.onclick = async () => {
	statusEl.textContent = "Saving...";
	saveBtn.disabled = true;
	try {
		const res = await saveProperty(null, property);
		if (res.status === 401) {
			flashButton(saveBtn, false);
			statusEl.textContent = "Unauthorized — click Login to authenticate";
		} else if (!res.ok) {
			flashButton(saveBtn, false);
			statusEl.textContent = `Save failed: ${res.status}`;
		} else {
			flashButton(saveBtn, true);
			statusEl.textContent = `Saved ✓ (${property.floor.length} floor, ${property.assets.length} assets)`;
		}
	} catch (err) {
		flashButton(saveBtn, false);
		statusEl.textContent = `Save failed: ${err.message}`;
	}
	saveBtn.disabled = false;
};

function flashButton(btn, success) {
	const color = success ? "#2a2" : "#a22";
	btn.style.background = color;
	btn.textContent = success ? "Saved ✓" : "Failed ✗";
	setTimeout(() => {
		btn.style.background = "";
		btn.textContent = "Save";
	}, 1500);
}


document.getElementById("btn-load").onclick = async () => {
	try {
		// Fetch list of saved properties
		const res = await fetch("/api/properties/list");
		const { properties } = await res.json();

		if (properties.length === 0) {
			statusEl.textContent = "No saved properties found";
			return;
		}

		const name = prompt(`Load property:\n\n${properties.join("\n")}\n\nEnter name:`);
		if (!name || !name.trim()) {
			statusEl.textContent = "Load cancelled";
			return;
		}

		statusEl.textContent = `Loading "${name}"...`;
		const loadRes = await fetch(`/api/properties/${encodeURIComponent(name)}`);
		if (!loadRes.ok) {
			statusEl.textContent = `Property "${name}" not found`;
			return;
		}

		const data = await loadRes.json();
		applyProperty(data);
		statusEl.textContent = `Loaded "${name}" (${property.floor.length} floor, ${property.assets.length} assets)`;
	} catch (err) {
		console.error("Failed to load property:", err);
		statusEl.textContent = "Load failed";
	}
};


document.getElementById("btn-export").onclick = () => {
	const json = JSON.stringify(property, null, 2);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
	a.download = "property.json";
	a.click();
};

document.getElementById("btn-import").onclick = () => {
	document.getElementById("file-import").click();
};

document.getElementById("file-import").onchange = async (e) => {
	const file = e.target.files[0];
	if (!file) return;
	try {
		const data = JSON.parse(await file.text());
		applyProperty(data);
		render();
		statusEl.textContent = `Imported ${file.name} (${property.floor.length} floor, ${property.assets.length} assets)`;
	} catch (err) {
		console.error("Import failed:", err);
		statusEl.textContent = `Import failed — ${err.message}`;
	}
	e.target.value = "";
};

document.getElementById("toggle-collision").onclick = () => {
	showCollision = !showCollision;
	document.getElementById("toggle-collision").classList.toggle("active", showCollision);
	document.getElementById("toggle-collision").textContent = showCollision ? "Hide Collision" : "Show Collision";
};


function applyProperty(data) {
	property.floor = data.floor || data.ground || [];
	property.assets = data.assets || [];
	property.collision = data.collision || [];
	property.width = data.width || GRID_W;
	property.height = data.height || GRID_H;
	// preload animated, cutout, and image assets
	for (const asset of property.assets) {
		if (asset.sprite?.file) loadAnimatedImage(asset.sprite.file);
		if (asset.sprite?.cutout) loadCutoutImage(asset.sprite.cutout);
		if (asset.sprite?.image) loadImageAsset(asset.sprite.image);
	}
	selectedAssetIndex = -1;
	hideSelectInfo();
}

// --- Palette ---
let activeCategory = 0;

function buildPalette() {
	paletteTabs.innerHTML = "";
	// Add virtual categories at the end
	const allCats = [...catalog.categories];
	if (animatedFiles.length > 0) allCats.push({ name: "Animated (All)", tiles: null });
	allCats.push({ name: "Images", tiles: null, _type: "images" });

	allCats.forEach((cat, i) => {
		const btn = document.createElement("button");
		btn.textContent = cat.name;
		btn.classList.toggle("active", i === activeCategory);
		btn.onclick = () => { activeCategory = i; buildPalette(); };
		paletteTabs.appendChild(btn);
	});

	paletteGrid.innerHTML = "";
	const cat = allCats[activeCategory];
	if (!cat) return;

	if (cat._type === "images") {
		// Upload button
		const uploadBtn = document.createElement("div");
		uploadBtn.className = "palette-item";
		uploadBtn.title = "Upload image";
		uploadBtn.style.cursor = "pointer";
		const uploadLabel = document.createElement("div");
		uploadLabel.className = "label";
		uploadLabel.textContent = "+ Upload";
		uploadBtn.appendChild(uploadLabel);
		uploadBtn.onclick = () => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = "image/*";
			input.onchange = async () => {
				const file = input.files[0];
				if (!file) return;
				const fname = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
				try {
					const buf = await file.arrayBuffer();
					const res = await fetch(`/api/images/${fname}`, {
						method: "POST",
						headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
						body: buf,
					});
					if (res.ok) {
						if (!imageFiles.includes(fname)) imageFiles.push(fname);
						buildPalette();
						statusEl.textContent = `Uploaded ${fname}`;
					} else {
						statusEl.textContent = `Upload failed: ${res.status}`;
					}
				} catch (err) {
					statusEl.textContent = `Upload failed: ${err.message}`;
				}
			};
			input.click();
		};
		paletteGrid.appendChild(uploadBtn);
		// Image thumbnails
		for (const file of imageFiles) {
			const item = createImagePaletteItem(file);
			paletteGrid.appendChild(item);
		}
		return;
	}

	if (cat.tiles === null) {
		// Virtual "all animated" category
		for (const file of animatedFiles) {
			const item = createAnimatedPaletteItem(file, null, cat.name);
			paletteGrid.appendChild(item);
		}
		return;
	}

	for (const tile of cat.tiles) {
		let item;
		if (tile.file) item = createAnimatedPaletteItem(tile.file, tile, cat.name);
		else if (tile.cutout) item = createCutoutPaletteItem(tile, cat.name);
		else if (tile.image) item = createImagePaletteItem(tile.image, tile);
		else item = createTilesetPaletteItem(tile, cat.name);
		paletteGrid.appendChild(item);
	}
}

function createTilesetPaletteItem(tile, category) {
	const item = document.createElement("div");
	item.className = "palette-item";
	item.title = tile.label || `${tile.src} [${tile.tx},${tile.ty}]`;

	const cvs = document.createElement("canvas");
	cvs.width = 48; cvs.height = 48;
	const c = cvs.getContext("2d");
	c.imageSmoothingEnabled = false;
	const w = tile.w || 1, h = tile.h || 1;
	const img = getTilesetImage(tile.src);
	if (img) {
		const sw = w * TILE_SIZE, sh = h * TILE_SIZE;
		const scale = Math.min(48 / sw, 48 / sh);
		const dw = sw * scale, dh = sh * scale;
		const cx = (48 - dw) / 2, cy = (48 - dh) / 2;
		c.drawImage(img,
			tile.tx * TILE_SIZE + (tile.ox || 0), tile.ty * TILE_SIZE + (tile.oy || 0), sw, sh,
			cx, cy, dw, dh
		);
	}
	item.appendChild(cvs);

	const lbl = document.createElement("div");
	lbl.className = "label";
	lbl.textContent = tile.label || "";
	item.appendChild(lbl);

	if (tile.station) {
		const dot = document.createElement("div");
		dot.className = "station-dot";
		dot.style.background = STATION_COLORS[tile.station] || "#fff";
		dot.title = tile.station;
		item.appendChild(dot);
	}

	item.onclick = () => {
		selectedPalette = { ...tile, _category: category };
		document.querySelectorAll(".palette-item").forEach(el => el.classList.remove("selected"));
		item.classList.add("selected");
		setTool("paint");
	};
	return item;
}

function createCutoutPaletteItem(tile, category) {
	const item = document.createElement("div");
	item.className = "palette-item";
	item.title = tile.label || tile.cutout;

	const cvs = document.createElement("canvas");
	cvs.width = 48; cvs.height = 48;
	const c = cvs.getContext("2d");
	c.imageSmoothingEnabled = false;
	const img = loadCutoutImage(tile.cutout);
	const draw = () => {
		if (!img.complete || !img.naturalWidth) return;
		const scale = Math.min(48 / img.naturalWidth, 48 / img.naturalHeight);
		const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
		c.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, (48 - dw) / 2, (48 - dh) / 2, dw, dh);
	};
	if (img.complete) draw(); else img.onload = draw;
	item.appendChild(cvs);

	const lbl = document.createElement("div");
	lbl.className = "label";
	lbl.textContent = tile.label || "";
	item.appendChild(lbl);

	if (tile.station) {
		const dot = document.createElement("div");
		dot.className = "station-dot";
		dot.style.background = STATION_COLORS[tile.station] || "#fff";
		dot.title = tile.station;
		item.appendChild(dot);
	}

	item.onclick = () => {
		selectedPalette = { ...tile, _category: category };
		document.querySelectorAll(".palette-item").forEach(el => el.classList.remove("selected"));
		item.classList.add("selected");
		setTool("paint");
	};
	return item;
}

function createAnimatedPaletteItem(file, catalogTile, category) {
	const item = document.createElement("div");
	item.className = "palette-item";
	const meta = catalogTile || {};
	item.title = meta.label || file;

	const cvs = document.createElement("canvas");
	cvs.width = 48; cvs.height = 48;
	const c = cvs.getContext("2d");
	c.imageSmoothingEnabled = false;
	const img = new Image();
	img.src = `/assets/animated/${file}`;
	img.onload = () => {
		const fw = (meta.w || 1) * TILE_SIZE;
		const fh = img.naturalHeight;
		const scale = Math.min(48 / fw, 48 / fh);
		const dw = fw * scale, dh = fh * scale;
		c.drawImage(img, 0, 0, fw, fh, (48 - dw) / 2, (48 - dh) / 2, dw, dh);
	};
	item.appendChild(cvs);

	const lbl = document.createElement("div");
	lbl.className = "label";
	lbl.textContent = meta.label || file.replace("animated_", "").replace(".png", "");
	item.appendChild(lbl);

	if (meta.station) {
		const dot = document.createElement("div");
		dot.className = "station-dot";
		dot.style.background = STATION_COLORS[meta.station] || "#fff";
		item.appendChild(dot);
	}

	item.onclick = () => {
		selectedPalette = {
			file,
			w: meta.w || 1,
			h: meta.h || 2,
			label: meta.label || file,
			station: meta.station || "",
			approach: meta.approach || "below",
			pose: meta.pose,
			facing: meta.facing,
			approaches: meta.approaches,
			layer: meta.layer,
			_category: category,
		};
		document.querySelectorAll(".palette-item").forEach(el => el.classList.remove("selected"));
		item.classList.add("selected");
		setTool("paint");
	};
	return item;
}

function createImagePaletteItem(file, catalogTile) {
	const meta = catalogTile || {};
	const item = document.createElement("div");
	item.className = "palette-item";
	item.title = meta.label || file;

	const cvs = document.createElement("canvas");
	cvs.width = 48; cvs.height = 48;
	const c = cvs.getContext("2d");
	c.imageSmoothingEnabled = false;
	// Placeholder frame
	c.fillStyle = '#5a3a1a';
	c.fillRect(4, 4, 40, 40);
	c.fillStyle = '#8b6914';
	c.fillRect(6, 6, 36, 36);
	c.fillStyle = '#444';
	c.fillRect(10, 10, 28, 28);
	const img = loadImageAsset(file);
	const draw = () => {
		if (!img.complete || !img.naturalWidth) return;
		c.clearRect(0, 0, 48, 48);
		const scale = Math.min(48 / img.naturalWidth, 48 / img.naturalHeight);
		const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
		c.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, (48 - dw) / 2, (48 - dh) / 2, dw, dh);
	};
	if (img.complete && img.naturalWidth) draw(); else img.onload = draw;
	item.appendChild(cvs);

	const lbl = document.createElement("div");
	lbl.className = "label";
	lbl.textContent = meta.label || file.replace(/\.[^.]+$/, '');
	item.appendChild(lbl);

	item.onclick = () => {
		selectedPalette = {
			image: file,
			pw: meta.pw || 32,
			ph: meta.ph || 32,
			label: meta.label || file,
			padding: meta.padding ?? 3,
			frame: meta.frame,
			feet: meta.feet,
			_category: "Images",
		};
		document.querySelectorAll(".palette-item").forEach(el => el.classList.remove("selected"));
		item.classList.add("selected");
		setTool("paint");
	};
	return item;
}

// --- Select info panel ---

function hideSelectInfo() { selectInfo.style.display = "none"; }

function showSelectInfo(asset) {
	selectInfo.style.display = "block";
	selectForm.innerHTML = "";

	// Only show fields relevant to the asset type
	const fields = [];
	if (asset.station || asset.trigger) {
		fields.push({ key: "station", label: "Station", value: asset.station || "" });
		fields.push({ key: "approach", label: "Approach", value: asset.approach || "below", options: ["above", "below", "left", "right", "on"] });
	}
	fields.push({ key: "collision", label: "Collision", value: asset.collision ? "true" : "false", options: ["false", "true"] });

	for (const f of fields) {
		const label = document.createElement("label");
		label.textContent = f.label;
		let input;
		if (f.options) {
			input = document.createElement("select");
			for (const opt of f.options) {
				const o = document.createElement("option");
				o.value = opt; o.textContent = opt;
				if (opt === f.value) o.selected = true;
				input.appendChild(o);
			}
		} else {
			input = document.createElement("input");
			input.type = "text";
			input.value = f.value;
		}
		input.onchange = () => {
			if (selectedAssetIndex < 0) return;
			const a = property.assets[selectedAssetIndex];
			if (f.key === "collision") a.collision = input.value === "true";
			else a[f.key] = input.value || undefined;
		};
		label.appendChild(input);
		selectForm.appendChild(label);
	}

	// Signal: trigger type selector + conditional interval input
	if (asset.trigger !== undefined) {
		const signalLabel = document.createElement("label");
		signalLabel.textContent = "Signal";
		const signalSelect = document.createElement("select");
		for (const opt of ["none", "interval", "manual"]) {
			const o = document.createElement("option");
			o.value = opt; o.textContent = opt;
			const current = !asset.trigger ? "none" : asset.trigger === "manual" ? "manual" : "interval";
			if (opt === current) o.selected = true;
			signalSelect.appendChild(o);
		}

		const intervalLabel = document.createElement("label");
		intervalLabel.textContent = "Interval (min)";
		const intervalInput = document.createElement("input");
		intervalInput.type = "number";
		intervalInput.min = "1";
		intervalInput.value = String(asset.trigger_interval || 1);
		intervalLabel.appendChild(intervalInput);
		intervalLabel.style.display = asset.trigger && asset.trigger !== "manual" ? "" : "none";

		const payloadCheckLabel = document.createElement("label");
		const payloadCheckbox = document.createElement("input");
		payloadCheckbox.type = "checkbox";
		payloadCheckbox.checked = asset.allow_payload === true;
		payloadCheckbox.style.marginRight = "6px";
		payloadCheckLabel.appendChild(payloadCheckbox);
		payloadCheckLabel.appendChild(document.createTextNode("Allow payload"));
		payloadCheckLabel.style.display = asset.trigger ? "" : "none";
		payloadCheckLabel.title = "Enable this signal to accept and forward payloads (requires hub ALLOW_SIGNAL_PAYLOADS=true)";

		const payloadLabel = document.createElement("label");
		payloadLabel.textContent = "Payload (JSON)";
		const payloadInput = document.createElement("textarea");
		payloadInput.rows = 3;
		payloadInput.placeholder = '{"key": "value"} or simple text';
		payloadInput.value = asset.trigger_payload !== undefined ? (typeof asset.trigger_payload === "string" ? asset.trigger_payload : JSON.stringify(asset.trigger_payload, null, 2)) : "";
		payloadInput.style.fontFamily = "monospace";
		payloadInput.style.fontSize = "12px";
		payloadInput.disabled = asset.allow_payload !== true;
		payloadLabel.appendChild(payloadInput);
		payloadLabel.style.display = asset.trigger ? "" : "none";

		signalSelect.onchange = () => {
			if (selectedAssetIndex < 0) return;
			const a = property.assets[selectedAssetIndex];
			if (signalSelect.value === "interval") {
				a.trigger = "heartbeat";
				a.trigger_interval = a.trigger_interval || 1;
				intervalLabel.style.display = "";
				payloadCheckLabel.style.display = "";
				payloadLabel.style.display = "";
			} else if (signalSelect.value === "manual") {
				a.trigger = "manual";
				delete a.trigger_interval;
				intervalLabel.style.display = "none";
				payloadCheckLabel.style.display = "";
				payloadLabel.style.display = "";
			} else {
				delete a.trigger;
				delete a.trigger_interval;
				delete a.trigger_payload;
				delete a.allow_payload;
				intervalLabel.style.display = "none";
				payloadCheckLabel.style.display = "none";
				payloadLabel.style.display = "none";
			}
		};
		intervalInput.onchange = () => {
			if (selectedAssetIndex < 0) return;
			property.assets[selectedAssetIndex].trigger_interval = Math.max(1, parseInt(intervalInput.value) || 1);
		};
		payloadCheckbox.onchange = () => {
			if (selectedAssetIndex < 0) return;
			const a = property.assets[selectedAssetIndex];
			if (payloadCheckbox.checked) {
				a.allow_payload = true;
				payloadInput.disabled = false;
			} else {
				delete a.allow_payload;
				delete a.trigger_payload;
				payloadInput.value = "";
				payloadInput.disabled = true;
			}
		};
		payloadInput.onchange = () => {
			if (selectedAssetIndex < 0) return;
			const val = payloadInput.value.trim();
			if (val === "") {
				delete property.assets[selectedAssetIndex].trigger_payload;
			} else {
				try {
					property.assets[selectedAssetIndex].trigger_payload = JSON.parse(val);
				} catch {
					property.assets[selectedAssetIndex].trigger_payload = val;
				}
			}
		};

		signalLabel.appendChild(signalSelect);
		selectForm.appendChild(signalLabel);
		selectForm.appendChild(intervalLabel);
		selectForm.appendChild(payloadCheckLabel);
		selectForm.appendChild(payloadLabel);
	}

	if (asset.station) {
		const approachBtn = document.createElement("button");
		approachBtn.textContent = "Set Approach";
		approachBtn.style.marginTop = "6px";
		approachBtn.onclick = () => {
			placingApproach = !placingApproach;
			approachBtn.classList.toggle("active", placingApproach);
		};
		selectForm.appendChild(approachBtn);
	}

	const del = document.createElement("button");
	del.textContent = "Delete Asset";
	del.className = "danger";
	del.style.marginTop = "6px";
	del.onclick = () => {
		if (selectedAssetIndex >= 0) {
			property.assets.splice(selectedAssetIndex, 1);
			selectedAssetIndex = -1;
			hideSelectInfo();
		}
	};
	selectForm.appendChild(del);
}

// --- Canvas interactions ---

canvas.addEventListener("wheel", (e) => {
	e.preventDefault();
	const rect = canvas.getBoundingClientRect();
	const mx = e.clientX - rect.left;
	const my = e.clientY - rect.top;
	const oldZoom = camera.zoom;
	camera.zoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
	camera.zoom = Math.max(0.5, Math.min(10, camera.zoom));
	// Keep world point under cursor fixed
	camera.x += (mx - camera.canvasW / 2) / camera.zoom - (mx - camera.canvasW / 2) / oldZoom;
	camera.y += (my - camera.canvasH / 2) / camera.zoom - (my - camera.canvasH / 2) / oldZoom;
}, { passive: false });

canvas.addEventListener("pointerdown", (e) => {
	const rect = canvas.getBoundingClientRect();
	const mx = e.clientX - rect.left;
	const my = e.clientY - rect.top;

	// Middle button or Space+left = pan
	if (e.button === 1) {
		dragging = true;
		dragStart = { x: e.clientX, y: e.clientY };
		camStart = { x: camera.x, y: camera.y };
		canvas.setPointerCapture(e.pointerId);
		e.preventDefault();
		return;
	}

	const grid = screenToGrid(mx, my, camera);

	// Right click = erase
	if (e.button === 2) {
		if (inBounds(grid.x, grid.y)) eraseAt(grid.x, grid.y);
		painting = true;
		canvas.setPointerCapture(e.pointerId);
		return;
	}

	// Left click
	if (e.button === 0) {
		// Pan if no palette selected and paint tool, or if holding space
		if (spaceHeld || (tool === "paint" && !selectedPalette)) {
			dragging = true;
			dragStart = { x: e.clientX, y: e.clientY };
			camStart = { x: camera.x, y: camera.y };
			canvas.setPointerCapture(e.pointerId);
			return;
		}
		if (tool === "select") {
			selectAt(grid.x, grid.y);
		} else if (tool === "paint" && selectedPalette) {
			paintAt(grid.x, grid.y);
			painting = true;
		} else if (tool === "erase") {
			if (inBounds(grid.x, grid.y)) eraseAt(grid.x, grid.y);
			painting = true;
		}
		canvas.setPointerCapture(e.pointerId);
	}
});

canvas.addEventListener("pointermove", (e) => {
	if (dragging) {
		camera.x = camStart.x + (e.clientX - dragStart.x) / camera.zoom;
		camera.y = camStart.y + (e.clientY - dragStart.y) / camera.zoom;
		return;
	}
	if (!painting) return;
	const rect = canvas.getBoundingClientRect();
	const grid = screenToGrid(e.clientX - rect.left, e.clientY - rect.top, camera);
	if (!inBounds(grid.x, grid.y)) return;

	if (tool === "paint" && selectedPalette && selectedPalette._category === "Floors") {
		paintAt(grid.x, grid.y);
	} else if (tool === "paint" && showCollision && !selectedPalette) {
		paintAt(grid.x, grid.y);
	} else if (tool === "erase" || e.buttons === 2) {
		eraseAt(grid.x, grid.y);
	}
});

canvas.addEventListener("pointerup", () => { dragging = false; painting = false; });
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// --- Paint / Erase ---

function paintAt(gx, gy) {
	if (!inBounds(gx, gy)) return;

	if (showCollision && !selectedPalette) {
		// Paint absolute collision tile
		if (!property.collision.some(t => t.x === gx && t.y === gy)) {
			property.collision.push({ x: gx, y: gy });
		}
	} else if (selectedPalette?._category === "Floors") {
		// Remove existing floor tile at this position
		property.floor = property.floor.filter(t => t.x !== gx || t.y !== gy);
		property.floor.push({
			src: selectedPalette.src,
			x: gx, y: gy,
			ax: selectedPalette.tx, ay: selectedPalette.ty,
		});
	} else {
		if (!selectedPalette) return;
		// Assets layer: place a multi-tile asset
		const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const asset = {
			id,
			position: { x: gx, y: gy },
		};
		if (selectedPalette.file) {
			asset.sprite = { file: selectedPalette.file, width: selectedPalette.w || 1 };
			loadAnimatedImage(selectedPalette.file);
		} else if (selectedPalette.image) {
			asset.sprite = { image: selectedPalette.image, pw: selectedPalette.pw || 32, ph: selectedPalette.ph || 32, padding: selectedPalette.padding ?? 3 };
			if (selectedPalette.frame) asset.sprite.frame = selectedPalette.frame;
			if (selectedPalette.feet) asset.sprite.feet = true;
			loadImageAsset(selectedPalette.image);
		} else if (selectedPalette.cutout) {
			asset.sprite = { cutout: selectedPalette.cutout, width: selectedPalette.w || 1, height: selectedPalette.h || 1, padding: selectedPalette.padding || 0 };
			loadCutoutImage(selectedPalette.cutout);
		} else {
			asset.sprite = {
				tileset: selectedPalette.src,
				tx: selectedPalette.tx,
				ty: selectedPalette.ty,
				width: selectedPalette.w || 1,
				height: selectedPalette.h || 1,
			};
			if (selectedPalette.ox) asset.sprite.ox = selectedPalette.ox;
			if (selectedPalette.oy) asset.sprite.oy = selectedPalette.oy;
		}
		if (selectedPalette.station) asset.station = selectedPalette.station;
		if (selectedPalette.approach) asset.approach = selectedPalette.approach;
		if (selectedPalette.pose) asset.pose = selectedPalette.pose;
		if (selectedPalette.facing) asset.facing = selectedPalette.facing;
		if (selectedPalette.approaches) asset.approaches = selectedPalette.approaches;
		if (selectedPalette.collision === "solid") asset.collision = true;
		if (selectedPalette.layer || selectedPalette._category === "Walls") asset.layer = "wall";
		// Signal assets: prompt for name, copy trigger fields
		if (selectedPalette.trigger) {
			const existing = property.assets.filter(a => a.trigger === selectedPalette.trigger).length;
			const defaultName = `${selectedPalette.label || selectedPalette.trigger} ${existing + 1}`;
			const name = prompt("Name this signal:", defaultName);
			if (!name) return; // cancelled
			asset.station = name;
			asset.trigger = selectedPalette.trigger;
			asset.trigger_interval = selectedPalette.trigger_interval || 1;
		}
		property.assets.push(asset);
	}
}

function eraseAt(gx, gy) {
	if (showCollision) {
		property.collision = property.collision.filter(t => t.x !== gx || t.y !== gy);
		return;
	}
	// Try assets first (reverse order to hit topmost first)
	for (let i = property.assets.length - 1; i >= 0; i--) {
		const a = property.assets[i];
		if (!a.position) continue;
		const { w, h } = assetTileSize(a.sprite);
		if (gx >= a.position.x && gx < a.position.x + w &&
			gy >= a.position.y && gy < a.position.y + h) {
			property.assets.splice(i, 1);
			if (selectedAssetIndex === i) { selectedAssetIndex = -1; hideSelectInfo(); }
			return;
		}
	}
	// No asset found — erase floor tile
	property.floor = property.floor.filter(t => t.x !== gx || t.y !== gy);
}

function selectAt(gx, gy) {
	if (placingApproach && selectedAssetIndex >= 0) {
		const asset = property.assets[selectedAssetIndex];
		const ox = gx - asset.position.x;
		const oy = gy - asset.position.y;
		const { w, h } = assetTileSize(asset.sprite);

		if (!asset.approaches) asset.approaches = [];

		// Toggle: clicking same tile removes it
		const existing = asset.approaches.findIndex(a => a.x === ox && a.y === oy);
		if (existing >= 0) {
			asset.approaches.splice(existing, 1);
			if (asset.approaches.length === 0) delete asset.approaches;
		} else {
			const dir = getApproachDirectionFor({ x: ox, y: oy }, w, h);
			// Add new approach position (up to 3 total)
			if (asset.approaches.length < 3) {
				asset.approaches.push({ x: ox, y: oy, dir });
			} else {
				statusEl.textContent = "Maximum 3 approach positions per asset";
			}
		}
		placingApproach = false;
		return;
	}

	for (let i = property.assets.length - 1; i >= 0; i--) {
		const a = property.assets[i];
		if (!a.position) continue;
		const { w, h } = assetTileSize(a.sprite);
		if (gx >= a.position.x && gx < a.position.x + w &&
			gy >= a.position.y && gy < a.position.y + h) {
			selectedAssetIndex = i;
			showSelectInfo(a);
			return;
		}
	}
	selectedAssetIndex = -1;
	hideSelectInfo();
}

// --- Rendering ---

function centerCamera() {
	camera.x = -(GRID_W * TILE_SIZE) / 2;
	camera.y = -(GRID_H * TILE_SIZE) / 2;
	const zoomX = camera.canvasW / (GRID_W * TILE_SIZE);
	const zoomY = camera.canvasH / (GRID_H * TILE_SIZE);
	camera.zoom = Math.max(0.5, Math.min(10, Math.min(zoomX, zoomY) * 0.9));
}

function render() {
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
		camera.canvasW = w;
		camera.canvasH = h;
	}

	ctx.imageSmoothingEnabled = false;
	ctx.fillStyle = "#1a1a2e";
	ctx.fillRect(0, 0, w, h);

	ctx.save();
	ctx.translate(w / 2, h / 2);
	ctx.scale(camera.zoom, camera.zoom);
	ctx.translate(camera.x, camera.y);

	// Background
	ctx.fillStyle = "rgba(255,255,255,0.03)";
	ctx.fillRect(0, 0, GRID_W * TILE_SIZE, GRID_H * TILE_SIZE);

	// Floor
	drawTileLayer(ctx, property.floor);

	// Assets — walls first, then furniture
	for (const asset of property.assets) {
		if (asset.layer === 'wall') drawAsset(ctx, asset);
	}
	for (const asset of property.assets) {
		if (asset.layer !== 'wall') drawAsset(ctx, asset);
	}

	// Collision overlay
	if (showCollision) {
		// Asset collision (semi-transparent red)
		ctx.fillStyle = "rgba(255, 0, 0, 0.3)";
		for (const asset of property.assets) {
			if (!asset.collision || !asset.position) continue;
			const { w, h } = assetTileSize(asset.sprite);
			for (let dy = 0; dy < h; dy++) {
				for (let dx = 0; dx < w; dx++) {
					const px = (asset.position.x + dx) * TILE_SIZE;
					const py = (asset.position.y + dy) * TILE_SIZE;
					ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
				}
			}
		}

		// Absolute collision (darker red with border)
		ctx.fillStyle = "rgba(180, 0, 0, 0.6)";
		ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
		ctx.lineWidth = 2 / camera.zoom;
		for (const tile of property.collision || []) {
			const px = tile.x * TILE_SIZE;
			const py = tile.y * TILE_SIZE;
			ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
			ctx.strokeRect(px, py, TILE_SIZE, TILE_SIZE);
		}
	}

	// Station overlays
	for (const asset of property.assets) {
		drawStationOverlay(ctx, asset, camera.zoom);
	}

	// Selection highlight
	if (selectedAssetIndex >= 0 && property.assets[selectedAssetIndex]) {
		const a = property.assets[selectedAssetIndex];
		const px = a.position.x * TILE_SIZE;
		const py = a.position.y * TILE_SIZE;
		const sw = a.sprite?.pw || (a.sprite?.width || 1) * TILE_SIZE;
		const sh = a.sprite?.ph || (a.sprite?.height || 1) * TILE_SIZE;
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 2 / camera.zoom;
		ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
		ctx.strokeRect(px, py, sw, sh);
		ctx.setLineDash([]);
	}

	// Grid
	drawGrid(ctx, camera.zoom);

	ctx.restore();
	requestAnimationFrame(render);
}

// --- Init ---

async function init() {
	setupAuthUI();
	statusEl.textContent = "Loading assets...";
	await Promise.all([loadTilesets(), fetchStates()]);
	catalog = await loadTileCatalog();
	animatedFiles = await loadAnimatedFiles();
	try {
		const res = await fetch("/api/images");
		if (res.ok) imageFiles = await res.json();
	} catch { /* empty */ }
	buildPalette();

	// Always load default property
	statusEl.textContent = "Loading default property...";
	try {
		const data = await loadProperty();
		if (data) {
			applyProperty(data);
			statusEl.textContent = `Default property loaded (${property.floor.length} floor, ${property.assets.length} assets)`;
		} else {
			statusEl.textContent = "Ready (empty property)";
		}
	} catch (err) {
		console.error("Failed to load default property:", err);
		statusEl.textContent = "Ready (empty property)";
	}

	centerCamera();
	requestAnimationFrame(render);
}

init();
