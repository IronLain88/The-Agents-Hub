import { Router } from "express";
import { z } from "zod";

const dtoCreateSchema = z.object({
  type: z.string().max(50).optional(),
  by: z.string().min(1).max(100),
  data: z.string().min(1).max(10000),
});

const dtoForwardSchema = z.object({
  target_station: z.string().min(1).max(100),
  by: z.string().min(1).max(100),
  data: z.string().min(1).max(10000),
});

function makeDtoId() {
  return Math.random().toString(36).slice(2, 10);
}

function triggerTaskStation(asset, dto, broadcast, getProperty) {
  if (!asset?.task) return;
  let state = { status: "idle", result: null };
  try { if (asset.content?.data) state = JSON.parse(asset.content.data); } catch {}
  if (state.status !== "idle") return; // already busy
  const first = dto.trail[0] || {};
  state.status = "pending";
  state.result = null;
  state.claimedBy = null;
  state.startedAt = new Date().toISOString();
  state.prompt = first.data || "";
  state.dtoId = dto.id;
  asset.content = { type: "task", data: JSON.stringify(state) };
  broadcast({ type: "signal", station: asset.station, trigger: "manual", timestamp: Date.now(), payload: { station: asset.station, instructions: asset.instructions } });
  broadcast({ type: "property_update", property: getProperty() });
  console.log(`[hub] Queue: triggered task station "${asset.station}" (dto ${dto.id})`);
}

