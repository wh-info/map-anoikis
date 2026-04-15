// Backfill + reconciliation for the killstore.
//
// Two entry points share the same paginated zKB walker + ESI hydrator:
//
//   bootstrapWindow(fromTs, toTs)   — first-ever fill from zKB history
//   reconcileWindow(fromTs, toTs)   — skip killmails already in the store;
//                                     used by the watchdog-jump and daily cron
//                                     triggers to close gaps in live coverage.
//
// zKB source route: /api/regionID/{id}/pastSeconds/{N}/page/{n}/ — per-region
// slim kill list, 200 per page, newest-first. zKB doesn't have a single
// "all w-space" modifier (the wspace / w-space forms both error), so we walk
// every Anoikis region in sequence. 33 regions × a handful of pages each is
// still well inside the 1 req/s zKB budget — the whole sweep finishes in a
// few minutes of bootstrap time.
//
// ESI hydration is the same logic the frontend used to do (and which we just
// removed): read X-Ratelimit-Remaining on each response, pause on 420/429
// with Retry-After, shrink concurrency as the budget drains. A single pair
// of {remaining, pauseUntil} vars is shared across bootstrap + reconcile so
// one can't starve the other when both run in the same process.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { classifyKill } from './filter.js';
import { buildIntelKill } from './killstore.js';

// Persistent walker progress so Railway restarts don't reset us to region 0.
// Without this, every restart re-walks the first few high-activity C1 regions
// (60 min each due to ESI throttling) and never progresses to C2..C6 — which
// is how we ended up with 99% of the store concentrated in A-R00001..A-R00003.
const BOOTSTRAP_STATE_FILE = process.env.BOOTSTRAP_STATE_FILE
  || '/tmp/bootstrap-state.json';

async function loadBootstrapState() {
  try {
    const raw = await readFile(BOOTSTRAP_STATE_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj.lastCompletedIdx === 'number') return obj;
  } catch { /* no state or bad state — start fresh */ }
  return null;
}

async function saveBootstrapState(state) {
  try {
    await mkdir(dirname(BOOTSTRAP_STATE_FILE), { recursive: true });
    await writeFile(BOOTSTRAP_STATE_FILE, JSON.stringify(state));
  } catch { /* best-effort — next boot just re-does the current region */ }
}

async function clearBootstrapState() {
  try { await unlink(BOOTSTRAP_STATE_FILE); } catch { /* already gone */ }
}

// zKB rejects pastSeconds > 7 days, so bootstrap paginates without it and
// uses hydrated killmail_time to decide when to stop each region.
const ZKB_PAGE_URL = (regionId, page) =>
  `https://zkillboard.com/api/regionID/${regionId}/page/${page}/`;
// Second-pass variant: same endpoint but with year/month to target a specific
// calendar month. Each (region × month) query gets its own fresh page budget,
// so the per-system density floor we hit in the first sweep goes away —
// quiet holes stay quiet, busy holes paginate as much as they need inside
// the month slice. Confirmed supported via zKB wiki on 2026-04-15.
const ZKB_MONTH_PAGE_URL = (regionId, year, month, page) =>
  `https://zkillboard.com/api/regionID/${regionId}/year/${year}/month/${month}/page/${page}/`;
const ESI_KILLMAIL_URL = (id, hash) =>
  `https://esi.evetech.net/latest/killmails/${id}/${hash}/`;

// Anoikis region IDs. CCP's SDE groups all wormhole systems into regions
// 11000001..11000033 — 33 contiguous IDs including Thera (G-R00031), C13
// Shattered Frigate (H-R00032), and the Drifter region (K-R00033). Iterating
// the full contiguous range is simpler than importing the system data here.
const ANOIKIS_REGIONS = Array.from({ length: 33 }, (_, i) => 11000001 + i);

const USER_AGENT = process.env.ZKILL_USER_AGENT
  || 'map-anoikis/0.1 (+https://github.com/wh-info/map-anoikis; anoikis.info)';

