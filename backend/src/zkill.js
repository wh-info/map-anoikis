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
// against the current head. Three cases it handles:
//   - nextSeq is far behind head (restart backlog, zKB hole run): jump
//     forward to head, losing the skipped kills so the feed stays real-time.
//   - nextSeq is ahead of head AND we're stuck (no successful kill within
//     STUCK_MS): snap back to head. The "stuck" guard matters because zKB's
//     sequence.json frequently lags behind its actual published killmail
//     files — we can be fetching real kills at seqs the sequence.json hasn't
//     caught up to yet. Snapping back on every head check in that window
//     would reprocess the same seqs in a loop.
//   - nextSeq is behind head AND stuck on a seq that keeps 404ing past
//     STUCK_MS: skip forward by 1. R2Z2 sometimes assigns a sequence but
//     never publishes content for it; the 6s-retry-same-seq contract loops
//     forever and Case 1 won't fire until lag crosses HEAD_SKIP_THRESHOLD.
//     The onJump hook tells the reconciler to backfill the skipped window.
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

const HEAD_CHECK_MS        = 60_000;  // head-check cadence (wall clock)
const HEAD_SKIP_THRESHOLD  = 500;     // jump forward if this many seqs behind
// Case 2 (rollback): give head time to catch up. Anoikis has genuine quiet
// periods, so we wait long enough to avoid misfiring rollback during low
// activity hours.
const STUCK_MS_AHEAD       = 180_000;
// Case 3 (forward-stall): wait just past zKB's ~60s deferred Cloudflare
// re-purge (commit aef85ac on zKB) so most CF-cached 404s self-resolve
// before we skip. When the deferred purge succeeds, the kill arrives
// normally over the live R2Z2 path; when it fails (rare), we skip + onJump
// reconcile + rebroadcast.
const STUCK_MS_BEHIND      = 66_000;
// Lower bound for "slow seq" classification. A seq that takes 30-66s to
// resolve normally is likely a CF-edge-was-stuck-then-unstuck-by-deferred-
// purge event — the natural-recovery case the 66s threshold is designed for.
const SLOW_SEQ_MIN_MS      = 30_000;

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
  let lastPollAt       = null;  // ticks on any successful R2Z2 round-trip (200 or 404)
  let lastJump         = null;
  let lastHeadCheckAt  = 0;

  // Per-case watchdog counters (split from the old single jumpsTotal so we
  // can see which class of upstream weirdness is actually happening).
  let headSkipsTotal           = 0; // Case 1: far behind head, jumped to head
  let rollbacksTotal           = 0; // Case 2: ahead of head, snapped back
  let forwardStallsTotal       = 0; // Case 3: stuck on 404ing seq, skipped +1
  // Case 3 outcome split: did reconcile find the kills (CF cache was stuck)
  // or come back empty (true ghost seq, zKB never produced content)?
  let forwardStallsRecovered   = 0;
  let forwardStallsGhost       = 0;
  // Time-to-recover stats for confirmed-recovered forward-stalls. True mean
  // via sum + count so the value never drifts. ms units.
  let forwardStallsRecoveredSumMs = 0;
  let forwardStallsRecoveredMaxMs = 0;
  // Slow-seqs: 200 responses that took 30-66s after first 404. Proxy for
  // "deferred purge saved us before the watchdog fired."
  let slowSeqsTotal            = 0;

  // Wall-clock when the current nextSeq first 404'd. Cleared on 200 or skip.
  // Used both to compute stuckFor for the recovery-time stats and to bucket
  // slow-seqs in the 30-66s band.
  let stuckSeqStartedAt        = null;

  async function maybeCheckHead() {
    if (nextSeq === null) return;
    if (Date.now() - lastHeadCheckAt < HEAD_CHECK_MS) return;
    lastHeadCheckAt = Date.now();
    try {
      const seq = await fetchJson(SEQ_URL);
      lastPollAt = Date.now();
      if (!seq || typeof seq.sequence !== 'number') return;
      headSeq = seq.sequence;
      const lag = headSeq - nextSeq;

      // Case 1: we're far behind head (zKB hole, stalled restart).
      // Jump forward and let reconcile pick up the gap.
      if (lag > HEAD_SKIP_THRESHOLD) {
        const from = nextSeq;
        nextSeq = headSeq;
        headSkipsTotal++;
        lastJump = `jumped ${from} -> ${headSeq} (${lag} behind)`;
        onStatus?.(`head-skip: ${lastJump}`);
        onJump?.({ from, to: headSeq, lag, at: Date.now(), kind: 'head-skip' });
        await saveState(nextSeq);
        return;
      }

      // Case 2: we're ahead of head AND genuinely stuck (no kill processed
      // in STUCK_MS_AHEAD). zKB's sequence.json often lags its actual
      // published killmail files by a handful of seqs, so "ahead of head" on
      // its own is a normal transient state — only snap back when it's
      // clearly not resolving on its own, indicating the saved state was bad.
      if (lag < 0) {
        const stuckFor = Date.now() - (lastKillAt ?? 0);
        if (lastKillAt !== null && stuckFor < STUCK_MS_AHEAD) return;
        const from = nextSeq;
        nextSeq = headSeq;
        rollbacksTotal++;
        const stuckLabel = lastKillAt === null
          ? 'fresh boot'
          : `stuck ${Math.round(stuckFor / 1000)}s`;
        lastJump = `snapped ${from} -> ${headSeq} (${-lag} ahead, ${stuckLabel})`;
        onStatus?.(`head-rollback: ${lastJump}`);
        await saveState(nextSeq);
        return;
      }

      // Case 3: behind head AND stuck on a 404ing seq. Skip forward by 1.
      // Requires at least one successful kill in this process (lastKillAt
      // set) so a fresh boot that's legitimately catching up from saved
      // state doesn't get forced forward before it's had a chance to poll.
      if (lag > 0 && lastKillAt !== null) {
        const stuckFor = Date.now() - lastKillAt;
        if (stuckFor < STUCK_MS_BEHIND) return;
        const from = nextSeq;
        nextSeq = nextSeq + 1;
        forwardStallsTotal++;
        lastJump = `skipped dead seq ${from} -> ${nextSeq} (lag ${lag}, stuck ${Math.round(stuckFor / 1000)}s)`;
        onStatus?.(`forward-stall: ${lastJump}`);
        // Pass stuckFor + kind so server.js can record the recovery outcome
        // after reconcile completes (recovered vs ghost + time-to-recover).
        onJump?.({ from, to: nextSeq, lag: 1, at: Date.now(), stuckFor, kind: 'forward-stall' });
        await saveState(nextSeq);
        // Reset lastKillAt so we wait another STUCK_MS_BEHIND before
        // skipping again — prevents walking rapidly through the tail end of
        // a legit zero-kill lull. Also clear stuckSeqStartedAt since we just
        // moved past the stuck seq.
        lastKillAt = Date.now();
        stuckSeqStartedAt = null;
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
      lastPollAt = Date.now();
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
    lastPollAt = Date.now();
    if (kill === null) {
      // Mark when the current nextSeq first 404'd. Used to compute slow-seq
      // classification on the eventual 200 response.
      if (stuckSeqStartedAt === null) stuckSeqStartedAt = Date.now();
      return EMPTY_BACKOFF_MS;
    }
    // 200 response. If we'd been 404ing this seq for 30-66s, it's a likely
    // CF-edge-was-stuck-then-unstuck-by-deferred-purge event — count it.
    if (stuckSeqStartedAt !== null) {
      const elapsed = Date.now() - stuckSeqStartedAt;
      if (elapsed > SLOW_SEQ_MIN_MS && elapsed < STUCK_MS_BEHIND) {
        slowSeqsTotal++;
      }
      stuckSeqStartedAt = null;
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

  // Called by server.js once an onJump-triggered reconcile completes for a
  // forward-stall, with the elapsed stuck time and the count of newly-added
  // kills. Splits the stall into recovered (CF-cached 404) vs ghost (zKB
  // never produced content) and updates time-to-recover stats for the
  // recovered case. No-op for non-forward-stall jumps.
  function recordRecoveryOutcome(stuckMs, addedCount) {
    if (typeof addedCount !== 'number' || typeof stuckMs !== 'number') return;
    if (addedCount > 0) {
      forwardStallsRecovered++;
      forwardStallsRecoveredSumMs += stuckMs;
      if (stuckMs > forwardStallsRecoveredMaxMs) {
        forwardStallsRecoveredMaxMs = stuckMs;
      }
    } else {
      forwardStallsGhost++;
    }
  }

  return {
    close() {
      stopped = true;
    },
    recordRecoveryOutcome,
    getState() {
      const recoveredAvgMs = forwardStallsRecovered > 0
        ? Math.round(forwardStallsRecoveredSumMs / forwardStallsRecovered)
        : 0;
      return {
        nextSeq,
        headSeq,
        lag: (headSeq != null && nextSeq != null) ? headSeq - nextSeq : null,
        lastKillAt,
        lastPollAt,
        // Per-case watchdog counters. jumpsTotal kept as a derived sum for
        // any caller still reading the old field name.
        headSkipsTotal,
        rollbacksTotal,
        forwardStallsTotal,
        forwardStallsRecovered,
        forwardStallsGhost,
        forwardStallsRecoveredAvgMs: recoveredAvgMs,
        forwardStallsRecoveredMaxMs,
        slowSeqsTotal,
        jumpsTotal: headSkipsTotal + rollbacksTotal + forwardStallsTotal,
        lastJump,
      };
    },
  };
}
