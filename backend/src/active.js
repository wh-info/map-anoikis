// Hot-system detection — runs every 60s over the killstore and produces a
// list of systems that meet our "currently happening fight" rule, plus a
// "recently active" linger list for systems that just cooled down.
//
// Detection rule (v2, unchanged in v3):
//   1. ≥10 PvP kills in last 15 min (isNpc: false only)
//   2. AND ≥300M ISK destroyed in last 15 min
//   3. AND ≥2 ships lost on each of two distinct alliance/corp sides
//      (mutual loss with depth — both sides have to actually be bleeding)
//   4. AND last kill within last 20 min
//
// v3 additions (2026-04-29):
//   - Cluster fields per hot system (clusterStartTs, clusterKillCount,
//     clusterTotalIsk, biggestKill). Cluster boundary = walk this system's
//     kills newest-first and stop at the first >15-min gap. Display-only;
//     the detection rule still uses the 15-min sliding window.
//   - Per-system state machine (active | cooling). When a system stops
//     qualifying, it stays in the response for LINGER_MS (30 min) with
//     state:'cooling' and a frozen summary. Re-qualifying mid-linger
//     preserves clusterStartTs so the same fight continues.
//   - frozenTier captured at cool-start. Frontend descends through tiers
//     during cooldown starting from this snapshot, immune to mid-cooldown
//     cluster math quirks.
//
// Always uses kill.ts (killmail_time) — never receivedAt. The detector
// asks "is this fight happening now in EVE?" not "did the backend just
// receive a notification?" Late-published kills don't trigger hot status.
//
// Output is sorted: active systems by lastKillTs desc, cooling systems
// by cooledAt desc and capped at LINGER_LIST_CAP. /active endpoint serves
// the merged list from memory with zero per-request cost.

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
const WINDOW_MS         = 15 * 60 * 1000;   // sliding kill-cluster window
const RECENCY_MS        = 20 * 60 * 1000;   // last-kill-must-be-within
const MIN_KILLS         = 10;               // condition 1
const MIN_ISK           = 300_000_000;      // condition 2
const MIN_SIDE_LOSSES   = 2;                // condition 3 — losses per side
const TICK_MS           = 60_000;           // detector tick cadence

// v3 — linger + cluster constants.
const LINGER_MS         = 30 * 60 * 1000;   // cooled systems stay this long
const LINGER_LIST_CAP   = 5;                // max "recently active" rows
const CLUSTER_GAP_MS    = WINDOW_MS;        // walk-back gap = same as window

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
// last 15 min for the same system. Returns null if not hot, or a hot
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

// Pick the tier name from a hot summary's score. Used to freeze the tier at
// cool-start. Frontend reads this string and descends through cooler tiers
// during the linger window. Score = killCount × (totalIsk / 1B).
// Tier breakpoints (yellow < 15, ember < 200, red ≥ 200) live in the frontend;
// the backend just returns the tier name to keep the source-of-truth split
// avoidable. We still need to compute it here once at cool-start — duplicating
// the breakpoints here is the simplest stable contract.
const TIER_T2 = 15;
const TIER_T3 = 200;
function tierForScore(killCount, totalIsk) {
  const score = killCount * ((totalIsk || 0) / 1_000_000_000);
  if (score >= TIER_T3) return 'tier3';
  if (score >= TIER_T2) return 'tier2';
  return 'tier1';
}

// Walk this system's killstore entries newest-first, find the cluster
// boundary (first >15-min gap working backward), and compute cluster fields
// (start ts, kill count, total ISK, biggest kill). Excludes NPC kills to
// match the detection rule's PvP-only premise.
//
// Note: the killstore returns kills newest-first already. We iterate from
// newest, accept each kill into the cluster, and stop when the gap to the
// next-older kill exceeds CLUSTER_GAP_MS.
function computeCluster(systemId, killstore) {
  const kills = killstore.getBySystem(systemId); // newest-first
  if (!kills || kills.length === 0) {
    return { clusterStartTs: null, clusterKillCount: 0, clusterTotalIsk: 0, biggestKill: null };
  }

  const cluster = [];
  let prevTs = null;
  for (const k of kills) {
    if (k.isNpc) continue;
    if (prevTs !== null && (prevTs - k.ts) * 1000 > CLUSTER_GAP_MS) break;
    cluster.push(k);
    prevTs = k.ts;
  }

  if (cluster.length === 0) {
    return { clusterStartTs: null, clusterKillCount: 0, clusterTotalIsk: 0, biggestKill: null };
  }

  // cluster is newest-first; oldest at the end.
  const oldest = cluster[cluster.length - 1];
  let totalIsk = 0;
  let biggest = null;
  for (const k of cluster) {
    const v = k.value || k._zkbValue || 0;
    totalIsk += v;
    // Tie-break on most-recent ts (cluster is newest-first, so first-seen
    // tie wins — cluster[0] beats cluster[N] when isk equal).
    if (!biggest || v > biggest.isk) {
      const shipTypeId = k.victim?.ship_type_id || k.shipTypeId || null;
      if (shipTypeId != null) {
        biggest = { shipTypeId, isk: v, ts: k.ts };
      }
    }
  }

  return {
    clusterStartTs: oldest.ts,
    clusterKillCount: cluster.length,
    clusterTotalIsk: totalIsk,
    biggestKill: biggest,
  };
}

