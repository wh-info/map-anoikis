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
// limit is 20 req/sec per IP; we stay well under with an 800ms base interval.

const SEQ_URL = 'https://r2z2.zkillboard.com/ephemeral/sequence.json';
const KILL_URL = (seq) => `https://r2z2.zkillboard.com/ephemeral/${seq}.json`;
const POLL_INTERVAL_MS = 800;
const EMPTY_BACKOFF_MS = 6500;
const ERROR_BACKOFF_MS = 5000;

const DEFAULT_UA = 'map-anoikis/0.1 (+https://github.com/wh-info/map-anoikis; map.anoikis.info)';
const USER_AGENT = process.env.ZKILL_USER_AGENT || DEFAULT_UA;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export function connectZkill({ onKill, onStatus } = {}) {
  let stopped = false;
  let nextSeq = null;

  async function pollOnce() {
    if (nextSeq === null) {
      const seq = await fetchJson(SEQ_URL);
      if (!seq || typeof seq.sequence !== 'number') {
        throw new Error('bad sequence payload');
      }
      nextSeq = seq.sequence;
      onStatus?.(`bootstrapped at sequence ${nextSeq}`);
      return 0;
    }

    const kill = await fetchJson(KILL_URL(nextSeq));
    if (kill === null) {
      return EMPTY_BACKOFF_MS;
    }
    onKill?.(kill);
    nextSeq++;
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
    }
  };
}
