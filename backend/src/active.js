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
const MIN_KILLS         = 10;               // condition 1 (initial detection)
const MIN_ISK           = 500_000_000;      // condition 2 (initial detection)
const MIN_SIDE_LOSSES   = 2;                // condition 3 — losses per side
const TICK_MS           = 60_000;           // detector tick cadence

// Relaxed thresholds for systems that are already hot (active or cooling).
// "Sticky" relaxed rule: once a system has qualified, the bar to STAY hot
// (or come back from cooling) is lower than the initial detection bar.
// This prevents ping-ponging on borderline activity and matches the v3
// narrative — the fight stays alive until truly dead.
const MIN_KILLS_REQUALIFY = 5;              // condition 1 (sticky/relaxed)
const MIN_ISK_REQUALIFY   = 300_000_000;    // condition 2 (sticky/relaxed)
// condition 3 (mutual loss with depth) is dropped when relaxed.

// v3 — linger + cluster constants.
const LINGER_MS         = 30 * 60 * 1000;   // cooled systems stay this long
const LINGER_LIST_CAP   = 5;                // max "recently active" rows
const CLUSTER_GAP_MS    = 20 * 60 * 1000;   // walk-back gap (decoupled from WINDOW_MS;
                                            // tolerates typical 15-22 min refit pauses)

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
//
// opts.relaxed = true uses the sticky/relaxed thresholds — kills 5/300M
// and the mutual-loss-with-depth check is dropped. Used for systems that
// are already in active or cooling state, so the bar to STAY hot (or come
// back from cooling) is lower than the initial detection bar. Prevents
// ping-ponging on borderline activity.
function evaluateCluster(kills, nowSec, opts = {}) {
  const minKills = opts.relaxed ? MIN_KILLS_REQUALIFY : MIN_KILLS;
  const minIsk   = opts.relaxed ? MIN_ISK_REQUALIFY   : MIN_ISK;
  const requireSides = !opts.relaxed;

  if (kills.length < minKills) return null;

  // Condition 4 — recency. Cluster's newest kill must be within RECENCY_MS.
  // Kills are pre-sorted by ts asc by the caller, so newest = kills[last].
  const lastKill = kills[kills.length - 1];
  if (nowSec - lastKill.ts > RECENCY_MS / 1000) return null;

  // Condition 2 — ISK total in window. Uses the _zkbValue / value field.
  let totalIsk = 0;
  for (const k of kills) totalIsk += k.value || k._zkbValue || 0;
  if (totalIsk < minIsk) return null;

  // Condition 3 — mutual loss with depth. Tally losses per side; require
  // at least two distinct sides each with ≥MIN_SIDE_LOSSES losses.
  // Skipped when relaxed (sticky rule) — captures fights winding down to
  // single-side dominance.
  if (requireSides) {
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
  }

  // All conditions pass. Build the summary used by the tooltip.
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

// Pick the tier name from a cluster's kills + ISK. Used to freeze the tier
// at cool-start. Frontend reads this string and descends through cooler
// tiers during the linger window.
//
// Option D rules (replaced score = killCount × ISK on 2026-05-01):
//   tier3 (red):    ≥30 kills AND ≥10B ISK   — major event / eviction
//   tier2 (ember):  ≥15 kills AND ≥3B ISK    — real fleet fight
//   tier1 (yellow): everything else qualifying — small fight
//
// Decoupled AND-conditions instead of multiplied score. Fixes the frigate-
// blob case where many cheap kills inflated score and reached ember
// undeservedly. Both dimensions must clear independently.
//
// Function name kept as tierForScore for git-diff readability — call sites
// still pass (killCount, totalIsk) and don't need to change.
const TIER_T2_KILLS = 15;
const TIER_T2_ISK   = 5_000_000_000;
const TIER_T3_KILLS = 30;
const TIER_T3_ISK   = 15_000_000_000;
function tierForScore(killCount, totalIsk) {
  if (killCount >= TIER_T3_KILLS && totalIsk >= TIER_T3_ISK) return 'tier3';
  if (killCount >= TIER_T2_KILLS && totalIsk >= TIER_T2_ISK) return 'tier2';
  return 'tier1';
}

// Walk this system's killstore entries newest-first, find the cluster
// boundary (first >CLUSTER_GAP_MS gap working backward), and compute cluster
// fields (start ts, kill count, total ISK, biggest kill). Excludes NPC kills
// to match the detection rule's PvP-only premise.
//
// floorTs (optional) — when provided (re-qualifying from cooling), the walker
// includes all kills back to floorTs and IGNORES gaps in between. This makes
// anchor + counts always agree across cooling re-qualifications, even when
// there was a real silence between fights.
//
// Note: the killstore returns kills newest-first already. We iterate from
// newest, accept each kill into the cluster, and stop when either:
//   - we hit a kill older than floorTs (when floor mode active), OR
//   - the gap to the next-older kill exceeds CLUSTER_GAP_MS (default mode).
function computeCluster(systemId, killstore, floorTs = null) {
  const kills = killstore.getBySystem(systemId); // newest-first
  if (!kills || kills.length === 0) {
    return { clusterStartTs: null, clusterKillCount: 0, clusterTotalIsk: 0,
             clusterPilotCount: 0, biggestKill: null };
  }

  const cluster = [];
  let prevTs = null;
  for (const k of kills) {
    if (k.isNpc) continue;
    if (k.kind === 'fighter') continue;
    if (floorTs != null) {
      // Floor mode (re-qualifying from cooling): include everything back to
      // floorTs, ignore gaps in between.
      if (k.ts < floorTs) break;
    } else if (prevTs !== null && (prevTs - k.ts) * 1000 > CLUSTER_GAP_MS) {
      // Default mode: stop at first >CLUSTER_GAP_MS gap.
      break;
    }
    cluster.push(k);
    prevTs = k.ts;
  }

  if (cluster.length === 0) {
    return { clusterStartTs: null, clusterKillCount: 0, clusterTotalIsk: 0,
             clusterPilotCount: 0, biggestKill: null };
  }

  // cluster is newest-first; oldest at the end.
  const oldest = cluster[cluster.length - 1];
  let totalIsk = 0;
  let biggest = null;
  // Unique character_ids across victims + attackers in the cluster. Reads as
  // "fleet engagement size" — 180 pilots = doctrine engagement, 18 = small
  // gang. NPC entries naturally drop out (no character_id on NPC ships /
  // structures), so PvE pollution is a non-issue. Same character on both
  // sides counted once. Multiple kills by the same character counted once.
  const pilots = new Set();
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
    if (k.victim?.character_id) pilots.add(k.victim.character_id);
    if (Array.isArray(k.attackers)) {
      for (const a of k.attackers) {
        if (a.character_id) pilots.add(a.character_id);
      }
    }
  }

  return {
    clusterStartTs: oldest.ts,
    clusterKillCount: cluster.length,
    clusterTotalIsk: totalIsk,
    clusterPilotCount: pilots.size,
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
        if (kill.kind === 'fighter') continue; // fighters never trigger hot
        if (kill.ts < cutoff) continue;       // outside the window
        let arr = bySystem.get(kill.systemId);
        if (!arr) { arr = []; bySystem.set(kill.systemId, arr); }
        arr.push(kill);
      }

      // Pass 1 — evaluate each currently-active candidate against the
      // detection rule. Track the systems that qualified this tick so we
      // can flip the rest of systemState's 'active' entries to 'cooling'
      // below.
      //
      // Sticky relaxed rule: if the system is already in active OR cooling
      // state (wasHot), use the relaxed thresholds — kills 5/300M and no
      // mutual-loss check. This prevents ping-ponging on borderline
      // activity and matches the v3 narrative ("fight stays alive until
      // truly dead"). Fresh detections (no prev state) use strict rule.
      const qualifiedThisTick = new Set();
      for (const [systemId, kills] of bySystem) {
        kills.sort((a, b) => a.ts - b.ts); // ts asc for evaluateCluster

        const prev = systemState.get(systemId);
        const wasNew = !prev;
        const wasCooling = prev?.state === 'cooling';
        const wasHot = prev?.state === 'active' || wasCooling;

        const summary = evaluateCluster(kills, nowSec, { relaxed: wasHot });
        if (!summary) continue;
        qualifiedThisTick.add(systemId);

        // Floor mode for the cluster walker: only when re-qualifying from
        // cooling, walk all the way back to prev anchor (ignore gaps).
        // Active→active continuations and fresh detections use the default
        // CLUSTER_GAP_MS gap behavior.
        const floorTs = wasCooling ? prev.clusterStartTs : null;
        const cluster = computeCluster(systemId, killstore, floorTs);
        const meta = SYSTEM_INFO.get(systemId) || {};

        // Always preserve clusterStartTs when the system was previously
        // hot. The floorTs param ensures the cluster walker has already
        // included everything back to prev.clusterStartTs, so anchor +
        // counts always agree.
        const clusterStartTs = wasHot && prev?.clusterStartTs
          ? prev.clusterStartTs
          : cluster.clusterStartTs;

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
            clusterPilotCount: cluster.clusterPilotCount,
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
          // bridgedSilenceMs: how big a silence the floor-mode walker
          // bridged. 0 = no real silence (fight resumed within the natural
          // cluster gap). Larger values = silence we crossed via cooling.
          const bridgedSilenceMs = cluster.clusterStartTs && prev.clusterStartTs
            ? Math.max(0, (cluster.clusterStartTs - prev.clusterStartTs) * 1000)
            : 0;
          log?.info?.({ systemId, name: next.summary.name,
            clusterStartTs, bridgedSilenceMs },
            'active: re-qualified mid-cool');
        }
      }

      // Pass 2 — sweep stale 'active' entries. Anything in systemState that
      // didn't qualify this tick flips to 'cooling'. Cooling systems get
      // their lastKillTs live-updated from the killstore so the tooltip
      // reflects actual recent activity. Anything cooling past LINGER_MS
      // is dropped entirely.
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
        } else if (st.state === 'cooling') {
          // Live-update lastKillTs so the cooling-row tooltip reflects the
          // genuinely most-recent kill in this system, not the value frozen
          // at cool-start. Killstore.getBySystem returns newest-first.
          const recent = killstore.getBySystem(systemId);
          if (recent && recent.length > 0) {
            const newestTs = recent[0].ts;
            if (newestTs > st.summary.lastKillTs) {
              st.summary.lastKillTs = newestTs;
            }
          }
          if (st.cooledAt < lingerCutoffSec) {
            systemState.delete(systemId);
            log?.info?.({ systemId, name: st.summary.name }, 'active: linger expired, removed');
          }
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
          clusterStartTs:    st.summary.clusterStartTs,
          clusterKillCount:  st.summary.clusterKillCount,
          clusterTotalIsk:   st.summary.clusterTotalIsk,
          clusterPilotCount: st.summary.clusterPilotCount,
          biggestKill:       st.summary.biggestKill,
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
