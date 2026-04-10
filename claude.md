# map-anoikis — Project Context for Claude

This file is the persistent context for Claude when working on this project. It describes what the project is, how it's put together, and the rules Claude should follow. Keep it up to date as decisions change.

---

## 1. Project overview & goals

**Goal:** an interactive 2D map of EVE Online's Anoikis (wormhole space) with a live kill feed overlay. Inspired by [eve-lkm.capsuleer.life](https://eve-lkm.capsuleer.life/) but scoped exclusively to Anoikis — no k-space systems, no gates, no security-status rendering.

**Primary features:**
- Canvas-based pan/zoom starmap of ~2,600 Anoikis systems
- Click/hover a system to see: name, wormhole class, region, constellation, effect, statics
- Search-and-focus: type `J123456`, fly the camera to the system
- Live killmail feed from zKillboard with ring-pulse + flare animations on the matching star
- Ship icons pulled from the EVE Image Server
- Designed to be extended with filters, historical overlays, sun/planet graphics

**Out of scope (for now):**
- Known-space (high/low/null-sec) systems
- Abyssal Deadspace (`AD\d+` / `ADR\d+` — filtered out at build time)
- Authenticated features (character login, personal notes, etc.)
- Wormhole chain tracking / signature scanning (future phase)

---

## 2. Architecture

```
 ┌────────────────────┐       build-time (Python)
 │  EVE SDE (~80MB)   │  ─────────────────────────┐
 └────────────────────┘                            │
 ┌────────────────────┐                            ▼
 │  Anoik.is statics  │  ──►  build/build_systems.py
 └────────────────────┘                            │
                                                   ▼
                                       data/anoikis-systems.json
                                                   │
                                                   ▼
                     ┌─────────────────────────────────────────┐
                     │  frontend/ (vanilla JS + Canvas 2D)     │
                     │  hosted on GitHub Pages                  │
                     └─────────────────────────────────────────┘
                                                   ▲
                                                   │ WebSocket
                                                   │
 ┌────────────────────┐      WS       ┌─────────────────────────┐
 │ zKillboard R2Z2    │  ──────────►  │ backend/ (Node.js)      │
 │ wss://zkillboard   │               │ Railway.app             │
 │   .com/websocket/  │               │ fastify + ws            │
 └────────────────────┘               │ in-memory ring buffer   │
                                      └─────────────────────────┘
```

**Key layering decisions (why):**
- **Build-time SDE → static JSON.** The SDE is ~80MB and changes only on EVE patch days. Parsing it in the browser would be wasteful; parsing it on the server on every request would be wasteful. A one-shot Python build produces a small Anoikis-only JSON (~2,600 systems, well under 1MB gzipped).
- **Single upstream WS, fan-out.** zKillboard's R2Z2 WebSocket gives one stream per subscriber. Running one subscriber on the Railway worker and fanning out to browser clients avoids rate-limit pressure on zKB and gives us a place to filter Anoikis-only kills server-side.
- **In-memory ring buffer, no Redis.** New clients want "what happened in the last few minutes" on connect. A JS array of the last ~500 kills is enough; losing it on worker restart is acceptable because R2Z2 keeps streaming. See `memory/feedback_no_redis.md`.
- **GitHub Pages + Railway.** Frontend is static — perfect for Pages. Only the live-kills worker needs a real process, which Railway handles cheaply.

---

## 3. Folder structure

