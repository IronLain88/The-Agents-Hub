import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as schemas from "../lib/validation.js";

export default function receptionRoutes(ctx) {
  const router = Router();
  const { requireAuth, stateLimiter, getProperty, broadcast, savePropertyToDisk } = ctx;

  const receptionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: "Too many questions, please try again later" },
  });

  // POST /api/reception/:station/ask — visitor asks a question
  router.post("/api/reception/:station/ask", receptionLimiter, (req, res) => {
    const validation = schemas.receptionAskSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.reception);
    if (!asset) return res.status(404).json({ error: "Reception station not found" });

    let state = { status: "idle", question: null, answer: null };
    try {
      if (asset.content?.data) state = JSON.parse(asset.content.data);
    } catch {}

    if (state.status !== "idle") {
      return res.status(409).json({ error: "Reception is busy — please wait" });
    }

    state.status = "pending";
    state.question = validation.data.question;
    state.answer = null;
    state.askedAt = new Date().toISOString();
    asset.content = { type: "reception", data: JSON.stringify(state) };

    const signalPayload = { question: state.question };
    if (asset.instructions) signalPayload.instructions = asset.instructions;
    broadcast({ type: "signal", station, trigger: "manual", timestamp: Date.now(), payload: signalPayload });
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  // POST /api/reception/:station/answer — agent posts an answer
  router.post("/api/reception/:station/answer", requireAuth, stateLimiter, (req, res) => {
    const validation = schemas.receptionAnswerSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: validation.error.issues[0].message });
    }
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.reception);
    if (!asset) return res.status(404).json({ error: "Reception station not found" });

    let state = { status: "idle", question: null, answer: null };
    try {
      if (asset.content?.data) state = JSON.parse(asset.content.data);
    } catch {}

    if (state.status !== "pending") {
      return res.status(409).json({ error: "No pending question" });
    }

    state.status = "answered";
    state.answer = validation.data.answer;
    state.answeredAt = new Date().toISOString();
    asset.content = { type: "reception", data: JSON.stringify(state) };

    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  // POST /api/reception/:station/clear — reset reception to idle
  router.post("/api/reception/:station/clear", requireAuth, stateLimiter, (req, res) => {
    const station = req.params.station;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.reception);
    if (!asset) return res.status(404).json({ error: "Reception station not found" });

    asset.content = { type: "reception", data: JSON.stringify({ status: "idle", question: null, answer: null }) };
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));
    res.json({ ok: true });
  });

  return router;
}