const MAX_PAGES        = 200;  // hard safety cap — 200 pages × 200 kills = 40k
const PAGE_DELAY_MS    = 1100; // zKB asks for ≤1 req/s; we go just under
const ESI_BATCH_MAX    = 3;    // kept small — bootstrap shares one backend IP

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createBootstrap({ killstore, log }) {
  let esiRemaining  = 100;
  let esiPauseUntil = 0;

  function esiConcurrency() {
    if (esiRemaining < 5)  return 1;
    if (esiRemaining < 20) return 2;
    return ESI_BATCH_MAX;
  }

  async function esiWaitIfPaused() {
    const delta = esiPauseUntil - Date.now();
    if (delta > 0) await sleep(delta);
  }

  // Fetch one paginated zKB slim page for a given Anoikis region. Returns
  // [] when the page is empty (end of data).
  async function fetchSlimPage(regionId, page) {
    const res = await fetch(ZKB_PAGE_URL(regionId, page), {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`zKB ${res.status} region ${regionId} page ${page}`);
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  }

  // Fetch one page of a single calendar month's kills for a region. Used by
  // the 30→60d second pass to target the missing backslice that the first
  // sweep couldn't reach because of per-region page-budget coupling.
  async function fetchSlimMonthPage(regionId, year, month, page) {
    const res = await fetch(ZKB_MONTH_PAGE_URL(regionId, year, month, page), {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    if (!res.ok) {
      throw new Error(`zKB ${res.status} region ${regionId} ${year}-${month} page ${page}`);
    }
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  }

  // Hydrate one slim zKB row via ESI. On 420/429 throws { retryAfter, requeue }
  // so the caller can pause and re-queue the slim row.
  async function hydrateKillmail(slim) {
    if (!slim?.killmail_id || !slim.zkb?.hash) return null;
    let res;
    try {
      res = await fetch(ESI_KILLMAIL_URL(slim.killmail_id, slim.zkb.hash), {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
      });
    } catch { return null; }
    const remainingHdr = res.headers.get('x-ratelimit-remaining');
    if (remainingHdr != null) esiRemaining = Number(remainingHdr);
    if (res.status === 420 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      esiPauseUntil = Date.now() + retryAfter * 1000;
      const err = new Error('esi throttled');
      err.retryAfter = retryAfter;
      err.requeue = slim;
      throw err;
    }
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch { return null; }
  }

  // Turn a hydrated ESI killmail + its slim zkb envelope into the intel
  // shape and push into the killstore. Returns the kill's unix ts so the
  // caller can decide when to stop pagination, or null on failure.
  async function ingest(slim, esiKill) {
    if (!esiKill || !esiKill.killmail_time) return null;
    const raw = {
      killmail_id: slim.killmail_id,
      esi: esiKill,
      zkb: slim.zkb || {}
    };
    const classification = await classifyKill(raw);
    if (!classification) {
      // Not Anoikis or not a tracked kind — still return ts so the walker
      // knows how deep in time it's reached for stopping decisions.
      return Math.floor(new Date(esiKill.killmail_time).getTime() / 1000);
    }
    const kill = buildIntelKill(raw, classification);
    await killstore.add(kill);
    return kill.ts;
  }

  // Drain the current ESI queue. Shared between all regions so the throttle
  // state is continuous and we don't hammer ESI at the region boundary.
  // Returns the oldest (smallest) ts ingested in this drain, or null.
  async function drainEsiQueue(queue, stats) {
    let oldest = null;
    while (queue.length > 0) {
      await esiWaitIfPaused();
      const size = Math.min(esiConcurrency(), queue.length);
      const chunk = queue.splice(0, size);
      const results = await Promise.allSettled(chunk.map(async (row) => {
        const esiKill = await hydrateKillmail(row);
        if (!esiKill) return { ts: null, added: false };
        const ts = await ingest(row, esiKill);
        return { ts, added: ts != null };
      }));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          stats.hydrated++;
          if (r.value.added) stats.added++;
          if (r.value.ts != null && (oldest === null || r.value.ts < oldest)) {
            oldest = r.value.ts;
          }
        } else if (r.reason?.requeue) {
          stats.throttled++;
          queue.push(r.reason.requeue);
        }
      }
    }
    return oldest;
  }

  // Core walker shared by bootstrap and reconcile. Iterates every Anoikis
  // region, paginates newest-first, hydrates each page, and stops the region
  // when the oldest kill on that page crosses fromTs.
  //
  // `skipKnown` short-circuits ingest for killmail_ids already in the store.
  // `resumable` enables bootstrap state persistence: on entry we resume from
  // the region after the last completed one, and on each region done we
  // persist the index so the next restart picks up mid-sweep instead of
  // grinding through A-R00001 again.
  async function walkWindow(fromTs, _toTs, { skipKnown, resumable }) {
    const stats = { regions: 0, pages: 0, slimSeen: 0, hydrated: 0, added: 0, throttled: 0, skippedFighters: 0 };
    const queue = [];

    let startIdx = 0;
    if (resumable) {
      const state = await loadBootstrapState();
      if (state && state.lastCompletedIdx + 1 < ANOIKIS_REGIONS.length) {
        startIdx = state.lastCompletedIdx + 1;
        log?.info?.({ startIdx, regionId: ANOIKIS_REGIONS[startIdx] }, 'bootstrap resuming from saved state');
      } else if (state) {
        // All regions already walked on a previous boot — nothing to do.
        log?.info?.({ completedAt: state.completedAt }, 'bootstrap already complete, skipping');
        return stats;
      }
    }

    for (let idx = startIdx; idx < ANOIKIS_REGIONS.length; idx++) {
      const regionId = ANOIKIS_REGIONS[idx];
      stats.regions++;
      for (let page = 1; page <= MAX_PAGES; page++) {
        let slim;
        try {
          slim = await fetchSlimPage(regionId, page);
        } catch (err) {
          log?.warn?.({ err: err.message, regionId, page }, 'bootstrap zkb page failed');
          break;
        }
        stats.pages++;
        if (slim.length === 0) break;
        stats.slimSeen += slim.length;

        for (const row of slim) {
          if (!row?.killmail_id) continue;
          if (skipKnown && killstore.has(row.killmail_id)) continue;
          // Pre-filter via zkb labels: drop rows we already know we'd drop
          // post-classification, so we don't spend ESI budget hydrating them.
          // Labels look like ["tz:ru","cat:6","pvp","loc:w-space"] — cat:87 is
          // fighters, which filter.js rejects. Cheap win on ESI load.
          const labels = row.zkb?.labels;
          if (Array.isArray(labels) && labels.includes('cat:87')) {
            stats.skippedFighters++;
            continue;
          }
          queue.push(row);
        }

        // Drain after every page so zKB and ESI cadence stay in lockstep.
        const oldestThisPage = await drainEsiQueue(queue, stats);
        await sleep(PAGE_DELAY_MS);

        // Stop this region when the page's oldest kill is past our window.
        if (oldestThisPage != null && oldestThisPage < fromTs) break;
      }
      log?.info?.({ regionId, idx, added: stats.added, pages: stats.pages }, 'bootstrap region done');
      if (resumable) {
        await saveBootstrapState({ lastCompletedIdx: idx, regionId, savedAt: Date.now() });
      }
    }

    if (resumable) {
      await saveBootstrapState({ lastCompletedIdx: ANOIKIS_REGIONS.length - 1, completedAt: Date.now() });
    }
    return stats;
  }

  async function bootstrapWindow(fromTs, toTs) {
    log?.info?.({ fromTs, toTs }, 'bootstrap starting');
    const started = Date.now();
    const stats = await walkWindow(fromTs, toTs, { skipKnown: true, resumable: true });
    const elapsed = Math.round((Date.now() - started) / 1000);
    log?.info?.({ ...stats, elapsed }, 'bootstrap done');
    try { await killstore.compact(); } catch { /* best-effort */ }
    return stats;
  }

  async function reconcileWindow(fromTs, toTs) {
    log?.info?.({ fromTs, toTs }, 'reconcile starting');
    const started = Date.now();
    const stats = await walkWindow(fromTs, toTs, { skipKnown: true, resumable: false });
    const elapsed = Math.round((Date.now() - started) / 1000);
    log?.info?.({ ...stats, elapsed }, 'reconcile done');
    return stats;
  }

  // ─── Second-pass deepener ──────────────────────────────────────────────
  //
  // The first-sweep walker pages zKB's /regionID/{id}/page/{n}/ endpoint
  // newest-first, and each page is ~200 kills mixed across every system in
  // the region. Because the page budget is shared, a dense system like
  // J160941 floors at ~day 30 while quiet holes in the same region reach
  // day 55-60 for free. To deepen the busy systems we need a query whose
  // budget is per-month, not per-region.
  //
  // zKB's year/month modifier does exactly that: /year/{Y}/month/{m}/ bounds
  // the result set to one calendar month, and inside that the page counter
  // gets a fresh budget. Walking each region × each month in the 30–60d
  // backslice turns the dense-system floor from day-30 into day-(month end),
  // which in practice covers the full 60d target.
  //
  // Dedupe is free: skipKnown checks killstore.has() in microseconds before
  // spending any ESI budget, so the 0–30d overlap blasts through without
  // re-hydrating anything. Fighter pre-filter via zkb labels also kept.
  //
  // State lives under `secondPass` inside the same bootstrap-state.json so
  // the file stays a single source of truth. Resume cursor is `(rIdx,mIdx)`,
  // advancing after every (region × month) pair completes.
  function monthsForSecondPass(nowMs) {
    // Target the 30→60d window. Today 2026-04-15 → Feb + Mar 2026. Computed
    // dynamically so this is correct whenever the second pass is triggered.
    const oldest = new Date(nowMs - 60 * 24 * 60 * 60 * 1000);
    const newest = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
    const out = [];
    let y = oldest.getUTCFullYear();
    let m = oldest.getUTCMonth();
    const endY = newest.getUTCFullYear();
    const endM = newest.getUTCMonth();
    while (y < endY || (y === endY && m <= endM)) {
      out.push({ year: y, month: m + 1 });
      m++;
      if (m === 12) { m = 0; y++; }
    }
    return out;
  }

  async function walkRegionMonth(regionId, year, month, stats) {
    const queue = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      let slim;
      try {
        slim = await fetchSlimMonthPage(regionId, year, month, page);
      } catch (err) {
        log?.warn?.({ err: err.message, regionId, year, month, page }, 'second-pass zkb page failed');
        break;
      }
      stats.pages++;
      if (slim.length === 0) break;
      stats.slimSeen += slim.length;

      let newRowsThisPage = 0;
      for (const row of slim) {
        if (!row?.killmail_id) continue;
        if (killstore.has(row.killmail_id)) {
          stats.skipKnown++;
          continue;
        }
        const labels = row.zkb?.labels;
        if (Array.isArray(labels) && labels.includes('cat:87')) {
          stats.skippedFighters++;
          continue;
        }
        queue.push(row);
        newRowsThisPage++;
      }

      await drainEsiQueue(queue, stats);
      // If the whole page was already known we can skip the polite delay —
      // we didn't actually hit zKB/ESI in a costly way beyond the slim fetch.
      // But we still respect PAGE_DELAY_MS between slim fetches to stay under
      // the 1 req/s budget.
      await sleep(PAGE_DELAY_MS);

      // Early stop: if this page was 100% already-known, the next page is
      // almost certainly the same (pages are time-ordered and we're walking
      // a slice of time we already covered). Saves a lot of zKB calls on
      // quiet regions during the 0–30d overlap.
      if (newRowsThisPage === 0 && slim.length > 0) break;
    }
  }

  async function secondPassWindow() {
    const state = (await loadBootstrapState()) || {};
    if (state.secondPass?.completedAt) {
      log?.info?.({ completedAt: state.secondPass.completedAt }, 'second-pass already complete, skipping');
      return { skipped: true };
    }
    const months = monthsForSecondPass(Date.now());
    log?.info?.({ months }, 'second-pass starting');
    const started = Date.now();
    const stats = { regions: 0, pages: 0, slimSeen: 0, hydrated: 0, added: 0, throttled: 0, skippedFighters: 0, skipKnown: 0 };

    const cursor = state.secondPass?.cursor || { rIdx: 0, mIdx: 0 };
    for (let rIdx = cursor.rIdx; rIdx < ANOIKIS_REGIONS.length; rIdx++) {
      const regionId = ANOIKIS_REGIONS[rIdx];
      const startMIdx = rIdx === cursor.rIdx ? cursor.mIdx : 0;
      for (let mIdx = startMIdx; mIdx < months.length; mIdx++) {
        const { year, month } = months[mIdx];
        await walkRegionMonth(regionId, year, month, stats);
        // Persist after every (region × month) so restarts resume cleanly.
        const next = mIdx + 1 < months.length
          ? { rIdx, mIdx: mIdx + 1 }
          : { rIdx: rIdx + 1, mIdx: 0 };
        await saveBootstrapState({ ...state, secondPass: { cursor: next, startedAt: started } });
      }
      stats.regions++;
      log?.info?.({ regionId, rIdx, added: stats.added, pages: stats.pages }, 'second-pass region done');
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    const finalState = (await loadBootstrapState()) || {};
    await saveBootstrapState({
      ...finalState,
      secondPass: { cursor: null, startedAt: started, completedAt: Date.now() }
    });
    log?.info?.({ ...stats, elapsed }, 'second-pass done');
    try { await killstore.compact(); } catch { /* best-effort */ }
    return stats;
  }

  // Exposed so the /health endpoint (or a future operator command) can wipe
  // saved state and force a full re-walk from region 0 on the next bootstrap.
  async function resetBootstrapState() {
    await clearBootstrapState();
  }

  return { bootstrapWindow, reconcileWindow, secondPassWindow, resetBootstrapState };
}