```
map-anoikis/
├── claude.md                  ← this file
├── mockup/
│   └── index.html             ← Phase 2 visual reference (loads data/anoikis-systems.js)
├── frontend/                  ← Phase 3+, vanilla JS + Canvas 2D
│   ├── index.html
│   ├── src/
│   │   ├── main.js
│   │   ├── renderer.js        ← Canvas draw loop, sprite cache, camera
│   │   ├── camera.js          ← worldToScreen / screenToWorld / flyTo
│   │   ├── data.js            ← fetch anoikis-systems.json, build index
│   │   ├── kills.js           ← WS client + animation queue
│   │   ├── search.js          ← autocomplete + focus
│   │   └── ui.js              ← panels, tooltip, kill feed DOM
│   └── styles.css
├── backend/                   ← Phase 4, Node.js on Railway
│   ├── package.json
│   ├── src/
│   │   ├── server.js          ← fastify HTTP + ws upgrade
│   │   ├── zkill.js           ← R2Z2 upstream WS client
│   │   ├── ring.js            ← in-memory ring buffer
│   │   └── filter.js          ← Anoikis-only killmail filter
│   └── Dockerfile             ← Railway uses this
├── build/                     ← data processing scripts
│   ├── build_systems.py       ← Phase 3: SDE → data/anoikis-systems.js
│   ├── build_types.py         ← Phase 4: SDE → data/type-kinds.js +
│   │                            backend/src/type-kinds.json (shared source
│   │                            of truth for which typeIDs are in-scope)
│   ├── pyproject.toml         ← ruff config (hard pre-deploy gate)
│   └── sde_cache/             ← local copy of sqlite-latest.sqlite(.bz2); gitignored
└── data/                      ← generated output
    ├── anoikis-systems.js     ← window.ANOIKIS_SYSTEMS = [...] (2604 systems
    │                            from SDE: id, name, region, constellation,
    │                            class, effect, x, y, r)
    └── type-kinds.js          ← window.TYPE_NAMES + window.TYPE_KINDS
                                  (typeID → name, typeID → kind label)
```

---

## 4. Data sources

| Source | What | Where | How used |
|---|---|---|---|
| **EVE SDE** | Authoritative system coords, region/constellation metadata | https://developers.eveonline.com/static-data | Parsed once at build time. Drop Y, keep X and Z for 2D projection. |
| **Anoik.is** | Community-maintained wormhole statics, effects, class corrections | https://anoik.is | Merged into the build output. User reviews before trusting. |
| **zKillboard R2Z2** | Live killmails | `https://r2z2.zkillboard.com/ephemeral/` (HTTP polling — the old `wss://` endpoint is gone) | Single upstream poller on Node worker, fan out to browser clients. |
| **EVE Image Server** | Ship icons and 3D renders | `https://images.evetech.net/types/{typeId}/icon?size=64` and `/render?size=128` | Lazy-loaded directly from the browser. Official CCP CDN, free, no auth. |

---

## 5. Wormhole class mapping

Authoritative mapping from Anoikis region ID prefix to wormhole class (per user specification):

| Region IDs | Class |
|---|---|
| `A-R00001`, `A-R00002`, `A-R00003` | **C1** |
| `B-R00004`..`B-R00008` | **C2** |
| `C-R00009`..`C-R00015` | **C3** |
| `D-R00016`..`D-R00023` | **C4** |
| `E-R00024`..`E-R00028` | **C5** |
| `F-R00029`, `F-R00030` | **C6** |
| `G-R00031` | **Thera** |
| `H-R00032` | **C13** (Shattered Frig) |
| `K-R00033` | **Drifter** (C14–C18 / Sentinel / Barbican / Vidette / Conflux / Redoubt) |

Any system whose name matches `^AD\d+$` or whose region matches `^ADR\d+` is Abyssal Deadspace and must be excluded.

---

## 6. SDE processing pipeline

`build/build_systems.py` flow (run against a locally decompressed
Fuzzwork SQLite dump at `build/sde_cache/sqlite-latest.sqlite`):

1. Select every wspace system (`mapSolarSystems.regionID` in 11000000–11999999),
   joining `mapRegions`, `mapConstellations`, and `mapLocationWormholeClasses`
   (system-level override preferred, region-level fallback).
2. Left-join `mapDenormalize` on `groupID = 995` (Secondary Sun) to pick up the
   effect typeID, mapped through `EFFECT_BY_TYPEID` → human label
   (Pulsar / Magnetar / Wolf-Rayet / Cataclysmic Variable / Black Hole / Red Giant).
