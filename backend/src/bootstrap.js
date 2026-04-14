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

import { classifyKill } from './filter.js';
import { buildIntelKill } from './killstore.js';

// zKB rejects pastSeconds > 7 days, so bootstrap paginates without it and
// uses hydrated killmail_time to decide when to stop each region.
const ZKB_PAGE_URL = (regionId, page) =>
  `https://zkillboard.com/api/regionID/${regionId}/page/${page}/`;
const ESI_KILLMAIL_URL = (id, hash) =>
  `https://esi.evetech.net/latest/killmails/${id}/${hash}/`;

// Anoikis region IDs. CCP's SDE groups all wormhole systems into regions
// 11000001..11000033 — 33 contiguous IDs including Thera (G-R00031), C13
// Shattered Frigate (H-R00032), and the Drifter region (K-R00033). Iterating
// the full contiguous range is simpler than importing the system data here.
const ANOIKIS_REGIONS = Array.from({ length: 33 }, (_, i) => 11000001 + i);

const USER_AGENT = process.env.ZKILL_USER_AGENT
  || 'map-anoikis/0.1 (+https://github.com/wh-info/map-anoikis; map.anoikis.info)';

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
  // when the oldest kill on that page crosses fromTs. `skipKnown`
  // short-circuits ingest for killmail_ids already in the store.
  async function walkWindow(fromTs, _toTs, { skipKnown }) {
    const stats = { regions: 0, pages: 0, slimSeen: 0, hydrated: 0, added: 0, throttled: 0 };
    const queue = [];

    for (const regionId of ANOIKIS_REGIONS) {
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
          queue.push(row);
        }

        // Drain after every page so zKB and ESI cadence stay in lockstep.
        const oldestThisPage = await drainEsiQueue(queue, stats);
        await sleep(PAGE_DELAY_MS);

        // Stop this region when the page's oldest kill is past our window.
        if (oldestThisPage != null && oldestThisPage < fromTs) break;
      }
      log?.info?.({ regionId, added: stats.added, pages: stats.pages }, 'bootstrap region done');
    }
    return stats;
  }

  async function bootstrapWindow(fromTs, toTs) {
    log?.info?.({ fromTs, toTs }, 'bootstrap starting');
    const started = Date.now();
    const stats = await walkWindow(fromTs, toTs, { skipKnown: false });
    const elapsed = Math.round((Date.now() - started) / 1000);
    log?.info?.({ ...stats, elapsed }, 'bootstrap done');
    try { await killstore.compact(); } catch { /* best-effort */ }
    return stats;
  }

  async function reconcileWindow(fromTs, toTs) {
    log?.info?.({ fromTs, toTs }, 'reconcile starting');
    const started = Date.now();
    const stats = await walkWindow(fromTs, toTs, { skipKnown: true });
    const elapsed = Math.round((Date.now() - started) / 1000);
    log?.info?.({ ...stats, elapsed }, 'reconcile done');
    return stats;
  }

  return { bootstrapWindow, reconcileWindow };
}
