import { Router } from "express";
import * as schemas from "../lib/validation.js";

export default function inboxRoutes(ctx) {
  const router = Router();
  const { requireAuth, stateLimiter, getProperty, broadcast, savePropertyToDisk, API_KEY, ENABLE_GET_INBOX } = ctx;

  function findInbox(name) {
    const station = name || "inbox";
    const currentProperty = getProperty();
    if (!currentProperty?.assets) return null;
    return currentProperty.assets.find(a => a.station === station && a.station.startsWith("inbox"));
  }

  // POST /api/inbox or /api/inbox/:name — append a message
  function handleInboxPost(req, res) {
    const validation = schemas.inboxMessageSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const asset = findInbox(req.params.name);
    if (!asset) {
      const target = req.params.name || "inbox";
      return res.status(404).json({ error: `No inbox "${target}" found — add an asset with station="${target}" to your property` });
    }

    let messages = [];
    try {
      if (asset.content?.data) messages = JSON.parse(asset.content.data);
      if (!Array.isArray(messages)) messages = [];
    } catch { messages = []; }

    const { from, text, mood } = validation.data;
    const id = Math.random().toString(36).slice(2, 8);
    messages.push({ id, from, text, timestamp: new Date().toISOString(), ...(mood && { mood }) });
    while (messages.length > 50) messages.shift();

    asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };
    const currentProperty = getProperty();
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    console.log(`[hub] Inbox "${asset.station}" message from "${from}" (${messages.length} total)`);
    res.json({ ok: true, count: messages.length });
  }
  // GET /api/hello?from=X&text=Y&key=Z — GET-based inbox delivery (for clients that can't POST)
  if (ENABLE_GET_INBOX) {
    router.get("/api/hello", stateLimiter, (req, res) => {
      const { from, text, key } = req.query;
      if (API_KEY && key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
      if (!from || !text) return res.status(400).json({ error: "from and text are required" });

      const asset = findInbox(undefined);
      if (!asset) return res.status(404).json({ error: 'No inbox found — add an asset with station="inbox" to your property' });

      let messages = [];
      try {
        if (asset.content?.data) messages = JSON.parse(asset.content.data);
        if (!Array.isArray(messages)) messages = [];
      } catch { messages = []; }

      const id = Math.random().toString(36).slice(2, 8);
      messages.push({ id, from, text, timestamp: new Date().toISOString() });
      while (messages.length > 50) messages.shift();

      asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };
      broadcast({ type: "property_update", property: getProperty() });
      savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
      console.log(`[hub] GET inbox message from "${from}" (${messages.length} total)`);
      res.json({ ok: true, message: "delivered" });
    });
  }

  router.post("/api/inbox", requireAuth, stateLimiter, handleInboxPost);
  router.post("/api/inbox/:name", requireAuth, stateLimiter, handleInboxPost);

  // DELETE /api/inbox or /api/inbox/:name — clear a named inbox
  function handleInboxDelete(req, res) {
    const asset = findInbox(req.params.name);
    if (!asset) {
      const target = req.params.name || "inbox";
      return res.status(404).json({ error: `No inbox "${target}" found — add an asset with station="${target}" to your property` });
    }

    asset.content = { type: "json", data: "[]", publishedAt: new Date().toISOString() };
    const currentProperty = getProperty();
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    console.log(`[hub] Inbox "${asset.station}" cleared`);
    res.json({ ok: true });
  }
  router.delete("/api/inbox", requireAuth, stateLimiter, handleInboxDelete);
  router.delete("/api/inbox/:name", requireAuth, stateLimiter, handleInboxDelete);

  // DELETE /api/inbox/:name/:id — delete a single message
  function handleInboxDeleteOne(req, res) {
    const asset = findInbox(req.params.name);
    if (!asset) return res.status(404).json({ error: `No inbox "${req.params.name}" found` });

    let messages = [];
    try {
      if (asset.content?.data) messages = JSON.parse(asset.content.data);
      if (!Array.isArray(messages)) messages = [];
    } catch { messages = []; }

    const before = messages.length;
    messages = messages.filter(m => m.id !== req.params.id);
    if (messages.length === before) return res.status(404).json({ error: "Message not found" });

    asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };
    const currentProperty = getProperty();
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true, remaining: messages.length });
  }
  router.delete("/api/inbox/:name/:id", requireAuth, stateLimiter, handleInboxDeleteOne);

  // POST /api/inbox/:name/:id/process — process to a task station (card travel)
  router.post("/api/inbox/:name/:id/process", requireAuth, stateLimiter, (req, res) => {
    const validation = schemas.processInboxSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: validation.error.issues[0].message });

    const asset = findInbox(req.params.name);
    if (!asset) return res.status(404).json({ error: `No inbox "${req.params.name}" found` });

    let messages = [];
    try {
      if (asset.content?.data) messages = JSON.parse(asset.content.data);
      if (!Array.isArray(messages)) messages = [];
    } catch { messages = []; }

    const msgIdx = messages.findIndex(m => m.id === req.params.id);
    if (msgIdx === -1) return res.status(404).json({ error: "Message not found" });

    const { target_station } = validation.data;
    const currentProperty = getProperty();
    const taskAsset = currentProperty?.assets?.find(a => a.station === target_station && a.task);
    if (!taskAsset) return res.status(404).json({ error: `Task station "${target_station}" not found` });

    let taskState = { status: "idle", result: null };
    try { if (taskAsset.content?.data) taskState = JSON.parse(taskAsset.content.data); } catch {}
    if (taskState.status !== "idle") return res.status(409).json({ error: "Task station is busy" });

    const msg = messages[msgIdx];
    const cardId = `card_${Math.random().toString(36).slice(2, 8)}`;

    messages.splice(msgIdx, 1);
    asset.content = { type: "json", data: JSON.stringify(messages), publishedAt: new Date().toISOString() };

    taskState.status = "pending";
    taskState.result = null;
    taskState.claimedBy = null;
    taskState.startedAt = new Date().toISOString();
    taskState.prompt = `Process inbox message from ${msg.from}: ${msg.text}`;
    taskState.card = { id: cardId, from: msg.from, text: msg.text, timestamp: msg.timestamp, source: "inbox" };
    taskAsset.content = { type: "task", data: JSON.stringify(taskState) };

    broadcast({ type: "signal", station: target_station, trigger: "manual", timestamp: Date.now(), payload: { station: target_station, instructions: taskAsset.instructions } });

    const fromPos = asset.position || { x: 0, y: 0 };
    const toPos = taskAsset.position || { x: 0, y: 0 };
    broadcast({ type: "card_travel", card_id: cardId, from_pos: fromPos, to_pos: toPos });

    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    console.log(`[hub] Inbox "${asset.station}" → task "${target_station}" (card ${cardId})`);
    res.json({ ok: true, card_id: cardId });
  });

  // POST /api/archive/:station — archive a completed card
  router.post("/api/archive/:station", requireAuth, stateLimiter, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const taskAsset = currentProperty?.assets?.find(a => a.station === station && a.task);
    if (!taskAsset) return res.status(404).json({ error: `Task station "${station}" not found` });

    let taskState = { status: "idle", result: null };
    try { if (taskAsset.content?.data) taskState = JSON.parse(taskAsset.content.data); } catch {}
    if (taskState.status !== "done" || !taskState.card) {
      return res.status(409).json({ error: "Task must be done with a card to archive" });
    }

    const archiveAsset = currentProperty?.assets?.find(a => a.archive);
    if (!archiveAsset) return res.status(404).json({ error: "No archive station found on property" });

    let archiveData = [];
    try {
      if (archiveAsset.content?.data) archiveData = JSON.parse(archiveAsset.content.data);
      if (!Array.isArray(archiveData)) archiveData = [];
    } catch { archiveData = []; }

    archiveData.unshift({
      ...taskState.card,
      result: taskState.result,
      completedAt: taskState.completedAt || new Date().toISOString(),
    });
    while (archiveData.length > 200) archiveData.pop();
    archiveAsset.content = { type: "json", data: JSON.stringify(archiveData), publishedAt: new Date().toISOString() };

    taskAsset.content = { type: "task", data: JSON.stringify({ status: "idle", result: null }) };

    const fromPos = taskAsset.position || { x: 0, y: 0 };
    const toPos = archiveAsset.position || { x: 0, y: 0 };
    broadcast({ type: "card_travel", card_id: taskState.card.id, from_pos: fromPos, to_pos: toPos });

    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    console.log(`[hub] Archived card from "${station}" to archive`);
    res.json({ ok: true });
  });

  // DELETE /api/archive/:index — delete a single archived card by index
  router.delete("/api/archive/:index", requireAuth, stateLimiter, (req, res) => {
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ error: "Invalid index" });

    const currentProperty = getProperty();
    const archiveAsset = currentProperty?.assets?.find(a => a.archive);
    if (!archiveAsset) return res.status(404).json({ error: "No archive station found" });

    let archiveData = [];
    try {
      if (archiveAsset.content?.data) archiveData = JSON.parse(archiveAsset.content.data);
      if (!Array.isArray(archiveData)) archiveData = [];
    } catch { archiveData = []; }

    if (idx >= archiveData.length) return res.status(404).json({ error: "Card not found" });

    archiveData.splice(idx, 1);
    archiveAsset.content = { type: "json", data: JSON.stringify(archiveData), publishedAt: new Date().toISOString() };
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true, remaining: archiveData.length });
  });

  return router;
}