3. Drop SDE Y; scale X/Z into a compact frame (centered on ~4250,4500) so the
   mockup camera's fit-to-view keeps the same feel it had with the Phase 2b
   extract. The K-R00033 region row is intentionally ignored because its
   wormholeClassID=1 is bogus — the five Drifter systems carry per-system
   overrides (classes 14–18) that resolve first.
4. Write `data/anoikis-systems.js` as `window.ANOIKIS_SYSTEMS = [...]` (a plain
   script-tag global, so the mockup works from `file://` without a dev server).

**Statics and Anoik.is integration are deliberately deferred** — they'll be a
follow-up pass once a fresh static-connection source is chosen.

**Output schema:**
```json
{
  "id": 31000001,
  "name": "J055520",
  "region": "K-R00033",
  "constellation": "K-C00334",
  "class": "Drifter",
  "effect": "Red Giant",
  "x": 3766.48,
  "y": 4730.43,
  "r": 2.5
}
```

**Wormhole class resolution** now comes directly from
`mapLocationWormholeClasses` (see `WH_CLASS_LABEL` in `build_systems.py`),
superseding the region-prefix heuristic in section 5 — that table is kept for
reference but the SDE is authoritative.

---

## 7. Frontend renderer

- **Canvas 2D**, not PixiJS or WebGL. Vanilla JS. See `memory/feedback_canvas_not_pixi.md`.
- Camera uses `worldToScreen` / `screenToWorld` with a single uniform scale. Mouse-centered zoom via `wheel` event.
- **Sprite cache**: one pre-rendered radial-gradient canvas per wormhole class, drawn with `ctx.globalCompositeOperation = 'lighter'` for additive glow.
- **Spatial grid** (200-unit cells) for O(1) hit testing on hover/click.
- **Culling**: only iterate stars inside the visible world-space bounding box (padded slightly).
- **Label LOD**: system names fade in above `camera.scale > 2.4`.
- **Selected system**: thin cyan ring at 16px + faint outer ring at 22px, drawn with default compositing.

The mockup at `mockup/index.html` is the living reference for all of the above — when in doubt, match it.

---

## 8. Animation system

Two animation kinds, queued into a single `activeAnims` array, ticked in the draw loop:

| Kind | Duration | Visual |
|---|---|---|
| `flare` | **1100 ms** | Re-draws the star's sprite at 60px × `(0.6 + t*0.8)` with alpha `(1-t)²`. |
| `ring` | **1200 ms** | Expanding ring from 8 → 98px radius, ease-out-quad. Two concentric strokes: outer red-pink, inner warm gold at 65% radius and 60% alpha. Drawn with `'screen'` compositing. |

Both are triggered together by `triggerKillAnim(star)` when a kill arrives. Animations self-remove when `t >= 1`.

Times (`FLARE_MS`, `RING_MS`) mirror the user's uploaded reference mockup. Don't change them without a reason.

---

## 9. Live kill pipeline

```
zKillboard R2Z2 HTTP ──► zkill.js (Node poller)
  (ephemeral/sequence.json + ephemeral/{seq}.json)
                        │
                        ▼
                     filter.js  ← drop non-Anoikis kills (systemID 31M..32M)
                        │
                        ▼
                     ring.js    ← push compactKill(raw), cap at 500
                        │
                        ▼
                   fastify /ws  ← fan-out to all connected browser clients
                        │
                        ▼
                 mockup/frontend
                        │
                        ├── snapshot: append to DOM feed (no animation)
                        └── kill:     append + triggerKillAnim(starById[systemID])
```

**R2Z2 protocol:** HTTP polling, not WebSocket. The old `wss://` endpoint
is gone. Bootstrap by reading `ephemeral/sequence.json` → start at that
sequence, fetch `ephemeral/{seq}.json`, on 200 forward + increment, on 404
wait ≥6s and retry the same seq. A descriptive `User-Agent` is mandatory
(Cloudflare 403s blank UAs). Rate limit 20 req/s per IP.

