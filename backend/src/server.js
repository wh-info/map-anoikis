// Fastify HTTP server + /ws fan-out for the Anoikis kill feed.
//
// On startup: open one upstream WebSocket to zKillboard, filter the stream
// to Anoikis kills only, push each into a ring buffer, and broadcast to all
// connected browser clients. New clients receive the current ring buffer as
// a single "snapshot" message immediately after connecting.

import Fastify from 'fastify';
import { WebSocketServer } from 'ws';
import { createRing } from './ring.js';
import { classifyKill } from './filter.js';
import { connectZkill } from './zkill.js';
import { createKillstore, buildIntelKill } from './killstore.js';
import { createBootstrap } from './bootstrap.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const RING_SIZE = Number(process.env.RING_SIZE || 500);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const ring = createRing(RING_SIZE);
const killstore = createKillstore();
const clients = new Set();
let zkillStatus = 'init';
let seenTotal = 0;
let seenAnoikis = 0;
let zkillClient = null;

// Compact the ESI+zkb payload down to just what the frontend uses. This
// keeps fan-out bandwidth small and hides R2Z2's envelope from clients.
// R2Z2 nests the ESI killmail under an `esi` key alongside `zkb`.
//
// Capsule typeIDs — both the standard pod and the Genolution variant. Any
// items carried by a pod ARE implants, so a non-empty items array means
// the victim was podded with implants installed.
const POD_TYPE_IDS = new Set([670, 33328]);

function compactKill(raw, classification) {
  const esi = raw.esi || {};
  const victim = esi.victim || {};
  const ts = esi.killmail_time
    ? Math.floor(new Date(esi.killmail_time).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  const shipTypeId = classification.shipTypeId;
  const hasImplants = POD_TYPE_IDS.has(shipTypeId)
    && Array.isArray(victim.items) && victim.items.length > 0;
  const attackers = Array.isArray(esi.attackers) ? esi.attackers : [];
  const fb = attackers.find((a) => a.final_blow) || attackers[0] || {};
  return {
    id: raw.killmail_id ?? esi.killmail_id,
    systemId: classification.systemId,
    shipTypeId,
    kind: classification.kind,
    characterId: victim.character_id ?? null,
    corporationId: victim.corporation_id ?? null,
    value: raw.zkb?.totalValue ?? 0,
    hasImplants,
    isNpc: !!raw.zkb?.npc,
    ts,
    fbShipTypeId:    fb.ship_type_id ?? null,
    fbCharacterId:   fb.character_id ?? null,
    fbCorporationId: fb.corporation_id ?? null,
    // When our backend first saw this kill. Compared against `ts` by the
    // frontend to decide the DELAYED badge — this is the "zKB published
    // it late" signal, independent of when any browser loaded the page.
    receivedAt: Math.floor(Date.now() / 1000)
  };
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(payload);
      } catch {
        // The socket is doomed; 'close' will fire and clean it up.
      }
    }
  }
}

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' }
});

// CORS — applied to all HTTP responses so the frontend at map.anoikis.info
// can call /intel/:systemId and /health directly from the browser.
fastify.addHook('onSend', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
});
fastify.options('/*', async (_req, reply) => {
  reply.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  return reply.code(204).send();
});

let reconcileStats = { lastRunAt: null, totalRuns: 0, lastAdded: 0 };

fastify.get('/health', async () => ({
  ok: true,
  uptime: Math.round(process.uptime()),
  clients: clients.size,
  ringSize: ring.size,
  seenTotal,
  seenAnoikis,
  zkill: zkillStatus,
  poller: zkillClient?.getState?.() ?? null,
  killstore: killstore.getState(),
  reconcile: reconcileStats,
}));

// Intel: return every kill we have for a system, newest first. The frontend
// filters by ts for the 24h / 30d / 60d view ranges. Served purely from the
// in-memory killstore — no zKB or ESI calls on the request path.
fastify.get('/intel/:systemId', async (req, reply) => {
  const systemId = Number(req.params.systemId);
  if (!Number.isFinite(systemId)) {
    reply.code(400);
    return { error: 'bad systemId' };
  }
  const kills = killstore.getBySystem(systemId);
  return {
    kills,
    coverageFrom: killstore.coverageFrom(),
    generatedAt: Math.floor(Date.now() / 1000),
    size: kills.length
  };
});

