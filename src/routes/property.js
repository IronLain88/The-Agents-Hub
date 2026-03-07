import { Router } from "express";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import sanitizeFilename from "sanitize-filename";
import { ensureV2 } from "../lib/property-validation.js";
import * as schemas from "../lib/validation.js";

export default function propertyRoutes(ctx) {
  const router = Router();
  const { requireAuth, propertyLimiter, getProperty, setProperty, broadcast, savePropertyToDisk, PROPERTIES_DIR, DATA_DIR, TILESETS_DIR, IS_PRODUCTION, PROP_W, PROP_H } = ctx;

  // Tile catalog
  const CATALOG_FILE = `${DATA_DIR}/tile_catalog.json`;

  function handleGetProperty(_req, res) {
    const currentProperty = getProperty();
    if (currentProperty) {
      res.json(currentProperty);
    } else {
      res.json({ version: 2, width: PROP_W, height: PROP_H, floor: [], assets: [] });
    }
  }

  function handlePostProperty(req, res) {
    const validation = schemas.propertyV2Schema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const property = ensureV2(req.body);
    if (!property) {
      return res.status(400).json({ error: "invalid property data" });
    }
    // Preserve existing queues if the incoming property doesn't have them
    const existing = getProperty();
    if (existing?.queues && !property.queues) {
      property.queues = existing.queues;
    }
    setProperty(property);
    broadcast({ type: "property_update", property });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  }

  router.get("/api/property", handleGetProperty);
  router.post("/api/property", requireAuth, propertyLimiter, handlePostProperty);
  router.get("/api/property/:ownerId", handleGetProperty);
  router.post("/api/property/:ownerId", requireAuth, propertyLimiter, handlePostProperty);

  router.get("/api/properties/list", async (_req, res) => {
    try {
      await mkdir(PROPERTIES_DIR, { recursive: true });
      const files = await readdir(PROPERTIES_DIR);
      const properties = files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
      res.json({ properties });
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  router.get("/api/properties/:name", async (req, res) => {
    try {
      const validation = schemas.propertyNameSchema.safeParse(req.params.name);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.issues[0].message });
      }
      const safeName = sanitizeFilename(req.params.name);
      const data = await readFile(`${PROPERTIES_DIR}/${safeName}.json`, "utf-8");
      res.json(JSON.parse(data));
    } catch {
      res.status(404).json({ error: "Property not found" });
    }
  });

  router.post("/api/properties/:name", requireAuth, propertyLimiter, async (req, res) => {
    try {
      const validation = schemas.propertyNameSchema.safeParse(req.params.name);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.issues[0].message });
      }
      const safeName = sanitizeFilename(req.params.name);
      const propertyValidation = schemas.propertyV2Schema.safeParse(req.body);
      if (!propertyValidation.success) {
        return res.status(400).json({ error: propertyValidation.error.errors[0].message });
      }
      await mkdir(PROPERTIES_DIR, { recursive: true });
      await writeFile(`${PROPERTIES_DIR}/${safeName}.json`, JSON.stringify(req.body, null, "\t"));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  router.post("/api/property/set-default", requireAuth, propertyLimiter, async (req, res) => {
    try {
      const validation = schemas.propertyV2Schema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.issues[0].message });
      }
      const property = ensureV2(req.body);
      if (!property) {
        return res.status(400).json({ error: "invalid property data" });
      }
      setProperty(property);
      await savePropertyToDisk();
      broadcast({ type: "property_update", property });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: IS_PRODUCTION ? "Internal server error" : err.message });
    }
  });

  router.get("/api/tilesets", async (_req, res) => {
    try {
      const files = await readdir(TILESETS_DIR);
      const tilesets = {};
      for (const f of files.filter(f => f.endsWith(".png"))) {
        const key = f.replace(/\.png$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
        tilesets[key] = `/assets/tilesets/${f}`;
      }
      res.json(tilesets);
    } catch {
      res.json({});
    }
  });

  router.get("/api/tile-catalog", async (_req, res) => {
    res.set("Cache-Control", "no-cache");
    try {
      const data = await readFile(CATALOG_FILE, "utf-8");
      res.type("json").send(data);
    } catch {
      res.status(404).json({ error: "tile_catalog.json not found" });
    }
  });

  router.post("/api/tile-catalog", requireAuth, propertyLimiter, async (req, res) => {
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

  return router;
}