**Tracked kill categories** (set at build time in `build/build_types.py`):
- `ship`       — category 6 (ships, includes capsules)
- `structure`  — category 65 (Citadels, Engineering Complexes, Refineries, …)
- `tower`      — category 23 group 365 (POS Control Towers only — guns, arrays, silos excluded)
- `fighter`    — category 87
- `deployable` — category 22 (Mobile Depots, MTUs, Cyno Inhibitors, …)

Any killmail whose victim typeID isn't in one of these kinds is silently
dropped by `backend/src/filter.js`. The kind table is shared between
backend (`backend/src/type-kinds.json`) and frontend (`data/type-kinds.js`)
and generated in a single pass from the SDE.

**Compact payload** sent to the browser:
`{ id, systemId, shipTypeId, kind, characterId, corporationId, value, hasImplants, ts }`.
The frontend resolves `shipTypeId` → name via `window.TYPE_NAMES`, pilot/
corporation names via public ESI (`/characters/{id}/`, `/corporations/{id}/`)
with an in-memory cache.

**On client connect:** server sends the current ring buffer as a single
snapshot message, then streams live events. Snapshot kills do NOT trigger
on-map animations — only live events do.

**Reconnect strategy:** client uses exponential backoff (1s → 2s → 4s → 8s, max 30s) and resets on any successful message.

---

## 10. Backend API surface

Node.js + fastify + `ws`. Railway deploys from `backend/Dockerfile`.

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Railway healthcheck. Returns `200 OK` with uptime. |
| `/ws` | WS | Upgrade endpoint. On connect: snapshot, then live stream. |

Snapshot message:
```json
{ "type": "snapshot", "kills": [ ...ring buffer... ] }
```

Live message:
```json
{
  "type": "kill",
  "kill": {
    "id": 12345,
    "systemId": 31000001,
    "shipTypeId": 11202,
    "kind": "ship",
    "characterId": 90000001,
    "corporationId": 98000001,
    "value": 42000000,
    "hasImplants": false,
    "ts": 1712668800
  }
}
```

Environment variables:
- `ZKILL_USER_AGENT` — override the upstream User-Agent. Default is
  `map-anoikis/0.1 (+https://github.com/brunochicken/map-anoikis)` — change
  to include your real contact once the GH repo URL is final.

No REST endpoints for kills — the WS is the only source. This keeps the server simple and stateless aside from the ring buffer.

---

## 11. Dependencies

**Frontend** — zero runtime deps. Just vanilla JS + Canvas. No bundler required for mockup; Phase 3 may introduce Vite if module splitting becomes useful.

**Backend**:
- `fastify` — HTTP server
- `ws` — WebSocket client (to zKB) and server (to browsers)

That's it. No Express, no Socket.IO, no Redis client, no DB driver. See `memory/feedback_no_redis.md`.

