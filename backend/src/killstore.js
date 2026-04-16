// 60-day rolling killstore persisted to the Railway volume.
//
// The live R2Z2 stream already hydrates every Anoikis kill, so instead of
// re-fetching from zKB + ESI every time a user opens the intel panel, we keep
// them in memory keyed by killmail_id and serve /intel/:systemId directly.
//
// Persistence model:
//   - Appends go to an NDJSON file (`killstore.ndjson`) — one compact kill per
//     line — so live writes are tiny and never rewrite the whole file.
//   - Compaction rewrites the file from the in-memory Map via a temp file +
//     atomic rename. Triggered by the daily reconciliation cron (phase 4) so
//     the file stays bounded at ~6 MB forever.
//   - On boot, the NDJSON is stream-read line-by-line. Expired kills are
//     skipped so a long-uncompacted file self-heals into the Map.
//
// Storage: one compact kill is ~500 bytes, 60 days × ~200 kills/day = ~6 MB
// steady state. Railway volume is happy.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { appendFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETENTION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const EVICT_EVERY_MS = 10 * 60 * 1000;         // evict from memory every 10 min
const DEFAULT_FILE = '/tmp/killstore.ndjson';

const POD_TYPE_IDS = new Set([670, 33328]);

// Build the store-shape kill from the raw R2Z2 (or bootstrapped zKB+ESI)
// envelope plus the classification result. This shape is BOTH:
//   - flat fields (id, systemId, ts, shipTypeId, value, …) used by the
//     killstore's own indexing and by the live map animation pipeline;
//   - ESI-shaped fields (killmail_time, victim, attackers, _zkbValue) that
//     the frontend intel aggregation reads directly without any adapter.
// Keeping both in one object means the /intel/:systemId endpoint can return
// it verbatim and the downstream corp/alliance walker in src/main.js keeps
// working exactly as it did when it was talking straight to ESI.
export function buildIntelKill(raw, classification) {
  const esi = raw.esi || {};
  const victim = esi.victim || {};
  const ts = esi.killmail_time
    ? Math.floor(new Date(esi.killmail_time).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  const shipTypeId = classification.shipTypeId;
  const attackersRaw = Array.isArray(esi.attackers) ? esi.attackers : [];
  const attackers = attackersRaw.map((a) => ({
    character_id:    a.character_id ?? null,
    corporation_id:  a.corporation_id ?? null,
    alliance_id:     a.alliance_id ?? null,
    ship_type_id:    a.ship_type_id ?? null,
    final_blow:      !!a.final_blow
  }));
  const fb = attackers.find((a) => a.final_blow) || attackers[0] || {};
  const hasImplants = POD_TYPE_IDS.has(shipTypeId)
    && Array.isArray(victim.items) && victim.items.length > 0;
  return {
    id: raw.killmail_id ?? esi.killmail_id,
    systemId: classification.systemId,
    shipTypeId,
    kind: classification.kind,
    characterId:   victim.character_id ?? null,
    corporationId: victim.corporation_id ?? null,
    value: raw.zkb?.totalValue ?? 0,
    hasImplants,
    isNpc: !!raw.zkb?.npc,
    ts,
    fbShipTypeId:    fb.ship_type_id ?? null,
    fbCharacterId:   fb.character_id ?? null,
    fbCorporationId: fb.corporation_id ?? null,
    receivedAt: Math.floor(Date.now() / 1000),
    // ESI-compatible projection used by the frontend intel aggregation.
    killmail_time: esi.killmail_time || new Date(ts * 1000).toISOString(),
    _zkbValue: raw.zkb?.totalValue ?? 0,
    victim: {
      character_id:   victim.character_id ?? null,
      corporation_id: victim.corporation_id ?? null,
      alliance_id:    victim.alliance_id ?? null,
      ship_type_id:   shipTypeId
    },
    attackers
  };
}

export function createKillstore({ file } = {}) {
  const FILE = file || process.env.KILLSTORE_FILE || DEFAULT_FILE;
  const TMP  = FILE + '.tmp';

  // killmail_id → compact kill object
  const byId = new Map();
  // systemId → Set<killmail_id>
  const bySystem = new Map();

  let loaded = false;
  let compactedAt = null;

  function indexAdd(kill) {
    let set = bySystem.get(kill.systemId);
    if (!set) {
      set = new Set();
      bySystem.set(kill.systemId, set);
    }
    set.add(kill.id);
  }

  function indexRemove(kill) {
    const set = bySystem.get(kill.systemId);
    if (!set) return;
    set.delete(kill.id);
    if (set.size === 0) bySystem.delete(kill.systemId);
  }

  function isExpired(kill, nowSec) {
    return kill.ts < nowSec - RETENTION_MS / 1000;
  }

  // Add a kill to the in-memory store and append it to the NDJSON file.
  // Dedupes by killmail_id, so late-arriving R2Z2 kills and reconciliation
  // inserts never double-count. Returns true if this was a new kill.
  async function add(kill) {
    if (!kill || typeof kill.id !== 'number' || typeof kill.systemId !== 'number') {
      return false;
    }
    if (byId.has(kill.id)) return false;
    byId.set(kill.id, kill);
    indexAdd(kill);
    try {
      await appendFile(FILE, JSON.stringify(kill) + '\n');
    } catch {
      // Disk write failure is non-fatal — the in-memory store still has it,
      // and the next compaction will re-establish the file from memory.
    }
    return true;
  }

  // Synchronous variant used during bulk load. No disk I/O, no async.
  function addFromDisk(kill) {
    if (byId.has(kill.id)) return false;
    byId.set(kill.id, kill);
    indexAdd(kill);
    return true;
  }

  // Return every kill for a system as a newest-first array.
  function getBySystem(systemId) {
    const ids = bySystem.get(systemId);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const k = byId.get(id);
      if (k) out.push(k);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  // Oldest ts currently in the store, seconds. Used by the bootstrap boot
  // logic: if coverageFrom is newer than now-60d we have a gap to backfill.
  function coverageFrom() {
    let oldest = null;
    for (const k of byId.values()) {
      if (oldest === null || k.ts < oldest) oldest = k.ts;
    }
    return oldest;
  }

  // Drop expired kills from the in-memory Map. The NDJSON file is not
  // rewritten here — compaction handles that — so evicted lines stay on disk
  // until the next compact() call. That's fine: the loader skips expired
  // lines on next boot, and compact() runs daily.
  function evict() {
    const nowSec = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const [id, kill] of byId) {
      if (isExpired(kill, nowSec)) {
        byId.delete(id);
        indexRemove(kill);
        removed++;
      }
    }
    return removed;
  }

  // Rewrite the NDJSON file from the current in-memory Map. Atomic via
  // temp-file + rename so a crash mid-write leaves the previous complete
  // file intact. Called once a day from the reconciliation cron.
  async function compact() {
    await mkdir(dirname(FILE), { recursive: true });
    evict();
    const lines = [];
    for (const kill of byId.values()) lines.push(JSON.stringify(kill));
    await writeFile(TMP, lines.join('\n') + (lines.length ? '\n' : ''));
    await rename(TMP, FILE);
    compactedAt = Date.now();
  }

  // Stream-read the NDJSON file on startup. Runs once; subsequent calls are
  // no-ops. Expired lines are skipped so a long-uncompacted file self-heals.
  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      await stat(FILE);
    } catch {
      return; // No file yet — fresh deploy, empty store.
    }
    const nowSec = Math.floor(Date.now() / 1000);
    let total = 0;
    let kept = 0;
    const stream = createReadStream(FILE, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      total++;
      try {
        const kill = JSON.parse(line);
        if (isExpired(kill, nowSec)) continue;
        if (addFromDisk(kill)) kept++;
      } catch {
        // Skip malformed lines.
      }
    }
    return { total, kept };
  }

  // Periodic eviction timer. No file rewrite — just frees memory for kills
  // whose ts has aged past the retention window.
  const evictTimer = setInterval(evict, EVICT_EVERY_MS);
  evictTimer.unref?.();

  return {
    add,
    getBySystem,
    coverageFrom,
    evict,
    compact,
    load,
    has: (id) => byId.has(id),
    size: () => byId.size,
    values: () => byId.values(),
    getState: () => ({
      size: byId.size,
      systems: bySystem.size,
      coverageFrom: coverageFrom(),
      compactedAt
    })
  };
}
