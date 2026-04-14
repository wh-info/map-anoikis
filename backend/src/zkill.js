// Upstream client for zKillboard R2Z2 — HTTP polling, not WebSocket.
//
// R2Z2 is the successor to the old RedisQ and the (now-removed) /websocket
// endpoint. Protocol:
//
//   1. GET https://r2z2.zkillboard.com/ephemeral/sequence.json
//        -> { "sequence": N }   (highest sequence assigned so far)
//   2. GET https://r2z2.zkillboard.com/ephemeral/{sequence}.json
//        -> full ESI killmail + zkb package, or 404 if not yet published.
//   3. On 404, wait >= 6s and retry the same sequence.
//   4. On 200, hand to onKill and increment sequence.
//
// A descriptive User-Agent is mandatory — Cloudflare 403s blank UAs. Rate
// limit is 20 req/sec per IP; we stay well under it because the natural
// cadence (one new sequence every ~6.7s at the head) is the real pacer.
//
// Head-skip watchdog: every HEAD_CHECK_EVERY successful polls, re-fetch
// sequence.json. If we've fallen more than HEAD_SKIP_THRESHOLD behind
// (network stalls, restart backlog, zKB hole runs), jump nextSeq forward
// to head. We accept losing the skipped kills so the feed stays real-time.
//
// Persistence: nextSeq is written to STATE_FILE on every successful poll.
// On startup we read it first so restarts resume where we left off instead
// of re-bootstrapping at the current head (which would silently drop every
// kill that happened during the restart window).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SEQ_URL = 'https://r2z2.zkillboard.com/ephemeral/sequence.json';
const KILL_URL = (seq) => `https://r2z2.zkillboard.com/ephemeral/${seq}.json`;
const EMPTY_BACKOFF_MS = 6500;
const ERROR_BACKOFF_MS = 5000;

const HEAD_CHECK_EVERY    = 50;   // head-check cadence (successful polls)
const HEAD_SKIP_THRESHOLD = 500;  // jump forward if this many seqs behind

const DEFAULT_UA = 'map-anoikis/0.1 (+https://github.com/wh-info/map-anoikis; map.anoikis.info)';
const USER_AGENT = process.env.ZKILL_USER_AGENT || DEFAULT_UA;
const STATE_FILE = process.env.ZKILL_STATE_FILE || '/tmp/zkill-state.json';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj.nextSeq === 'number' && obj.nextSeq > 0) return obj.nextSeq;
  } catch {
    // Missing or corrupt state — fall through to fresh bootstrap.
  }
  return null;
}

async function saveState(nextSeq) {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ nextSeq, savedAt: Date.now() }));
  } catch {
    // Disk write failures are non-fatal. Next restart will just re-bootstrap.
  }
}

export function connectZkill({ onKill, onStatus } = {}) {
  let stopped      = false;
  let nextSeq      = null;
  let headSeq      = null;
  let lastKillAt   = null;
  let pollsSince   = 0;  // successful polls since last head check
  let jumpsTotal   = 0;

  async function maybeCheckHead() {
    if (pollsSince < HEAD_CHECK_EVERY) return;
    pollsSince = 0;
    try {
      const seq = await fetchJson(SEQ_URL);
      if (!seq || typeof seq.sequence !== 'number') return;
      headSeq = seq.sequence;
      const lag = headSeq - nextSeq;
      if (lag <= HEAD_SKIP_THRESHOLD) return;
      const from = nextSeq;
      nextSeq = headSeq;
      jumpsTotal++;
      onStatus?.(`head-skip: jumped ${from} -> ${headSeq} (${lag} behind)`);
      await saveState(nextSeq);
    } catch {
      // A failed head check is harmless — we'll retry next cycle.
    }
  }

  async function pollOnce() {
    if (nextSeq === null) {
      const persisted = await loadState();
      if (persisted !== null) {
        nextSeq = persisted;
        onStatus?.(`resumed from saved state at sequence ${nextSeq}`);
        return 0;
      }
      const seq = await fetchJson(SEQ_URL);
      if (!seq || typeof seq.sequence !== 'number') {
        throw new Error('bad sequence payload');
      }
      nextSeq = seq.sequence;
      headSeq = seq.sequence;
      onStatus?.(`bootstrapped at sequence ${nextSeq}`);
      return 0;
    }

    const kill = await fetchJson(KILL_URL(nextSeq));
    if (kill === null) {
      return EMPTY_BACKOFF_MS;
    }
    onKill?.(kill);
    nextSeq++;
    lastKillAt = Date.now();
    pollsSince++;
    await saveState(nextSeq);
    await maybeCheckHead();
    return 0;
  }

  async function loop() {
    onStatus?.('starting');
    while (!stopped) {
      try {
        const wait = await pollOnce();
        if (wait > 0 && !stopped) await sleep(wait);
      } catch (err) {
        onStatus?.('error:' + (err?.message || 'unknown'));
        if (!stopped) await sleep(ERROR_BACKOFF_MS);
      }
    }
    onStatus?.('stopped');
  }

  loop();

  return {
    close() {
      stopped = true;
    },
    getState() {
      return {
        nextSeq,
        headSeq,
        lag: (headSeq != null && nextSeq != null) ? headSeq - nextSeq : null,
        lastKillAt,
        jumpsTotal,
      };
    },
  };
}
