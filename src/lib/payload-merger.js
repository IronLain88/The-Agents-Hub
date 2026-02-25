/**
 * Signal payload merging utilities
 * Pure functions for testing
 */

/**
 * Creates payload for heartbeat/interval signals
 * Only includes the configured trigger_payload
 *
 * @param {object} asset - Signal asset configuration
 * @param {boolean} allowPayload - Whether payloads are enabled
 * @returns {any|undefined} Payload or undefined
 */
export function createHeartbeatPayload(asset, allowPayload) {
  if (!allowPayload) return undefined;
  if (asset?.trigger_payload === undefined) return undefined;
  return asset.trigger_payload;
}

/**
 * Creates payload for manual signals with dual payload system
 * Merges signal_payload (configured) and dynamic_payload (from API)
 *
 * @param {object} asset - Signal asset configuration
 * @param {any} dynamicPayload - Payload from API call
 * @param {boolean} allowPayload - Whether payloads are enabled
 * @returns {object|undefined} Merged payload or undefined
 */
export function createManualPayload(asset, dynamicPayload, allowPayload) {
  if (!allowPayload) return undefined;

  const hasSignalPayload = asset?.trigger_payload !== undefined;
  const hasDynamicPayload = dynamicPayload !== undefined;

  if (!hasSignalPayload && !hasDynamicPayload) return undefined;

  const payload = {};
  if (hasSignalPayload) {
    payload.signal_payload = asset.trigger_payload;
  }
  if (hasDynamicPayload) {
    payload.dynamic_payload = dynamicPayload;
  }

  return payload;
}

/**
 * Determines if payload should be allowed based on two-layer security
 * Layer 1: Hub-level ALLOW_SIGNAL_PAYLOADS
 * Layer 2: Per-signal allow_payload property
 *
 * @param {boolean} hubAllowsPayloads - Hub-level setting
 * @param {object} asset - Signal asset configuration
 * @returns {boolean} Whether payload is allowed
 */
export function shouldAllowPayload(hubAllowsPayloads, asset) {
  return hubAllowsPayloads === true && asset?.allow_payload === true;
}
