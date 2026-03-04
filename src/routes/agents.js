import { Router } from "express";
import { formatBreadcrumb, applyBreadcrumb, applyNote } from "../lib/station-log.js";
import * as schemas from "../lib/validation.js";

export default function agentRoutes(ctx) {
  const router = Router();
  const { requireAuth, stateLimiter, agents, activityLog, MAX_LOG_ENTRIES, agentPreviousState, getProperty, broadcast, savePropertyToDisk, assignCharacter, buildWelcome } = ctx;

  // POST /api/state — agent reports its state
  router.post("/api/state", requireAuth, stateLimiter, (req, res) => {
    const validation = schemas.agentStateSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const { agent_id, agent_name, state, detail, group, sprite, owner_id, owner_name, parent_agent_id, note } = validation.data;

    const entry = {
      agent_id,
      agent_name: agent_name || "Agent",
      state,
      detail: detail || "",
      group: group || "idle",
      sprite: sprite || assignCharacter(agent_id),
      owner_id: owner_id || "default-owner",
      owner_name: owner_name || "Owner",
      parent_agent_id: parent_agent_id || null,
      last_seen: Date.now(),
    };

    // Dedup stale agents with same name+owner
    if (!parent_agent_id) {
      const STALE_MS = 150_000;
      for (const [existingId, existing] of agents) {
        if (existingId !== agent_id
          && existing.agent_name === entry.agent_name
          && existing.owner_id === entry.owner_id
          && !existing.parent_agent_id
          && (Date.now() - existing.last_seen) > STALE_MS) {
          agents.delete(existingId);
          broadcast({ type: "agent_removed", agent_id: existingId });
        }
      }
    }

    const isNewAgent = !agents.has(agent_id);
    agents.set(agent_id, entry);

    // Station logging
    const currentProperty = getProperty();
    if (currentProperty?.assets) {
      const prev = agentPreviousState.get(agent_id);

      if (prev && prev.state !== state && note && prev.stationId) {
        const prevAsset = currentProperty.assets.find(a => a.id === prev.stationId);
        if (prevAsset) {
          prevAsset.log = applyNote(prevAsset.log || "", note);
        }
      }

      const currentStation = currentProperty.assets.find(a => a.station === state);
      if (currentStation && detail) {
        currentStation.log = applyBreadcrumb(currentStation.log || "", formatBreadcrumb(detail));
      }

      agentPreviousState.set(agent_id, { state, stationId: currentStation?.id || null });

      if ((prev?.stationId && note && prev.state !== state) || (currentStation && detail)) {
        broadcast({ type: "property_update", property: currentProperty });
        savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
      }
    }

    // Log speech bubbles
    if (detail && detail.trim()) {
      activityLog.push({ timestamp: Date.now(), agent_name: entry.agent_name, detail: detail.trim(), state });
      if (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();
    }

    broadcast({
      type: "agent_update",
      agent_id,
      agent_name: entry.agent_name,
      state,
      detail: entry.detail,
      group: entry.group,
      sprite: entry.sprite,
      owner_id: entry.owner_id,
      owner_name: entry.owner_name,
      parent_agent_id: entry.parent_agent_id,
    });

    if (isNewAgent) {
      return res.json({ ok: true, welcome: buildWelcome() });
    }
    res.json({ ok: true });
  });

  // GET /api/agents — debug endpoint
  router.get("/api/agents", (_req, res) => {
    res.json(Object.fromEntries(agents));
  });

  // GET /api/activity-log
  router.get("/api/activity-log", (_req, res) => {
    res.json(activityLog);
  });

  // GET /api/status — compact status overview
  router.get("/api/status", (_req, res) => {
    const currentProperty = getProperty();
    const agentList = [];
    const occupiedStations = new Set();
    for (const [, entry] of agents) {
      const isIdle = entry.state === "idle";
      const a = { name: entry.agent_name, state: entry.state, detail: entry.detail || "", idle: isIdle };
      if (entry.parent_agent_id) a.sub = true;
      agentList.push(a);
      if (!isIdle) occupiedStations.add(entry.state);
    }

    let inboxCount = 0;
    let inboxLatest = null;
    for (const asset of currentProperty?.assets || []) {
      if (asset.station?.startsWith("inbox") && asset.content?.data) {
        try {
          const msgs = JSON.parse(asset.content.data);
          if (Array.isArray(msgs)) inboxCount += msgs.length;
        } catch {}
        if (asset.content.publishedAt && (!inboxLatest || asset.content.publishedAt > inboxLatest)) {
          inboxLatest = asset.content.publishedAt;
        }
      }
    }

    const recent = activityLog.slice(-5).reverse().map(e => ({
      agent: e.agent_name, state: e.state, detail: e.detail, t: e.timestamp,
    }));

    res.json({
      agents: agentList,
      inbox: { count: inboxCount, latest: inboxLatest },
      activity: recent,
      stations: [...occupiedStations],
    });
  });

  // DELETE /api/agents/:id — remove a single agent
  router.delete("/api/agents/:id", requireAuth, (req, res) => {
    const id = req.params.id;
    if (!agents.has(id)) return res.status(404).json({ error: "Agent not found" });
    agents.delete(id);
    broadcast({ type: "agent_removed", agent_id: id });
    res.json({ ok: true });
  });

  // DELETE /api/agents — clear all agents
  router.delete("/api/agents", requireAuth, (req, res) => {
    const count = agents.size;
    for (const [id] of agents) {
      broadcast({ type: "agent_removed", agent_id: id });
    }
    agents.clear();
    console.log(`[hub] Cleared ${count} agents`);
    res.json({ ok: true, cleared: count });
  });

  return router;
}
