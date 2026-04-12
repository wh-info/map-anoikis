// Intel endpoints — fetch recent kill history from zKillboard for an Anoikis
// system and return aggregated stats for the frontend Intel panel.
//
// Split into three independent endpoints so the frontend can render progress
// bar by bar:
//   /intel/24h/:id      — hourly24 (fast, page 1 only)
//   /intel/60d/:id      — matrix60 + killCount (slow, full 60 day walk)
//   /intel/parties/:id  — top corps & alliances (slowest, needs 60d + names)
//
// zKillboard REST returns slim kills (killmail_id + zkb metadata only).
// Full killmail data (killmail_time, victim, attackers) is fetched from ESI
// using killmail_id + zkb.hash, in parallel batches of ESI_CONCURRENCY.
//
// Cache layout: per-system slot in `intelCache` holds three independent
// aggregates plus in-flight promise pointers, so concurrent calls (e.g. 60d
// + parties firing at the same time from the frontend) share a single
// upstream fetch instead of walking zKB twice.

const CACHE_TTL       = 15 * 60 * 1000;           // 15 min
const CUTOFF_24H      = 24 * 60 * 60 * 1000;
// Long-window cutoff for the activity pattern + parties list. Chosen to
// balance fetch cost against statistical usefulness: 30 days halves the
// ESI fan-out on busy systems (vs 60) and better reflects current tenants
// in wormholes, where crews rotate frequently.
const CUTOFF_LONG     = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGES       = 20;                         // hard cap to avoid runaway fetches
const PAGE_PAUSE      = 200;                        // ms between zKB pages (polite)
const ESI_CONCURRENCY = 10;                         // parallel ESI killmail fetches per chunk
const UA              = process.env.ZKILL_USER_AGENT || 'map.anoikis.info intel/1.0';
const ESI_BASE        = 'https://esi.evetech.net/latest';
const ZKB_BASE        = 'https://zkillboard.com/api';

// systemId → {
//   h24:        { data, fetchedAt } | null
//   h24Pending: Promise | null
//   d60:        { kills, fetchedAt } | null   // raw resolved killmails, reused by parties
//   d60Pending: Promise<kills[]> | null
// }
const intelCache = new Map();
const corpNames  = new Map(); // id → resolved name
const alliNames  = new Map(); // id → resolved name

function slot(systemId) {
  let s = intelCache.get(systemId);
  if (!s) {
    s = { h24: null, h24Pending: null, d60: null, d60Pending: null };
    intelCache.set(systemId, s);
  }
  return s;
}

async function jFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function resolveCorpName(id) {
  if (corpNames.has(id)) return corpNames.get(id);
  try {
    const d = await jFetch(`${ESI_BASE}/corporations/${id}/?datasource=tranquility`);
    corpNames.set(id, d.name || `Corp ${id}`);
  } catch { corpNames.set(id, `Corp ${id}`); }
  return corpNames.get(id);
}

async function resolveAlliName(id) {
  if (alliNames.has(id)) return alliNames.get(id);
  try {
    const d = await jFetch(`${ESI_BASE}/alliances/${id}/?datasource=tranquility`);
    alliNames.set(id, d.name || `Alliance ${id}`);
  } catch { alliNames.set(id, `Alliance ${id}`); }
  return alliNames.get(id);
}

// Fetch a single full killmail from ESI given a slim zKB entry.
async function fetchEsiKill(slim) {
  const { killmail_id, zkb } = slim;
  if (!killmail_id || !zkb?.hash) return null;
  try {
    return await jFetch(
      `${ESI_BASE}/killmails/${killmail_id}/${zkb.hash}/?datasource=tranquility`
    );
  } catch { return null; }
}

// Resolve a page of slim kills to full ESI killmails, ESI_CONCURRENCY at a time.
async function fetchEsiBatch(slimKills) {
  const results = [];
  for (let i = 0; i < slimKills.length; i += ESI_CONCURRENCY) {
    const chunk = slimKills.slice(i, i + ESI_CONCURRENCY);
    const batch = await Promise.all(chunk.map(fetchEsiKill));
    results.push(...batch);
  }
  return results;
}

// Fast path for the 24h view: zKB page 1 contains the most recent ~200 kills,
// which always covers the last 24h (no wormhole system has >200 kills/day).
// We only need to resolve ESI for the kills that fall inside the 24h window,
// which is usually a handful, so this is dramatically cheaper than a full
// 60-day walk.
async function fetchKills24h(systemId) {
  const cutoff = Date.now() - CUTOFF_24H;
  const url = `${ZKB_BASE}/kills/solarSystemID/${systemId}/page/1/`;
  let slim;
  try {
    slim = await jFetch(url);
  } catch (e) {
    console.log(`[intel 24h] fetch error: ${e.message}`);
    return [];
  }
  if (!Array.isArray(slim) || slim.length === 0) return [];

  // Resolve the whole page and filter by timestamp. Most kills on page 1 are
  // older than 24h so the filter drops them, but we have to resolve them to
  // learn their time. Still only one zKB call + up to ~200 ESI fetches, vs
  // the 20-page walk the 60d path does.
  const full = await fetchEsiBatch(slim);
  const kills = [];
  for (const k of full) {
    if (!k || !k.killmail_time) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts >= cutoff) kills.push(k);
  }
  return kills;
}

