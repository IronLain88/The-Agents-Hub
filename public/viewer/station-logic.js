// Shared station-routing logic — pure ES module, zero DOM dependencies

export const TILE_SIZE = 16;
export const GRID_W = 24;
export const GRID_H = 32;

// --- Collision Detection ---

export function buildCollisionMap(propData) {
  const map = Array(GRID_H).fill(null).map(() => Array(GRID_W).fill(false));

  if (!propData) return map;

  // Asset collision
  for (const asset of propData.assets || []) {
    if (!asset.collision || !asset.position) continue;
    const w = asset.sprite?.width || 1;
    const h = asset.sprite?.height || 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = asset.position.x + dx;
        const y = asset.position.y + dy;
        if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) {
          map[y][x] = true;
        }
      }
    }
  }

  // Absolute collision (painted tiles)
  for (const tile of propData.collision || []) {
    if (tile.x >= 0 && tile.x < GRID_W && tile.y >= 0 && tile.y < GRID_H) {
      map[tile.y][tile.x] = "absolute"; // Mark as absolute collision
    }
  }

  return map;
}

// --- A* Pathfinding ---

function heuristic(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

export function findPath(collisionMap, startX, startY, targetX, targetY, allowTargetCollision = true, stationBounds = null) {
  // Clamp to grid
  startX = Math.floor(Math.max(0, Math.min(GRID_W - 1, startX)));
  startY = Math.floor(Math.max(0, Math.min(GRID_H - 1, startY)));
  targetX = Math.floor(Math.max(0, Math.min(GRID_W - 1, targetX)));
  targetY = Math.floor(Math.max(0, Math.min(GRID_H - 1, targetY)));

  // If target is blocked and we don't allow target collision, find nearest free tile
  if (!allowTargetCollision && collisionMap[targetY][targetX]) {
    const free = findNearestFreeTile(collisionMap, targetX, targetY);
    if (free) {
      targetX = free.x;
      targetY = free.y;
    } else {
      return null; // No free tiles at all
    }
  }

  // If start and target are the same, return empty path
  if (startX === targetX && startY === targetY) return [];

  const openSet = [{ x: startX, y: startY, g: 0, h: heuristic(startX, startY, targetX, targetY), f: 0, parent: null }];
  const closedSet = new Set();

  while (openSet.length > 0) {
    // Find node with lowest f score
    openSet.sort((a, b) => a.f - b.f);
    const current = openSet.shift();

    if (current.x === targetX && current.y === targetY) {
      // Reconstruct path
      const path = [];
      let node = current;
      while (node.parent) {
        path.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }
      return path;
    }

    closedSet.add(`${current.x},${current.y}`);

    // Check neighbors
    const neighbors = [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ];

    for (const neighbor of neighbors) {
      if (neighbor.x < 0 || neighbor.x >= GRID_W || neighbor.y < 0 || neighbor.y >= GRID_H) continue;
      if (closedSet.has(`${neighbor.x},${neighbor.y}`)) continue;

      const collision = collisionMap[neighbor.y][neighbor.x];

      // Absolute collision blocks everything - no exceptions
      if (collision === "absolute") continue;

      // Check if neighbor is within station bounds (ignore regular collision for station furniture)
      const inStationBounds = stationBounds &&
        neighbor.x >= stationBounds.x &&
        neighbor.x < stationBounds.x + stationBounds.w &&
        neighbor.y >= stationBounds.y &&
        neighbor.y < stationBounds.y + stationBounds.h;

      // Allow reaching target or any tile within station bounds, even if it has regular collision
      const isTarget = neighbor.x === targetX && neighbor.y === targetY;
      if (!isTarget && !inStationBounds && collision) continue;

      const g = current.g + 1;
      const h = heuristic(neighbor.x, neighbor.y, targetX, targetY);
      const f = g + h;

      const existing = openSet.find(n => n.x === neighbor.x && n.y === neighbor.y);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = f;
          existing.parent = current;
        }
      } else {
        openSet.push({ x: neighbor.x, y: neighbor.y, g, h, f, parent: current });
      }
    }
  }

  return null; // No path found
}

// Simplify path by removing unnecessary waypoints in straight lines
export function simplifyPath(path) {
  if (path.length <= 2) return path;

  const simplified = [path[0]];

  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];

    // Check if current point is on a straight line between prev and next
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    // If direction changed, keep the waypoint
    if (dx1 !== dx2 || dy1 !== dy2) {
      simplified.push(curr);
    }
  }

  simplified.push(path[path.length - 1]);
  return simplified;
}