// Load persisted killstore from the Railway volume before opening the port.
// Runs once at startup; bootstrap/reconciliation later fill any gaps.
try {
  const res = await killstore.load();
  if (res) {
    fastify.log.info({ total: res.total, kept: res.kept }, 'killstore loaded');
  }
} catch (err) {
  fastify.log.warn({ err: err.message }, 'killstore load failed');
}

await fastify.listen({ port: PORT, host: HOST });

// Attach the raw ws server to the underlying http.Server so fastify can keep
// doing normal HTTP routing for everything except the /ws upgrade path.
const wss = new WebSocketServer({ server: fastify.server, path: '/ws' });

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN !== '*' && req.headers.origin !== ALLOWED_ORIGIN) {
    ws.close(1008, 'origin not allowed');
    return;
  }
  clients.add(ws);
  fastify.log.info({ clients: clients.size }, 'client connected');

  try {
    ws.send(JSON.stringify({ type: 'snapshot', kills: ring.snapshot() }));
  } catch {
    // If the initial send fails the client was already gone; nothing to do.
  }

  ws.on('close', () => {
    clients.delete(ws);
    fastify.log.info({ clients: clients.size }, 'client disconnected');
  });
  ws.on('error', () => {
    // 'close' will fire right after.
  });
});

const bootstrap = createBootstrap({
  killstore,
  log: fastify.log
});

// Lightweight wrapper around reconcileWindow that also updates the /health
// counters and swallows errors so a bad cron run can't crash the worker.
async function runReconcile(fromTs, toTs, reason) {
  try {
    fastify.log.info({ fromTs, toTs, reason }, 'reconcile trigger');
    const stats = await bootstrap.reconcileWindow(fromTs, toTs);
    reconcileStats = {
      lastRunAt: Date.now(),
      totalRuns: reconcileStats.totalRuns + 1,
      lastAdded: stats.added
    };
  } catch (err) {
    fastify.log.warn({ err: err.message, reason }, 'reconcile failed');
  }
}

zkillClient = connectZkill({
  onStatus: (s) => {
    zkillStatus = s;
    fastify.log.info({ zkill: s }, 'upstream status');
  },
  onKill: async (raw) => {
    seenTotal++;
    const classification = await classifyKill(raw);
    if (!classification) return;
    seenAnoikis++;
    const kill = compactKill(raw, classification);
    ring.push(kill);
    killstore.add(buildIntelKill(raw, classification)).catch(() => {});
    broadcast({ type: 'kill', kill });
    fastify.log.info({ kill }, 'anoikis kill');
  },
  // When the watchdog jumps ahead, every kill between `from` and `to` is lost
  // from the live stream. Reconcile the time window those sequences cover —
  // ~6.7s per sequence is R2Z2's natural cadence, so lag * 7 is a safe upper
  // bound. Fire-and-forget so it can't stall the poller loop.
  onJump: ({ lag }) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSec = Math.max(300, lag * 7);
    runReconcile(nowSec - windowSec, nowSec, 'watchdog-jump');
  }
});

// Kickoff logic for the first-ever deploy: if the killstore doesn't yet
// have 60 days of coverage, run the bootstrap walker in the background.
// On every subsequent restart the volume already has the data and this is a
// cheap no-op. Non-blocking so the HTTP server stays responsive throughout.
const RETENTION_SEC = 60 * 24 * 60 * 60;
{
  const nowSec = Math.floor(Date.now() / 1000);
  const oldest = killstore.coverageFrom();
  const target = nowSec - RETENTION_SEC;
  if (oldest === null || oldest > target) {
    fastify.log.info(
      { oldest, target, size: killstore.size() },
      'coverage gap detected — starting background bootstrap'
    );
    bootstrap.bootstrapWindow(target, oldest ?? nowSec)
      .catch((err) => fastify.log.warn({ err: err.message }, 'bootstrap failed'));
  } else {
    fastify.log.info({ size: killstore.size() }, 'killstore coverage complete');
  }
}

// Daily reconciliation sweep — catches anything R2Z2 missed silently or that
// zKB published very late. Piggybacks killstore compaction at the end so the
// NDJSON file stays bounded at ~6 MB steady state.
const DAILY_MS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  await runReconcile(nowSec - 24 * 60 * 60, nowSec, 'daily');
  try {
    await killstore.compact();
    fastify.log.info(killstore.getState(), 'killstore compacted');
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'compact failed');
  }
}, DAILY_MS).unref?.();

fastify.log.info({ port: PORT, ringSize: RING_SIZE }, 'anoikis worker ready');
