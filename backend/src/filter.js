// Anoikis kill filter with ESI fallback for unknown typeIDs.
//
// A kill is in-scope when BOTH:
//   1. solar_system_id falls inside Anoikis (31000000 <= id < 32000000)
//   2. victim.ship_type_id resolves to one of our tracked kinds
//      (ship / structure / tower / deployable / fighter)
//
// Kind resolution order:
//   1. type-kinds.json (built from SDE at deploy time) — instant, covers ~600 types
//   2. ESI /universe/types/{id}/ — for types added after the last SDE build
//      Results are cached in memory for the lifetime of the worker.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawKinds = JSON.parse(readFileSync(resolve(__dirname, 'type-kinds.json'), 'utf-8'));

const KIND_BY_TYPE_ID = new Map();
for (const [k, v] of Object.entries(rawKinds.kinds)) {
  KIND_BY_TYPE_ID.set(Number(k), v);
}

// ESI category ID → kind label. Mirrors the same mapping used in build_types.py.
const KIND_BY_CATEGORY = new Map([
  [6,  'ship'],
  [65, 'structure'],
  [22, 'deployable'],
  [87, 'fighter'],
]);
// All of category 23 (POS infrastructure: Control Towers, batteries, silos,
// arrays, hangars) is treated as 'tower'.
const TOWER_CATEGORY = 23;

// In-memory cache for ESI-resolved types so each unknown is only fetched once.
const esiKindCache = new Map();

async function kindFromEsi(typeId) {
  if (esiKindCache.has(typeId)) return esiKindCache.get(typeId);
  try {
    const res = await fetch(`https://esi.evetech.net/latest/universe/types/${typeId}/`, {
      headers: { 'User-Agent': process.env.ZKILL_USER_AGENT || 'map-anoikis/0.1' }
    });
    if (!res.ok) { esiKindCache.set(typeId, null); return null; }
    const data = await res.json();
    const catId   = data.category_id;
    let kind = KIND_BY_CATEGORY.get(catId) || null;
    if (catId === TOWER_CATEGORY) kind = 'tower';
    esiKindCache.set(typeId, kind);
    return kind;
  } catch {
    esiKindCache.set(typeId, null);
    return null;
  }
}

export const ANOIKIS_MIN = 31000000;
export const ANOIKIS_MAX = 32000000;

export function kindForType(typeId) {
  return KIND_BY_TYPE_ID.get(typeId) || null;
}

export async function classifyKill(msg) {
  const esi = msg?.esi;
  if (!esi) return null;
  const systemId = esi.solar_system_id;
  if (typeof systemId !== 'number' || systemId < ANOIKIS_MIN || systemId >= ANOIKIS_MAX) {
    return null;
  }
  const shipTypeId = esi.victim?.ship_type_id;
  if (!shipTypeId) return null;

  let kind = kindForType(shipTypeId);
  if (!kind) kind = await kindFromEsi(shipTypeId);
  if (!kind) return null;

  return { systemId, shipTypeId, kind };
}
