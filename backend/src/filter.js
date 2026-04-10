// Anoikis filter with typeID-kind awareness.
//
// In-scope when BOTH:
//   1. solar_system_id falls inside Anoikis (31000000 <= id < 32000000)
//   2. victim.ship_type_id resolves to one of our tracked kinds
//      (ship / structure / tower / fighter / deployable).
//
// The type-kinds table is baked at build time from the SDE — see
// build/build_types.py. Any typeID not in the table is silently dropped,
// which keeps the feed focused on the five categories we actually render.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawKinds = JSON.parse(readFileSync(resolve(__dirname, 'type-kinds.json'), 'utf-8'));

// Rebuild as a plain object keyed by number for fast lookup. JSON forces
// string keys on us; flipping them to numbers once at boot is cheaper than
// coercing on every kill.
const KIND_BY_TYPE_ID = new Map();
for (const [k, v] of Object.entries(rawKinds.kinds)) {
  KIND_BY_TYPE_ID.set(Number(k), v);
}

export const ANOIKIS_MIN = 31000000;
export const ANOIKIS_MAX = 32000000;

export function kindForType(typeId) {
  return KIND_BY_TYPE_ID.get(typeId) || null;
}

export function classifyKill(msg) {
  const esi = msg?.esi;
  if (!esi) return null;
  const systemId = esi.solar_system_id;
  if (typeof systemId !== 'number' || systemId < ANOIKIS_MIN || systemId >= ANOIKIS_MAX) {
    return null;
  }
  const shipTypeId = esi.victim?.ship_type_id;
  const kind = kindForType(shipTypeId);
  if (!kind) return null;
  return { systemId, shipTypeId, kind };
}
