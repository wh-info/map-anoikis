// Cached 24h stats computed from the killstore every 60 seconds.
// The /stats endpoint serves this cached object — zero per-request cost.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const rawTypes = JSON.parse(readFileSync(resolve(__dirname, 'type-kinds.json'), 'utf-8'));
const TYPE_NAMES = new Map();
for (const [k, v] of Object.entries(rawTypes.names || {})) {
  TYPE_NAMES.set(Number(k), v);
}

const rawSystems = JSON.parse(readFileSync(resolve(__dirname, 'system-names.json'), 'utf-8'));
const SYSTEM_INFO = new Map();
for (const [k, v] of Object.entries(rawSystems)) {
  SYSTEM_INFO.set(Number(k), v);
}

const THERA_ID = 31000005;

let cached = null;

export function computeStats(killstore) {
  const DAY_S = 24 * 60 * 60;
  const cutoff = Math.floor(Date.now() / 1000) - DAY_S;

  let totalKills = 0;
  let totalIsk = 0;
  let npcKills = 0;
  let biggestValue = 0;
  let biggestTypeId = null;
  const systemCounts = new Map();

  for (const kill of killstore.values()) {
    if (kill.ts < cutoff) continue;
    totalKills++;
    totalIsk += kill.value || 0;
    if (kill.isNpc) npcKills++;
    if ((kill.value || 0) > biggestValue) {
      biggestValue = kill.value;
      biggestTypeId = kill.shipTypeId;
    }
    const c = systemCounts.get(kill.systemId) || 0;
    systemCounts.set(kill.systemId, c + 1);
  }

  // Most violent system (excluding Thera — it would dominate every day)
  let topSystemId = null;
  let topSystemKills = 0;
  for (const [sysId, count] of systemCounts) {
    if (sysId === THERA_ID) continue;
    if (count > topSystemKills) {
      topSystemKills = count;
      topSystemId = sysId;
    }
  }

  const topSys = topSystemId ? SYSTEM_INFO.get(topSystemId) : null;

  cached = {
    mostViolent: topSys
      ? { name: topSys.name, class: topSys.class, kills: topSystemKills }
      : null,
    iskDestroyed: totalIsk,
    biggestLoss: biggestTypeId
      ? { shipName: TYPE_NAMES.get(biggestTypeId) || `#${biggestTypeId}`, value: biggestValue }
      : null,
    npcPercent: totalKills > 0 ? Math.round((npcKills / totalKills) * 100) : 0,
    totalKills,
    computedAt: Date.now(),
  };

  return cached;
}

export function getStats() {
  return cached;
}