**Build (Python 3.12)**:
- stdlib `sqlite3` + `bz2` (no external DB driver — uses Fuzzwork's SQLite dump)
- Dev: `ruff`, `vulture` (pre-deploy gates)
- Anoik.is scrape lib (likely `requests`) will be added when statics come back

---

## 12. Environment variables

**Backend (Railway)**:
- `PORT` — set by Railway automatically
- `ZKILL_WS_URL` — default `wss://zkillboard.com/websocket/`, overridable for testing
- `RING_SIZE` — default `500`
- `ALLOWED_ORIGIN` — CORS origin for the WS upgrade (the GitHub Pages URL, or `*` in dev)

**Frontend** — no secrets. The WS URL is hard-coded (or injected at build time for prod vs dev).

**Build** — no secrets. SDE is public, Anoik.is is public.

---

## 13. Setup / dev / deploy workflow

**Local dev workflow (user preference — see `memory/user_profile.md`):**
1. All work happens in `c:\Users\bruno\Desktop\map-anoikis`.
2. When ready to publish, user manually copies files into their local GitHub repo folder and pushes via GitHub Desktop. No `git` operations in the working dir.

**Frontend dev:**
- Just open `mockup/index.html` (or `frontend/index.html` later) in a browser. No build step for the mockup.
- For Phase 3, if Vite is introduced, `npm run dev` on port 5173.

**Backend dev:**
- `cd backend && npm install && npm run dev` — starts fastify on `localhost:8080`.
- Frontend connects to `ws://localhost:8080/ws` in dev mode.

**Build (SDE):**
- One-time: download `https://www.fuzzwork.co.uk/dump/sqlite-latest.sqlite.bz2`
  into `build/sde_cache/` and decompress with `python -c "import bz2,shutil; shutil.copyfileobj(bz2.open('build/sde_cache/sqlite-latest.sqlite.bz2','rb'), open('build/sde_cache/sqlite-latest.sqlite','wb'))"`.
- `python build/build_systems.py` — writes `data/anoikis-systems.js`.
- `cd build && python -m ruff check build_systems.py && python -m vulture build_systems.py` — **must pass** before committing. See `memory/feedback_python_gates.md`.

**Deploy:**
- **Frontend**: copy `frontend/` contents into the GH Pages repo, commit via GitHub Desktop.
- **Backend**: `git push` to Railway-connected repo — Railway builds from Dockerfile.
- Eventually: domain via Namecheap, Cloudflare proxy.

---

## 14. Code quality gates

**Python (build scripts):** `ruff` + `vulture` are hard pre-deploy gates. Delete dead code rather than silencing warnings. No `# noqa`. No `# pragma: no cover`. See `memory/feedback_python_gates.md`.

**JavaScript (frontend & backend):** no formal gate yet. Follow the mockup's style — small modules, descriptive names, avoid premature abstraction, prefer real code over clever abstraction. No pseudo-code.

**General:**
- Delete dead code aggressively.
- Avoid speculative abstractions for hypothetical future features.
- Only add comments where the logic isn't self-evident.

---

## 15. Assumptions & open questions

**Assumptions:**
- ~2,600 Anoikis systems; exact count will be produced by the build script.
- The SDE coordinate X/Z projection produces a visually coherent map. (If it doesn't, PCA-fit to the top two principal axes instead.)
- Anoik.is data is scrape-friendly and stable enough to re-fetch on build.
- zKillboard R2Z2 WS is stable enough that a single upstream connection with reconnect is sufficient.

**Open questions:**
- How does the build script handle Drifter / Shattered systems whose coordinates are isolated far from the main cluster? (May need per-region sub-views.)
- Do we want a "Thera-only" / "C5/C6 only" quick filter from day one, or defer to Phase 5?
- Kill value threshold for triggering the big ring animation vs. a subtle flicker? (Currently: all kills trigger both.)
- Should the backend de-duplicate kills by `killID` when zKB reconnects? (Probably yes — trivial to add.)

---

## 16. Future expansion

Ideas parked for later phases, in no particular order:

- **Layers:** toggle class-color vs. kill-heat vs. effect vs. static-count.
- **Filters:** by class, by effect, by static type, by recent activity.
- **Analytics:** 24h / 7d / 30d kill counts per system, heatmap overlay.
- **Activity insights:** "top active systems right now", "quietest C5s", etc.
- **Historical replay:** scrub a slider back through time.
- **Sun graphics:** real per-system sun textures by spectral type (CCP ships graphic IDs in SDE).
- **Planets:** planet count + type icons on system-info panel.
- **Wormhole chain view:** when user scans a signature, draw the chain graph overlaid on the map.
- **Character login (ESI):** personal notes, home system, chain sharing.
- **Performance:** WebGL renderer fallback only if Canvas 2D measurably can't keep up.
- **Mobile:** touch gestures for pan/zoom; currently desktop-focused.

---

## Meta — how Claude should work on this project

- Default to Canvas 2D + vanilla JS on the frontend; default to Node.js on the backend; default to Python for build-time data work.
- Don't suggest Redis, React, PixiJS, or server-side Python. Those are actively rejected.
- Match the mockup's visual language (dark frosted glass, spectral palette, flare+ring animations) unless explicitly asked to change it.
- Explain *why* for non-trivial decisions. Propose alternatives when meaningful. Write real code, never pseudo-code.
- Keep this file updated as decisions change — it's the project's source of truth.