export default function queueRoutes(ctx) {
  const router = Router();
  const { requireAuth, stateLimiter, getProperty, broadcast, savePropertyToDisk, API_KEY, ENABLE_GET_INBOX } = ctx;

  function getQueues() {
    const p = getProperty();
    if (!p) return null;
    if (!p.queues) p.queues = {};
    return p.queues;
  }

  // GET /api/queue/:station — list DTOs at a station
  router.get("/api/queue/:station", requireAuth, (req, res) => {
    const queues = getQueues();
    if (!queues) return res.status(503).json({ error: "No property loaded" });
    const dtos = queues[req.params.station] || [];
    res.json({ station: req.params.station, count: dtos.length, dtos });
  });

  // POST /api/queue/:station — create a DTO at a station
  router.post("/api/queue/:station", requireAuth, stateLimiter, (req, res) => {
    const validation = dtoCreateSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: validation.error.issues[0].message });

    const queues = getQueues();
    if (!queues) return res.status(503).json({ error: "No property loaded" });

    const station = req.params.station;
    const { type = "message", by, data } = validation.data;
    const dto = {
      id: makeDtoId(),
      type,
      created_at: new Date().toISOString(),
      trail: [{ station, by, at: new Date().toISOString(), data }],
    };

    if (!queues[station]) queues[station] = [];
    queues[station].push(dto);
    while (queues[station].length > 100) queues[station].shift();

    // Trigger task station if applicable, otherwise just fire signal
    const property = getProperty();
    const stationAsset = property?.assets?.find(a => a.station === station);
    if (stationAsset?.task) {
      triggerTaskStation(stationAsset, dto, broadcast, getProperty);
    } else {
      broadcast({ type: "signal", station, trigger: "manual", timestamp: Date.now() });
    }

    broadcast({ type: "property_update", property: getProperty() });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save:", e));
    console.log(`[hub] Queue "${station}": DTO ${dto.id} created by "${by}"`);
    res.json({ ok: true, dto, count: queues[station].length });
  });

  // DELETE /api/queue/:station — clear all DTOs at a station
  router.delete("/api/queue/:station", requireAuth, stateLimiter, (req, res) => {
    const queues = getQueues();
    if (!queues) return res.status(503).json({ error: "No property loaded" });

    const station = req.params.station;
    const count = (queues[station] || []).length;
    queues[station] = [];
    broadcast({ type: "property_update", property: getProperty() });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save:", e));
    console.log(`[hub] Queue "${station}": cleared ${count} DTOs`);
    res.json({ ok: true, cleared: count });
  });

  // DELETE /api/queue/:station/:id — consume/remove a DTO
  router.delete("/api/queue/:station/:id", requireAuth, stateLimiter, (req, res) => {
    const queues = getQueues();
    if (!queues) return res.status(503).json({ error: "No property loaded" });

    const station = req.params.station;
    const queue = queues[station] || [];
    const idx = queue.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "DTO not found" });

    const [dto] = queue.splice(idx, 1);
    broadcast({ type: "property_update", property: getProperty() });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save:", e));
    res.json({ ok: true, dto });
  });

  // POST /api/queue/:station/:id/forward — append trail + move to target station
  router.post("/api/queue/:station/:id/forward", requireAuth, stateLimiter, (req, res) => {
    const validation = dtoForwardSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: validation.error.issues[0].message });

    const queues = getQueues();
    if (!queues) return res.status(503).json({ error: "No property loaded" });

    const station = req.params.station;
    const queue = queues[station] || [];
    const idx = queue.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "DTO not found" });

    const { target_station, by, data } = validation.data;

    // Same-station: update trail in place (agent marking work done)
    if (target_station === station) {
      queue[idx].trail.push({ station, by, at: new Date().toISOString(), data });
      broadcast({ type: "property_update", property: getProperty() });
      savePropertyToDisk().catch(e => console.error("[hub] Failed to save:", e));
      console.log(`[hub] Queue: DTO "${queue[idx].id}" trail updated at "${station}" by "${by}"`);
      return res.json({ ok: true, dto: queue[idx] });
    }

    const [dto] = queue.splice(idx, 1);
    dto.trail.push({ station: target_station, by, at: new Date().toISOString(), data });

    if (!queues[target_station]) queues[target_station] = [];
    queues[target_station].push(dto);

    const property = getProperty();
    const fromAsset = property?.assets?.find(a => a.station === station);
    const toAsset = property?.assets?.find(a => a.station === target_station);
    broadcast({
      type: "card_travel",
      card_id: dto.id,
      from_pos: fromAsset?.position || { x: 0, y: 0 },
      to_pos: toAsset?.position || { x: 0, y: 0 },
    });

    // Trigger task station if applicable, otherwise just fire signal
    if (toAsset?.task) {
      triggerTaskStation(toAsset, dto, broadcast, getProperty);
    } else {
      broadcast({ type: "signal", station: target_station, trigger: "manual", timestamp: Date.now() });
    }

    broadcast({ type: "property_update", property: getProperty() });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save:", e));
    console.log(`[hub] Queue: DTO "${dto.id}" forwarded "${station}" → "${target_station}" by "${by}"`);
    res.json({ ok: true, dto });
  });

  // GET /api/hello — GET-based message delivery for clients that can't POST
  if (ENABLE_GET_INBOX) {
    router.get("/api/hello", stateLimiter, (req, res) => {
      const { from, text, key, station } = req.query;
      if (API_KEY && key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
      if (!from || !text) return res.status(400).json({ error: "from and text are required" });

      const currentProperty = getProperty();

      // If station param given, try to place as task
      if (station) {
        const taskAsset = currentProperty?.assets?.find(a => a.station === station && a.task);
        if (!taskAsset) return res.status(404).json({ error: `Task station "${station}" not found` });

        let state = { status: "idle", result: null };
        try { if (taskAsset.content?.data) state = JSON.parse(taskAsset.content.data); } catch {}
        if (state.status !== "idle") return res.status(409).json({ error: "Task station is busy" });

        state.status = "pending";
        state.result = null;
        state.claimedBy = null;
        state.startedAt = new Date().toISOString();
        state.prompt = `From ${from}: ${text}`;
        taskAsset.content = { type: "task", data: JSON.stringify(state) };

        broadcast({ type: "signal", station, trigger: "manual", timestamp: Date.now(), payload: { station, instructions: taskAsset.instructions } });
        broadcast({ type: "property_update", property: currentProperty });
        savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
        console.log(`[hub] GET task "${station}" from "${from}"`);
        return res.json({ ok: true, message: "delivered", target: station });
      }

      // Default: create DTO in inbox queue
      const queues = getQueues();
      if (!queues) return res.status(503).json({ error: "No property loaded" });

      const inboxStation = "inbox";
      if (!queues[inboxStation]) queues[inboxStation] = [];

      const dto = {
        id: makeDtoId(),
        type: "message",
        created_at: new Date().toISOString(),
        trail: [{ station: inboxStation, by: String(from), at: new Date().toISOString(), data: String(text) }],
      };
      queues[inboxStation].push(dto);
      while (queues[inboxStation].length > 100) queues[inboxStation].shift();

      broadcast({ type: "property_update", property: currentProperty });
      savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
      console.log(`[hub] GET inbox message from "${from}" (${queues[inboxStation].length} total)`);
      res.json({ ok: true, message: "delivered", target: "inbox", count: queues[inboxStation].length });
    });
  }

  return router;
}
