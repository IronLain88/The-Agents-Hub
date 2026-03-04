import { Router } from "express";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { formatBreadcrumb, applyBreadcrumb, applyNote } from "../lib/station-log.js";
import * as schemas from "../lib/validation.js";

export default function assetRoutes(ctx) {
  const router = Router();
  const { requireAuth, propertyLimiter, stateLimiter, spriteLimiter, getProperty, broadcast, savePropertyToDisk, IMAGES_DIR, CUTOUTS_DIR, spriteStore, IS_PRODUCTION, __dirname } = ctx;

  // POST /api/assets — add a new asset
  router.post("/api/assets", requireAuth, propertyLimiter, (req, res) => {
    const validation = schemas.addAssetSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const currentProperty = getProperty();
    if (!currentProperty) {
      return res.status(404).json({ error: "No property loaded" });
    }

    const { name, tileset, tx, ty, x, y, station, approach, collision, remote_url, remote_station, reception, task, openclaw_task, task_public, instructions, archive, welcome } = validation.data;
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
      ...(welcome && { welcome: true }),
    };

    currentProperty.assets.push(asset);
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true, asset });
  });

  // DELETE /api/assets/:id — remove an asset
  router.delete("/api/assets/:id", requireAuth, propertyLimiter, (req, res) => {
    const currentProperty = getProperty();
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

  // PATCH /api/assets/:id — update asset fields
  router.patch("/api/assets/:id", requireAuth, propertyLimiter, (req, res) => {
    const validation = schemas.patchAssetSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const currentProperty = getProperty();
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

  // POST /api/assets/:id/log — append a breadcrumb or note
  router.post("/api/assets/:id/log", requireAuth, stateLimiter, (req, res) => {
    const validation = schemas.logEntrySchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const currentProperty = getProperty();
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

  // Image storage
  router.get("/api/images", async (_req, res) => {
    try {
      await mkdir(IMAGES_DIR, { recursive: true });
      const files = (await readdir(IMAGES_DIR)).filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f));
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  router.post("/api/images/:filename", requireAuth, propertyLimiter, async (req, res) => {
    try {
      const fname = req.params.filename;
      if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(fname)) {
        return res.status(400).json({ error: "Invalid filename" });
      }
      await mkdir(IMAGES_DIR, { recursive: true });
      await writeFile(`${IMAGES_DIR}/${fname}`, req.body);
      res.json({ ok: true, path: `/assets/images/${fname}` });
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  // Cutout storage
  router.post("/api/cutouts/:filename", requireAuth, propertyLimiter, async (req, res) => {
    try {
      const fname = req.params.filename;
      if (!/^[a-zA-Z0-9_-]+\.png$/.test(fname)) {
        return res.status(400).json({ error: "Invalid filename" });
      }
      await mkdir(CUTOUTS_DIR, { recursive: true });
      await writeFile(`${CUTOUTS_DIR}/${fname}`, req.body);
      res.json({ ok: true, path: `/assets/cutouts/${fname}` });
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  // Custom sprite storage
  router.post("/api/sprites/:filename", requireAuth, spriteLimiter, async (req, res) => {
    try {
      const validation = schemas.spriteFilenameSchema.safeParse(req.params.filename);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.issues[0].message });
      }
      const fileType = await fileTypeFromBuffer(req.body);
      if (!fileType || fileType.mime !== "image/png") {
        return res.status(400).json({ error: "Only PNG images are allowed" });
      }
      spriteStore.set(req.params.filename, req.body);
      if (spriteStore.size > 50) {
        const oldest = spriteStore.keys().next().value;
        spriteStore.delete(oldest);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  router.get("/assets/sprites/:filename", (req, res) => {
    const buf = spriteStore.get(req.params.filename);
    if (!buf) return res.status(404).send("Not found");
    res.type("image/png").send(buf);
  });

  // Animated files listing
  router.get("/api/animated-files", async (_req, res) => {
    try {
      const files = await readdir(`${__dirname}/../assets/animated`);
      res.json(files.filter(f => f.endsWith(".png")));
    } catch {
      res.json([]);
    }
  });

  return router;
}
