import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as schemas from "../lib/validation.js";

export default function taskRoutes(ctx) {
  const router = Router();
  const { requireAuth, stateLimiter, getProperty, broadcast, savePropertyToDisk, API_KEY } = ctx;

  const taskLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: "Too many task requests, please try again later" },
  });

  // POST /api/task/:station/run — visitor triggers a task
  router.post("/api/task/:station/run", taskLimiter, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
    if (!asset) return res.status(404).json({ error: "Task station not found" });

    if (!asset.task_public && API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ error: "This task requires authentication" });
    }

    let state = { status: "idle", result: null };
    try {
      if (asset.content?.data) state = JSON.parse(asset.content.data);
    } catch {}

    if (state.status !== "idle") {
      return res.status(409).json({ error: "Task is already running" });
    }

    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.slice(0, 2000) : null;
    state.status = "pending";
    state.result = null;
    state.claimedBy = null;
    state.startedAt = new Date().toISOString();
    if (prompt) state.prompt = prompt;
    asset.content = { type: "task", data: JSON.stringify(state) };

    broadcast({
      type: "signal", station, trigger: "manual", timestamp: Date.now(),
      payload: { station, instructions: asset.instructions },
    });
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  // POST /api/task/:station/claim — agent claims a pending task
  router.post("/api/task/:station/claim", requireAuth, stateLimiter, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
    if (!asset) return res.status(404).json({ error: "Task station not found" });

    let state = { status: "idle", result: null };
    try {
      if (asset.content?.data) state = JSON.parse(asset.content.data);
    } catch {}

    if (state.status !== "pending") {
      return res.status(409).json({ error: "No pending task to claim" });
    }
    if (state.claimedBy) {
      return res.status(409).json({ error: `Already claimed by ${state.claimedBy}` });
    }

    const agentId = req.body?.agent_id || "unknown";
    if (asset.assigned_to && !agentId.toLowerCase().startsWith(asset.assigned_to.toLowerCase())) {
      return res.status(403).json({ error: `Task assigned to "${asset.assigned_to}" only` });
    }
    state.claimedBy = agentId;
    asset.content = { type: "task", data: JSON.stringify(state) };

    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true, instructions: asset.instructions, prompt: state.prompt || null });
  });

  // POST /api/task/:station/result — agent posts a result
  router.post("/api/task/:station/result", requireAuth, stateLimiter, (req, res) => {
    const validation = schemas.taskResultSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
    if (!asset) return res.status(404).json({ error: "Task station not found" });

    let state = { status: "idle", result: null };
    try {
      if (asset.content?.data) state = JSON.parse(asset.content.data);
    } catch {}

    if (state.status !== "pending") {
      return res.status(409).json({ error: "No pending task" });
    }

    state.status = "done";
    state.result = validation.data.result;
    state.completedAt = new Date().toISOString();
    asset.content = { type: "task", data: JSON.stringify(state) };

    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  // PATCH /api/task/:station — update task settings
  router.patch("/api/task/:station", requireAuth, stateLimiter, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
    if (!asset) return res.status(404).json({ error: "Task station not found" });

    if (typeof req.body.instructions === "string") {
      asset.instructions = req.body.instructions.slice(0, 5000);
    }
    if (typeof req.body.task_public === "boolean") {
      asset.task_public = req.body.task_public;
    }
    if (req.body.assigned_to !== undefined) {
      if (req.body.assigned_to === null || req.body.assigned_to === "") {
        delete asset.assigned_to;
      } else if (typeof req.body.assigned_to === "string") {
        asset.assigned_to = req.body.assigned_to.slice(0, 100);
      }
    }

    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  // POST /api/task/:station/clear — reset task to idle
  router.post("/api/task/:station/clear", stateLimiter, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.task);
    if (!asset) return res.status(404).json({ error: "Task station not found" });

    if (!asset.task_public && API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ error: "This task requires authentication" });
    }

    asset.content = { type: "task", data: JSON.stringify({ status: "idle", result: null }) };
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  return router;
}
