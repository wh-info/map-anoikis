// Hot-system detection — runs every 60s over the killstore and produces a
// list of systems that meet our "currently happening fight" rule.
//
// Detection rule (locked 2026-04-28):
//   1. ≥10 PvP kills in last 10 min (isNpc: false only)
//   2. AND ≥500M ISK destroyed in last 10 min
//   3. AND ≥2 ships lost on each of two distinct alliance/corp sides
//      (mutual loss with depth — both sides have to actually be bleeding)
//   4. AND last kill within last 10 min
//
// Always uses kill.ts (killmail_time) — never receivedAt. The detector
// asks "is this fight happening now in EVE?" not "did the backend just
// receive a notification?" Late-published kills don't trigger hot status.
//
// Output is sorted by lastKillTs descending (most-recent-active first).
// /active endpoint serves this from memory with zero per-request cost.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// System metadata for the response payload (J-code + class).
const rawSystems = JSON.parse(readFileSync(resolve(__dirname, 'system-names.json'), 'utf-8'));
const SYSTEM_INFO = new Map();
for (const [k, v] of Object.entries(rawSystems)) {
  SYSTEM_INFO.set(Number(k), v);
}

// Detection thresholds. Tunable via constant-edit + redeploy. We deliberately
// don't expose these as env vars — tuning happens rarely and a redeploy is
// cheap. If we end up tuning frequently we can revisit.
const WINDOW_MS         = 10 * 60 * 1000;   // sliding kill-cluster window
const RECENCY_MS        = 10 * 60 * 1000;   // last-kill-must-be-within
const MIN_KILLS         = 10;               // condition 1
const MIN_ISK           = 500_000_000;      // condition 2
const MIN_SIDE_LOSSES   = 2;                // condition 3 — losses per side
const TICK_MS           = 60_000;           // detector tick cadence

// Identify a "side" by alliance_id when present, else corp_id. Some pilots
// fly without alliance — corp is the next-best identity. Pre-prefix the
// corp branch so they don't collide with alliance IDs in the shared keyspace.
function sideKeyForVictim(victim) {
  if (!victim) return null;
  if (victim.alliance_id)    return 'a:' + victim.alliance_id;
  if (victim.corporation_id) return 'c:' + victim.corporation_id;
  return null;
}

// Apply the four-condition rule to a list of kills already filtered to
// last 10 min for the same system. Returns null if not hot, or a hot
// summary object if it qualifies.
function evaluateCluster(kills, nowSec) {
  if (kills.length < MIN_KILLS) return null;

  // Condition 4 — recency. Cluster's newest kill must be within RECENCY_MS.
  // Kills are pre-sorted by ts asc by the caller, so newest = kills[last].
  const lastKill = kills[kills.length - 1];
  if (nowSec - lastKill.ts > RECENCY_MS / 1000) return null;

  // Condition 2 — ISK total in window. Uses the _zkbValue / value field.
  let totalIsk = 0;
  for (const k of kills) totalIsk += k.value || k._zkbValue || 0;
  if (totalIsk < MIN_ISK) return null;

  // Condition 3 — mutual loss with depth. Tally losses per side; require
  // at least two distinct sides each with ≥MIN_SIDE_LOSSES losses.
  const lossesBySide = new Map();
  for (const k of kills) {
    const key = sideKeyForVictim(k.victim);
    if (!key) continue;
    lossesBySide.set(key, (lossesBySide.get(key) || 0) + 1);
  }
  let qualifyingSides = 0;
  for (const count of lossesBySide.values()) {
    if (count >= MIN_SIDE_LOSSES) qualifyingSides++;
  }
  if (qualifyingSides < 2) return null;

  // All four conditions pass. Build the summary used by the tooltip.
  const lastShipTypeId = lastKill.victim?.ship_type_id || lastKill.shipTypeId || null;
  return {
    killCount: kills.length,
    lastKillTs: lastKill.ts,
    totalIsk,
    lastKill: lastShipTypeId != null ? {
      shipTypeId: lastShipTypeId,
      isk: lastKill.value || lastKill._zkbValue || 0,
      ts: lastKill.ts,
    } : null,
  };
}

export function createActive({ killstore, log }) {
  let activeList = [];     // newest-first array of hot systems
  let lastTickAt = null;
  let timer = null;

  function tick() {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const cutoff = nowSec - WINDOW_MS / 1000;

      // Group kills in the window by systemId. We iterate all killstore
      // values (~80k currently) and bucket by system. Cheap — modern V8
      // chews through this in a few ms.
      const bySystem = new Map();
      for (const kill of killstore.values()) {
        if (kill.isNpc) continue;             // condition 1 filter
        if (kill.ts < cutoff) continue;       // outside the window
        let arr = bySystem.get(kill.systemId);
        if (!arr) { arr = []; bySystem.set(kill.systemId, arr); }
        arr.push(kill);
      }

      const out = [];
      for (const [systemId, kills] of bySystem) {
        // Sort each system's kills by ts asc so evaluateCluster can read
        // the newest kill from the end without re-sorting.
        kills.sort((a, b) => a.ts - b.ts);
        const summary = evaluateCluster(kills, nowSec);
        if (!summary) continue;
        const meta = SYSTEM_INFO.get(systemId) || {};
        out.push({
          systemId,
          name:  meta.name  || String(systemId),
          class: meta.class || '',
          ...summary,
        });
      }

      // Sort by lastKillTs descending — most-recently-active first.
      out.sort((a, b) => b.lastKillTs - a.lastKillTs);

      activeList = out;
      lastTickAt = Date.now();
    } catch (err) {
      log?.warn?.({ err: err.message }, 'active tick failed');
    }
  }

  function start() {
    if (timer) return;
    tick(); // run once immediately so the first request after boot has data
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getActive() {
    return {
      systems: activeList,
      generatedAt: lastTickAt,
    };
  }

  return { start, stop, getActive };
}