// Full 60-day walk. Tolerant of zKB's killmail_id (not killmail_time) page
// ordering: don't break on the first out-of-order old kill; only stop paging
// when a page yields zero fresh kills AND contained at least one kill past
// the cutoff. See memory/reference_zkb_pagination.md.
async function fetchKills60d(systemId) {
  const cutoff = Date.now() - CUTOFF_LONG;
  const kills  = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    let slimBatch;
    try {
      const url = `${ZKB_BASE}/kills/solarSystemID/${systemId}/page/${page}/`;
      slimBatch = await jFetch(url);
    } catch (e) {
      console.log(`[intel 60d] page ${page} fetch error: ${e.message}`);
      break;
    }

    if (!Array.isArray(slimBatch) || slimBatch.length === 0) break;

    const fullKills = await fetchEsiBatch(slimBatch);

    let pagePushed = 0;
    let sawOld = false;
    for (const k of fullKills) {
      if (!k || !k.killmail_time) continue;
      const ts = new Date(k.killmail_time).getTime();
      if (!Number.isFinite(ts)) continue;
      if (ts < cutoff) { sawOld = true; continue; }
      kills.push(k);
      pagePushed++;
    }
    if (sawOld && pagePushed === 0) break;
    if (page < MAX_PAGES) await new Promise(r => setTimeout(r, PAGE_PAUSE));
  }
  return kills;
}

// Ensure there is at most one in-flight 60d fetch per system, shared between
// /intel/60d and /intel/parties callers so we don't walk zKB twice.
function get60dKills(systemId) {
  const s = slot(systemId);
  if (s.d60 && Date.now() - s.d60.fetchedAt < CACHE_TTL) {
    return Promise.resolve(s.d60.kills);
  }
  if (s.d60Pending) return s.d60Pending;
  s.d60Pending = (async () => {
    try {
      const kills = await fetchKills60d(systemId);
      s.d60 = { kills, fetchedAt: Date.now() };
      return kills;
    } finally {
      s.d60Pending = null;
    }
  })();
  return s.d60Pending;
}

// --- aggregators -------------------------------------------------

function aggregate24h(kills) {
  const now      = Date.now();
  const cut24    = now - CUTOFF_24H;
  const hourly24 = new Array(24).fill(0);
  for (const k of kills) {
    if (!k?.killmail_time) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cut24) continue;
    const idx = 23 - Math.min(Math.floor((now - ts) / 3_600_000), 23);
    hourly24[idx]++;
  }
  const count = hourly24.reduce((s, v) => s + v, 0);
  return { hourly24, count };
}

function aggregate60d(kills) {
  const matrix60 = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let killCount = 0;
  for (const k of kills) {
    if (!k?.killmail_time) continue;
    const d  = new Date(k.killmail_time);
    const ts = d.getTime();
    if (!Number.isFinite(ts)) continue;
    matrix60[d.getUTCDay()][d.getUTCHours()]++;
    killCount++;
  }
  return { matrix60, killCount };
}

function aggregateParties(kills) {
  const cMap = new Map();
  const aMap = new Map();
  for (const k of kills) {
    if (!k) continue;
    // Count each corp/alliance once per kill (deduplicated across victim + attackers).
    const seenC = new Set();
    const seenA = new Set();
    for (const p of [k.victim, ...(k.attackers || [])]) {
      if (!p) continue;
      if (p.corporation_id && !seenC.has(p.corporation_id)) {
        seenC.add(p.corporation_id);
        cMap.set(p.corporation_id, (cMap.get(p.corporation_id) || 0) + 1);
      }
      if (p.alliance_id && !seenA.has(p.alliance_id)) {
        seenA.add(p.alliance_id);
        aMap.set(p.alliance_id, (aMap.get(p.alliance_id) || 0) + 1);
      }
    }
  }
  const top = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, count]) => ({ id, count }));
  return { topCorps: top(cMap, 10), topAllis: top(aMap, 10) };
}

// --- public endpoints --------------------------------------------

export async function getIntel24h(systemId) {
  const s = slot(systemId);
  if (s.h24 && Date.now() - s.h24.fetchedAt < CACHE_TTL) return s.h24.data;
  if (s.h24Pending) return s.h24Pending;
  s.h24Pending = (async () => {
    try {
      const kills = await fetchKills24h(systemId);
      const data  = aggregate24h(kills);
      s.h24 = { data, fetchedAt: Date.now() };
      return data;
    } finally {
      s.h24Pending = null;
    }
  })();
  return s.h24Pending;
}

export async function getIntel60d(systemId) {
  const kills = await get60dKills(systemId);
  return aggregate60d(kills);
}

export async function getIntelParties(systemId) {
  const kills = await get60dKills(systemId);
  const { topCorps, topAllis } = aggregateParties(kills);
  const [corps, alliances] = await Promise.all([
    Promise.all(topCorps.map(async c => ({ ...c, name: await resolveCorpName(c.id) }))),
    Promise.all(topAllis.map(async a => ({ ...a, name: await resolveAlliName(a.id) }))),
  ]);
  return { corps, alliances };
}