function findNearestFreeTile(collisionMap, tx, ty) {
  for (let radius = 1; radius < Math.max(GRID_W, GRID_H); radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H && !collisionMap[y][x]) {
          return { x, y };
        }
      }
    }
  }
  return null;
}

// Derive facing direction from approach: agent faces TOWARD the asset
export function getFacingFromApproach(approach) {
  switch (approach) {
    case "above": return "down";
    case "below": return "up";
    case "left":  return "left";
    case "right": return "right";
    default:      return "down";
  }
}

// Get the pixel position for an agent approaching a station
export function getApproachPixels(station, propX, propY) {
  const w = station.w || 1, h = station.h || 1;
  let ax, ay;
  switch (station.approach) {
    case "above":
      ax = station.x + Math.floor(w / 2);
      ay = station.y - 1;
      break;
    case "left":
      ax = station.x - 1;
      ay = station.y + Math.floor(h / 2);
      break;
    case "right":
      ax = station.x + w;
      ay = station.y + Math.floor(h / 2);
      break;
    case "on":
      ax = station.x + Math.floor(w / 2);
      ay = station.y + Math.floor(h / 2);
      break;
    default: // "below"
      ax = station.x + Math.floor(w / 2);
      ay = station.y + h;
      break;
  }
  return {
    x: propX + (ax + 0.5) * TILE_SIZE,
    y: propY + (ay + 0.5) * TILE_SIZE,
  };
}

// Determine approach direction for a position relative to an asset
export function getApproachDirectionFor(pos, w, h) {
  if (pos.y < 0) return "above";
  if (pos.y >= h) return "below";
  if (pos.x < 0) return "left";
  if (pos.x >= w) return "right";
  return "on";
}

// Collect all stations from a property data object (v1 + v2 formats)
export function collectStations(propData) {
  if (!propData) return [];
  const stations = propData.stations || [];
  const assetStations = (propData.assets || [])
    .filter(a => a.station && a.position)
    .map(a => ({
      x: a.position.x,
      y: a.position.y,
      state: a.station,
      approach: a.approach || "below",
      w: a.sprite?.width || 1,
      h: a.sprite?.height || 1,
      pose: a.pose,
      facing: a.facing,
      approaches: a.approaches,
    }));
  return [...stations, ...assetStations];
}

// Core station routing: find a station for an agent and return target position
// Returns { x, y, facing, pose } or null if no matching station
export function resolveStation(agentId, state, allStations, occupants, behavior, propOrigin) {
  // Clear this agent from all occupancy sets
  for (const [, occ] of occupants) occ.delete(agentId);

  const matching = allStations.filter(s => s.state === state);
  if (!matching.length) return null;

  let station, slotIndex = 0;

  // Try to find a station with a free slot
  for (const s of matching) {
    const key = `${s.x},${s.y}`;
    const occ = occupants.get(key);
    const occupantCount = occ ? occ.size : 0;
    const slotCount = s.approaches ? s.approaches.length : 1;
    if (occupantCount < slotCount) {
      station = s;
      slotIndex = occupantCount;
      break;
    }
  }
  // Fall back to first matching station if all full
  if (!station) {
    station = matching[0];
    const key = `${station.x},${station.y}`;
    const occ = occupants.get(key);
    slotIndex = occ ? occ.size : 0;
  }

  // Track occupancy by station position
  const key = `${station.x},${station.y}`;
  if (!occupants.has(key)) occupants.set(key, new Set());
  occupants.get(key).add(agentId);

  // Multi-approach: pick position and derive facing per slot
  let pos, slotApproach;
  if (station.approaches && station.approaches.length > 0) {
    const slot = station.approaches[slotIndex % station.approaches.length];
    pos = {
      x: propOrigin.x + (station.x + slot.x + 0.5) * TILE_SIZE,
      y: propOrigin.y + (station.y + slot.y + 0.5) * TILE_SIZE,
    };
    slotApproach = slot.dir || station.approach;
  } else {
    pos = getApproachPixels(station, propOrigin.x, propOrigin.y);
    slotApproach = station.approach;
  }

  // Priority: per-asset > furniture behavior > derived default
  const facing = station.facing || behavior?.facing || getFacingFromApproach(slotApproach);
  const pose = station.pose || behavior?.pose || "idle";

  // Include station bounds so pathfinding can ignore collision for this furniture
  const stationBounds = {
    x: station.x,
    y: station.y,
    w: station.w || 1,
    h: station.h || 1
  };

  return { ...pos, facing, pose, stationBounds };
}