export function createActive({ killstore, log }) {
  // systemId → {
  //   state: 'active' | 'cooling',
  //   cooledAt: <sec> | null,        // ts when state flipped active→cooling
  //   clusterStartTs: <sec>,          // preserved across cool→re-qualify
  //   frozenTier: 'tier1'|'tier2'|'tier3'|null,  // snapped at cool-start
  //   summary: { ...latest evaluateCluster result + cluster fields }
  // }
  const systemState = new Map();

  let activeList = [];     // built once per tick — { active[], cooling[] } merged
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

      // Pass 1 — evaluate each currently-active candidate against v2 rule.
      // Track the systems that qualified this tick so we can flip the rest
      // of systemState's 'active' entries to 'cooling' below.
      const qualifiedThisTick = new Set();
      for (const [systemId, kills] of bySystem) {
        kills.sort((a, b) => a.ts - b.ts); // ts asc for evaluateCluster
        const summary = evaluateCluster(kills, nowSec);
        if (!summary) continue;
        qualifiedThisTick.add(systemId);

        const cluster = computeCluster(systemId, killstore);
        const meta = SYSTEM_INFO.get(systemId) || {};

        const prev = systemState.get(systemId);
        const wasNew = !prev;
        const wasCooling = prev?.state === 'cooling';

        // Preserve clusterStartTs across cool→re-qualify. If prev had a
        // clusterStartTs and the cluster boundary walker confirms it's
        // still inside the current cluster (newer than the cluster's
        // computed oldest ts), keep it. Otherwise the cluster has genuinely
        // restarted (>15min gap) and we use the fresh boundary.
        let clusterStartTs = cluster.clusterStartTs;
        if (prev?.clusterStartTs && cluster.clusterStartTs != null
            && prev.clusterStartTs <= cluster.clusterStartTs) {
          // prev's anchor is older or equal → cluster never broke. Preserve.
          clusterStartTs = prev.clusterStartTs;
        }

        const next = {
          state: 'active',
          cooledAt: null,
          clusterStartTs,
          frozenTier: null,  // only set when state flips to cooling
          summary: {
            ...summary,
            clusterStartTs,
            clusterKillCount: cluster.clusterKillCount,
            clusterTotalIsk: cluster.clusterTotalIsk,
            biggestKill: cluster.biggestKill,
            name:  meta.name  || String(systemId),
            class: meta.class || '',
          },
        };
        systemState.set(systemId, next);

        if (wasNew) {
          log?.info?.({ systemId, name: next.summary.name, killCount: summary.killCount,
            clusterKillCount: cluster.clusterKillCount,
            tier: tierForScore(cluster.clusterKillCount, cluster.clusterTotalIsk) },
            'active: new hot system');
        } else if (wasCooling) {
          log?.info?.({ systemId, name: next.summary.name,
            clusterStartTs, preservedAnchor: prev.clusterStartTs === clusterStartTs },
            'active: re-qualified mid-cool');
        }
      }

      // Pass 2 — sweep stale 'active' entries. Anything in systemState that
      // didn't qualify this tick flips to 'cooling'. Anything already cooling
      // past LINGER_MS is dropped entirely.
      const lingerCutoffSec = nowSec - LINGER_MS / 1000;
      for (const [systemId, st] of systemState) {
        if (st.state === 'active' && !qualifiedThisTick.has(systemId)) {
          // Flip to cooling. Freeze the tier from the last-known summary.
          const tier = tierForScore(
            st.summary.clusterKillCount || st.summary.killCount,
            st.summary.clusterTotalIsk  || st.summary.totalIsk
          );
          st.state = 'cooling';
          st.cooledAt = nowSec;
          st.frozenTier = tier;
          log?.info?.({ systemId, name: st.summary.name, frozenTier: tier,
            clusterKillCount: st.summary.clusterKillCount },
            'active: cooling');
        } else if (st.state === 'cooling' && st.cooledAt < lingerCutoffSec) {
          systemState.delete(systemId);
          log?.info?.({ systemId, name: st.summary.name }, 'active: linger expired, removed');
        }
      }

      // Pass 3 — build response. Active by lastKillTs desc; cooling by
      // cooledAt desc, capped at LINGER_LIST_CAP. Single merged list with
      // each entry carrying its `state` field for the frontend to switch on.
      const active = [];
      const cooling = [];
      for (const [systemId, st] of systemState) {
        const entry = {
          systemId,
          name:  st.summary.name,
          class: st.summary.class,
          // existing v2 fields (frontend backwards-compat)
          killCount: st.summary.killCount,
          lastKillTs: st.summary.lastKillTs,
          totalIsk:  st.summary.totalIsk,
          lastKill:  st.summary.lastKill,
          // v3 cluster fields
          clusterStartTs:   st.summary.clusterStartTs,
          clusterKillCount: st.summary.clusterKillCount,
          clusterTotalIsk:  st.summary.clusterTotalIsk,
          biggestKill:      st.summary.biggestKill,
          // v3 state fields
          state:       st.state,
          cooledAt:    st.cooledAt,
          frozenTier:  st.frozenTier,
        };
        if (st.state === 'active') active.push(entry);
        else cooling.push(entry);
      }
      active.sort((a, b) => b.lastKillTs - a.lastKillTs);
      cooling.sort((a, b) => b.cooledAt - a.cooledAt);
      if (cooling.length > LINGER_LIST_CAP) cooling.length = LINGER_LIST_CAP;

      activeList = [...active, ...cooling];
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
