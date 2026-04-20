// Eve-Scout public signatures poller.
//
// Pulls https://api.eve-scout.com/v2/public/signatures every POLL_MS and
// filters to Thera↔w-space connections only (Turnur rows and k-space
// destinations are dropped — we don't render them on the Anoikis map).
//
// No auth. Descriptive User-Agent is the only requirement. Poll cadence is
// intentionally loose (3 min) because scouts only update this data when they
// scan a new signature; hammering it would be rude and gain us nothing.

const API_URL = 'https://api.eve-scout.com/v2/public/signatures';
const POLL_MS = 3 * 60_000;
const ERROR_BACKOFF_MS = 60_000;

const THERA_SYSTEM_ID = 31000005;
const ANOIKIS_MIN = 31000000;
const ANOIKIS_MAX = 32000000;

const DEFAULT_UA = 'map-anoikis/0.1 (+https://anoikis.info)';
const USER_AGENT = process.env.ZKILL_USER_AGENT || DEFAULT_UA;

function isAnoikis(systemId) {
  return systemId >= ANOIKIS_MIN && systemId < ANOIKIS_MAX;
}

// Trim one Eve-Scout row to just the fields the frontend renders. The API
// returns richer metadata (scouts, updated_at, etc.) we don't use — dropping
// it here keeps the WS payload small.
function compact(row) {
  return {
    id:                row.id,
    in_system_id:      row.in_system_id,
    in_system_name:    row.in_system_name,
    in_system_class:   row.in_system_class,
    wh_type:           row.wh_type,
    max_ship_size:     row.max_ship_size,
    remaining_hours:   row.remaining_hours,
    wh_exits_outward:  row.wh_exits_outward,
    in_signature:      row.in_signature,
    out_signature:     row.out_signature,
    expires_at:        row.expires_at,
  };
}

export function connectEvescout({ onUpdate, onStatus } = {}) {
  let stopped = false;
  let connections = [];
  let lastPollAt = null;
  let lastOkAt = null;
  let consecutiveErrors = 0;

  async function pollOnce() {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from eve-scout`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('eve-scout response not an array');

    const filtered = [];
    for (const row of body) {
      // Only draw arcs where Thera is one side and w-space is the other.
      if (row.out_system_id !== THERA_SYSTEM_ID) continue;
      if (!isAnoikis(row.in_system_id)) continue;
      filtered.push(compact(row));
    }
    return filtered;
  }

  async function loop() {
    while (!stopped) {
      lastPollAt = Date.now();
      try {
        const next = await pollOnce();
        connections = next;
        consecutiveErrors = 0;
        lastOkAt = Date.now();
        onStatus?.(`ok: ${next.length} connections`);
        onUpdate?.(next);
        await sleep(POLL_MS);
      } catch (err) {
        consecutiveErrors++;
        onStatus?.(`error: ${err.message}`);
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  loop();

  return {
    stop: () => { stopped = true; },
    getConnections: () => connections,
    getState: () => ({
      count: connections.length,
      lastPollAt,
      lastOkAt,
      consecutiveErrors,
    }),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
