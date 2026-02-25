/**
 * Property validation and migration utilities
 * Pure functions for testing
 */

const DEFAULT_WIDTH = 24;
const DEFAULT_HEIGHT = 32;

/**
 * Migrates a v1 property format to v2
 * @param {object} v1 - v1 property object
 * @returns {object} v2 property object
 */
export function migratePropertyV1toV2(v1) {
  const assets = [];
  const usedPositions = new Set();

  for (const station of v1.stations || []) {
    const w = station.w || 1;
    const h = station.h || 1;
    let sprite = { tileset: "interiors", tx: 0, ty: 0, width: w, height: h };
    for (const obj of v1.objects || []) {
      if (obj.x >= station.x && obj.x < station.x + w &&
          obj.y >= station.y && obj.y < station.y + h) {
        const dx = obj.x - station.x;
        const dy = obj.y - station.y;
        sprite = { tileset: obj.src, tx: obj.ax - dx, ty: obj.ay - dy, width: w, height: h };
        break;
      }
    }
    assets.push({
      id: `station-${station.x}-${station.y}`,
      sprite,
      position: { x: station.x, y: station.y },
      station: station.state,
      approach: station.approach || "below",
      collision: true,
    });
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        usedPositions.add(`${station.x + dx},${station.y + dy}`);
      }
    }
  }

  for (const anim of v1.animated || []) {
    const key = `${anim.x},${anim.y}`;
    if (usedPositions.has(key)) continue;
    assets.push({
      id: `animated-${anim.x}-${anim.y}`,
      sprite: { file: anim.file, width: anim.w || 1 },
      position: { x: anim.x, y: anim.y },
      collision: false,
    });
    usedPositions.add(key);
  }

  for (const obj of v1.objects || []) {
    const key = `${obj.x},${obj.y}`;
    if (usedPositions.has(key)) continue;
    assets.push({
      id: `object-${obj.x}-${obj.y}`,
      sprite: { tileset: obj.src, tx: obj.ax, ty: obj.ay },
      position: { x: obj.x, y: obj.y },
      collision: false,
    });
    usedPositions.add(key);
  }

  return {
    version: 2,
    width: v1.width || DEFAULT_WIDTH,
    height: v1.height || DEFAULT_HEIGHT,
    floor: v1.ground || [],
    assets,
    residents: v1.residents,
  };
}

/**
 * Ensures property is in v2 format, migrating if needed
 * @param {object} property - Property object to validate
 * @returns {object|null} v2 property or null if invalid
 */
export function ensureV2(property) {
  if (!property || typeof property !== "object") return null;

  // If it's v1 format, migrate it
  if (property.ground !== undefined || property.objects !== undefined) {
    return migratePropertyV1toV2(property);
  }

  // Validate v2 format
  if (property.version !== 2) return null;
  if (typeof property.width !== "number") return null;
  if (typeof property.height !== "number") return null;
  if (!Array.isArray(property.assets)) return null;

  return property;
}

/**
 * Validates a v2 property has required fields
 * @param {object} property - Property to validate
 * @returns {boolean} true if valid
 */
export function isValidV2Property(property) {
  if (!property || typeof property !== "object") return false;
  if (property.version !== 2) return false;
  if (typeof property.width !== "number") return false;
  if (typeof property.height !== "number") return false;
  if (!Array.isArray(property.assets)) return false;
  return true;
}
