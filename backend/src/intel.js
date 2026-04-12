// Intel endpoint — fetches recent kill history from zKillboard for an
// Anoikis system and returns aggregated stats for the frontend Intel panel.
//
// zKillboard REST returns slim kills (killmail_id + zkb metadata only).
// Full killmail data (killmail_time, victim, attackers) is fetched from ESI
// using killmail_id + zkb.hash, in parallel batches of ESI_CONCURRENCY.
//
// Returned shape:
//   hourly24  {number[24]}     kills per hour, last 24 h (index 0 = oldest hour)
//   matrix60  {number[7][24]}  [UTCday 0-6][UTChour 0-23] counts over last 60 days
//   corps     {Array<{id,name,count}>}  top 10 corps by kill participation
//   alliances {Array<{id,name,count}>}  top 10 alliances by kill participation
//   killCount {number}          total kills in the 60-day window

const CACHE_TTL      = 15 * 60 * 1000;           // 15 min
const CUTOFF_60D     = 60 * 24 * 60 * 60 * 1000; // 60 days in ms
const MAX_PAGES      = 20;                         // hard cap to avoid runaway fetches
const PAGE_PAUSE     = 200;                        // ms between zKB pages (polite)
const ESI_CONCURRENCY = 10;                        // parallel ESI killmail fetches per chunk
const UA             = process.env.ZKILL_USER_AGENT || 'map.anoikis.info intel/1.0';
const ESI_BASE       = 'https://esi.evetech.net/latest';
const ZKB_BASE       = 'https://zkillboard.com/api';

const intelCache = new Map(); // systemId → { data, fetchedAt }
const corpNames  = new Map(); // id → resolved name
const alliNames  = new Map(); // id → resolved name

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

async function fetchKills(systemId) {
  const cutoff = Date.now() - CUTOFF_60D;
  const kills  = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    let slimBatch;
    try {
      const url = `${ZKB_BASE}/kills/solarSystemID/${systemId}/page/${page}/`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      slimBatch = await res.json();
    } catch (e) {
      console.log(`[intel] page ${page} fetch error: ${e.message}`);
      break;
    }

    if (!Array.isArray(slimBatch) || slimBatch.length === 0) break;

    // Resolve slim kills → full ESI killmails for this page.
    const fullKills = await fetchEsiBatch(slimBatch);

    let exhausted = false;
    for (const k of fullKills) {
      if (!k || !k.killmail_time) continue;
      const ts = new Date(k.killmail_time).getTime();
      if (!Number.isFinite(ts)) continue;
      if (ts < cutoff) { exhausted = true; break; }
      kills.push(k);
    }
    if (exhausted) break;
    if (page < MAX_PAGES) await new Promise(r => setTimeout(r, PAGE_PAUSE));
  }
  return kills;
}

function aggregate(kills) {
  const now      = Date.now();
  const cut24    = now - 24 * 60 * 60 * 1000;
  const hourly24 = new Array(24).fill(0);
  const matrix60 = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const cMap     = new Map();
  const aMap     = new Map();

  for (const k of kills) {
    if (!k.killmail_time) continue;
    const d   = new Date(k.killmail_time);
    const ts  = d.getTime();
    if (!Number.isFinite(ts)) continue;
    const hr  = d.getUTCHours();
    const dow = d.getUTCDay();

    if (ts >= cut24) {
      const idx = 23 - Math.min(Math.floor((now - ts) / 3_600_000), 23);
      hourly24[idx]++;
    }
    matrix60[dow][hr]++;

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

  return { hourly24, matrix60, topCorps: top(cMap, 10), topAllis: top(aMap, 10) };
}

export async function getIntel(systemId) {
  const cached = intelCache.get(systemId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  const kills = await fetchKills(systemId);
  const { hourly24, matrix60, topCorps, topAllis } = aggregate(kills);

  const [corps, alliances] = await Promise.all([
    Promise.all(topCorps.map(async c => ({ ...c, name: await resolveCorpName(c.id) }))),
    Promise.all(topAllis.map(async a => ({ ...a, name: await resolveAlliName(a.id) }))),
  ]);

  const data = { hourly24, matrix60, corps, alliances, killCount: kills.length };
  intelCache.set(systemId, { data, fetchedAt: Date.now() });
  return data;
}
