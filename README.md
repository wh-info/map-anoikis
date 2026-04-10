# map-anoikis

Interactive 2D map of EVE Online's Anoikis (wormhole space) with a live
zKillboard feed overlay. Served at **[map.anoikis.info](https://map.anoikis.info)**.

- **Frontend** — vanilla JS + Canvas 2D, static, hosted on GitHub Pages
  from the repository root (`index.html`).
- **Backend** — small Node.js worker (Fastify + `ws`) that polls
  zKillboard R2Z2, filters Anoikis kills, and fans them out over a
  WebSocket. Hosted on Railway, reachable at `wss://ws.anoikis.info/ws`.
- **Build** — Python scripts under `build/` turn the EVE SDE into the
  static data files under `data/` (systems, type → kind lookup).

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and design notes.

## Layout

```
index.html             Production frontend (served by GitHub Pages)
data/                  Generated static data (systems, type kinds)
backend/               Node.js worker (Railway deploy target)
build/                 Python SDE → JSON pipeline
mockup/                Phase 2/3 visual reference (kept for dev)
```

## Local dev

```
# backend
cd backend && npm install && npm run dev
# open index.html in a browser (or serve the repo root)
```

The frontend auto-detects `localhost` and connects to
`ws://localhost:8080/ws`; in production it uses `wss://ws.anoikis.info/ws`.
