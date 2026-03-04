import { Router } from "express";
import * as schemas from "../lib/validation.js";

export default function boardRoutes(ctx) {
  const router = Router();
  const { requireAuth, stateLimiter, getProperty, broadcast, savePropertyToDisk, ENABLE_BOARD, ENABLE_REMOTE_BOARDS, IS_PRODUCTION } = ctx;

  function requireBoard(_req, res, next) {
    if (!ENABLE_BOARD) return res.status(404).json({ error: "Bulletin board is not enabled (set ENABLE_BOARD=true)" });
    next();
  }

  function requireRemoteBoard(_req, res, next) {
    if (!ENABLE_REMOTE_BOARDS) return res.status(404).json({ error: "Remote boards are not enabled (set ENABLE_REMOTE_BOARDS=true)" });
    next();
  }

  // GET /api/board/:station — read a station's content and log
  router.get("/api/board/:station", requireBoard, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station);
    if (!asset) {
      return res.status(404).json({ error: `Station "${station}" not found` });
    }
    res.json({ station, content: asset.content || null, log: asset.log || null });
  });

  // POST /api/board/:station — post content to a station's bulletin board
  router.post("/api/board/:station", requireBoard, requireAuth, stateLimiter, (req, res) => {
    const station = req.params.station;
    const validation = schemas.boardPostSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }

    const currentProperty = getProperty();
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

  // GET /api/board/:station/remote — fetch remote board
  router.get("/api/board/:station/remote", requireBoard, requireRemoteBoard, async (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station);
    if (!asset) {
      return res.status(404).json({ error: `Station "${station}" not found` });
    }
    if (!asset.remote_url || !asset.remote_station) {
      return res.status(400).json({ error: `Station "${station}" has no remote board configured` });
    }

    // SSRF check
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

  return router;
}
