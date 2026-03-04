import { Router } from "express";
import { createManualPayload, shouldAllowPayload } from "../lib/payload-merger.js";
import * as schemas from "../lib/validation.js";

export default function signalRoutes(ctx) {
  const router = Router();
  const { requireAuth, signalLimiter, getProperty, broadcast, savePropertyToDisk, ALLOW_SIGNAL_PAYLOADS } = ctx;

  // POST /api/signals/fire
  router.post("/api/signals/fire", requireAuth, signalLimiter, (req, res) => {
    const validation = schemas.signalFireSchema.safeParse(req.body);
    if (!validation.success) {
      const firstError = validation.error.issues[0];
      if (firstError) {
        const field = firstError.path.join('.');
        let message;
        if (firstError.code === 'invalid_type' && (firstError.received === 'undefined' || firstError.received === undefined)) {
          message = field.length > 0 ? `${field} is required` : 'Required field missing';
        } else {
          message = field.length > 0 ? `${field}: ${firstError.message}` : firstError.message;
        }
        return res.status(400).json({ error: message });
      }
      return res.status(400).json({ error: "Validation failed" });
    }

    const { station, payload } = req.body;
    const currentProperty = getProperty();
    const asset = currentProperty?.assets?.find(a => a.station === station && a.trigger);
    const message = { type: "signal", station, trigger: "manual", timestamp: Date.now() };

    const allowPayload = shouldAllowPayload(ALLOW_SIGNAL_PAYLOADS, asset);
    const mergedPayload = createManualPayload(asset, payload, allowPayload);
    if (mergedPayload !== undefined) {
      message.payload = mergedPayload;
    }

    broadcast(message);

    const payloadInfo = (payload !== undefined || asset?.trigger_payload !== undefined)
      ? (allowPayload ? " (with payload)" : " (payload blocked)")
      : "";
    console.log(`[hub] Signal manually fired: "${station}"${payloadInfo}`);
    res.json({ ok: true });
  });

  // POST /api/signals/set-interval
  router.post("/api/signals/set-interval", requireAuth, signalLimiter, (req, res) => {
    const validation = schemas.signalIntervalSchema.safeParse(req.body);
    if (!validation.success) {
      const firstError = validation.error.issues?.[0];
      if (firstError) {
        const field = firstError.path?.join('.');
        const message = field ? `${field} is required` : firstError.message;
        return res.status(400).json({ error: message });
      }
      return res.status(400).json({ error: "Validation failed" });
    }

    const { station, interval } = req.body;
    const currentProperty = getProperty();

    if (!currentProperty?.assets) {
      return res.status(404).json({ error: "no property loaded" });
    }

    const asset = currentProperty.assets.find(a => a.station === station && a.trigger);
    if (!asset) {
      return res.status(404).json({ error: `signal "${station}" not found` });
    }

    asset.trigger_interval = interval;
    broadcast({ type: "property_update", property: currentProperty });
    savePropertyToDisk().catch(e => console.error("[hub] Failed to save property:", e));

    console.log(`[hub] Signal "${station}" interval updated to ${interval}s`);
    res.json({ ok: true, station, interval });
  });

  return router;
}
