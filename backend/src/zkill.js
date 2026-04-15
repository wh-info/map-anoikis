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
// Head-skip watchdog: on a wall-clock cadence (every HEAD_CHECK_MS,
// regardless of poll success) re-fetch sequence.json and reconcile nextSeq
// against the current head. Two cases it handles:
//   - nextSeq is far behind head (restart backlog, zKB hole run): jump
//     forward to head, losing the skipped kills so the feed stays real-time.
//   - nextSeq is ahead of head AND we're stuck (no successful kill within
//     STUCK_MS): snap back to head. The "stuck" guard matters because zKB's
//     sequence.json frequently lags behind its actual published killmail
//     files — we can be fetching real kills at seqs the sequence.json hasn't
//     caught up to yet. Snapping back on every head check in that window
//     would reprocess the same seqs in a loop.
// Running on wall-clock rather than poll-success cadence is load-bearing:
// if every poll 404s the watchdog would otherwise never fire and we'd be
// stuck until a manual restart.
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

const HEAD_CHECK_MS       = 60_000;  // head-check cadence (wall clock)
const HEAD_SKIP_THRESHOLD = 500;     // jump forward if this many seqs behind
const STUCK_MS            = 180_000; // rollback guard: only snap back if no kill in this window

const DEFAULT_UA = 'map-anoikis/0.1 (+https://github.com/wh-info/map-anoikis; anoikis.info)';
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

export function connectZkill({ onKill, onStatus, onJump } = {}) {
  let stopped          = false;
  let nextSeq          = null;
  let headSeq          = null;
  let lastKillAt       = null;
  let lastHeadCheckAt  = 0;
  let jumpsTotal       = 0;

  async function maybeCheckHead() {
    if (nextSeq === null) return;
    if (Date.now() - lastHeadCheckAt < HEAD_CHECK_MS) return;
    lastHeadCheckAt = Date.now();
    try {
      const seq = await fetchJson(SEQ_URL);
      if (!seq || typeof seq.sequence !== 'number') return;
      headSeq = seq.sequence;
      const lag = headSeq - nextSeq;

      // Case 1: we're far behind head (zKB hole, stalled restart).
      // Jump forward and let reconcile pick up the gap.
      if (lag > HEAD_SKIP_THRESHOLD) {
        const from = nextSeq;
        nextSeq = headSeq;
        jumpsTotal++;
        onStatus?.(`head-skip: jumped ${from} -> ${headSeq} (${lag} behind)`);
        onJump?.({ from, to: headSeq, lag, at: Date.now() });
        await saveState(nextSeq);
        return;
      }

      // Case 2: we're ahead of head AND genuinely stuck (no kill processed
      // in STUCK_MS). zKB's sequence.json often lags its actual published
      // killmail files by a handful of seqs, so "ahead of head" on its own
      // is a normal transient state — only snap back when it's clearly not
      // resolving on its own, indicating the saved state was bad.
      if (lag < 0) {
        const stuckFor = Date.now() - (lastKillAt ?? 0);
        if (lastKillAt !== null && stuckFor < STUCK_MS) return;
        const from = nextSeq;
        nextSeq = headSeq;
        jumpsTotal++;
        const stuckLabel = lastKillAt === null
          ? 'fresh boot'
          : `stuck ${Math.round(stuckFor / 1000)}s`;
        onStatus?.(`head-rollback: snapped ${from} -> ${headSeq} (${-lag} ahead, ${stuckLabel})`);
        await saveState(nextSeq);
      }
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

    // Run the watchdog before every fetch. On wall-clock cadence (60s) it's
    // cheap, and it's the only thing that can unstick us when every poll is
    // 404ing — success-path-only checks would leave us frozen.
    await maybeCheckHead();

    const kill = await fetchJson(KILL_URL(nextSeq));
    if (kill === null) {
      return EMPTY_BACKOFF_MS;
    }
    onKill?.(kill);
    nextSeq++;
    lastKillAt = Date.now();
    await saveState(nextSeq);
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
