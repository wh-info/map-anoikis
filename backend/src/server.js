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

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const RING_SIZE = Number(process.env.RING_SIZE || 500);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const ring = createRing(RING_SIZE);
const clients = new Set();
let zkillStatus = 'init';
let seenTotal = 0;
let seenAnoikis = 0;

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
  return {
    id: raw.killmail_id ?? esi.killmail_id,
    systemId: classification.systemId,
    shipTypeId,
    kind: classification.kind,
    characterId: victim.character_id ?? null,
    corporationId: victim.corporation_id ?? null,
    value: raw.zkb?.totalValue ?? 0,
    hasImplants,
    ts
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

fastify.get('/health', async () => ({
  ok: true,
  uptime: Math.round(process.uptime()),
  clients: clients.size,
  ringSize: ring.size,
  seenTotal,
  seenAnoikis,
  zkill: zkillStatus
}));

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

connectZkill({
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
    broadcast({ type: 'kill', kill });
    fastify.log.info({ kill }, 'anoikis kill');
  }
});

fastify.log.info({ port: PORT, ringSize: RING_SIZE }, 'anoikis worker ready');
