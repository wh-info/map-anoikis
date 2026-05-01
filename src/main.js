// anoikis.info — main script
// Canvas 2D map of Anoikis (wormhole) space with live zKillboard kill feed.
// Data globals loaded before this script: window.ANOIKIS_SYSTEMS, window.TYPE_NAMES, window.TYPE_KINDS.

// --- Constants ---------------------------------------------------
let MIN_SCALE = 0.56;
const MAX_SCALE = 35;
const FLARE_MS = 1100;
const RING_MS  = 2000;
// Kills whose killmail_time is older than this when we receive them are
// treated as "delayed" — the backend feed sometimes emits hours/days-old kills
// in bulk when zKillboard catches up after falling behind CCP's killmail delay.
const DELAYED_KILL_MS = 60 * 60 * 1000;
// Kills delayed by more than this are routed to history-only — no live feed
// row, no map animation. They still go to the history buffer and the intel
// cache, just don't pretend to be "live activity." Set to Infinity to disable.
const HISTORY_ONLY_DELAY_MS = 16 * 60 * 60 * 1000;

// WH class palettes
const PALETTES = {
  ember: {
    C1: [255,140,0], C2: [255,140,0], C3: [255,140,0], C4: [255,140,0],
    C5: [255,140,0], C6: [255,140,0], Thera: [255,140,0],
    C13: [255,140,0], Drifter: [255,140,0]
  },
  anoikis: {
    C1: [122,209,255], C2: [106,208,199], C3: [134,224,138], C4: [216,216,106],
    C5: [255,173,106], C6: [255,109,109], Thera: [201,139,255],
    C13: [154,166,194], Drifter: [255,79,163]
  },
  whtype: {
    C1: [66,255,236], C2: [66,179,255], C3: [66,101,255], C4: [66,48,207],
    C5: [156,50,237], C6: [242,48,220], Thera: [246,252,50],
    C13: [237,237,237], Drifter: [237,237,237]
  },
  ghost: {
    C1: [38,110,110], C2: [38,110,110], C3: [38,110,110], C4: [38,110,110],
    C5: [38,110,110], C6: [38,110,110], Thera: [38,110,110],
    C13: [38,110,110], Drifter: [38,110,110]
  },
};

const CLASS_COLORS = { ...PALETTES.ghost };

// 'ghost' | 'ember' | 'anoikis' | 'whtype' → class-based colouring.
// 'eve'   → per-star colouring from SUN_COLORS[sunTypeId].
let currentPalette = localStorage.getItem('anoikis-palette') || 'eve';

function applyPalette(name) {
  currentPalette = name;
  if (name === 'eve') return; // eve doesn't touch CLASS_COLORS / spriteCache
  const p = PALETTES[name];
  for (const k of Object.keys(p)) CLASS_COLORS[k] = p[k];
  for (const cls of Object.keys(CLASS_COLORS)) spriteCache[cls] = buildSprite(CLASS_COLORS[cls]);
}

// --- Canvas setup ------------------------------------------------
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d', { alpha: false });
let DPR = Math.min(window.devicePixelRatio || 1, 2);
const _isMobile = matchMedia('(pointer: coarse)').matches;
if (_isMobile) {
  const olist = document.getElementById('orrery-list');
  const obody = olist && olist.parentNode;
  if (obody) {
    const row = document.createElement('div');
    row.className = 'orrery-controls-row';
    row.appendChild(document.getElementById('orrery-rotate-btn'));
    row.appendChild(document.querySelector('.orrery-view-toggle'));
    obody.insertBefore(row, olist);
  }
}
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * DPR);
  canvas.height = Math.floor(window.innerHeight * DPR);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
// On resize: keep whatever world point was under the screen center under
// the screen center after resize.
window.addEventListener('resize', () => {
  const prevCx = window.innerWidth * 0.5;
  const prevCy = window.innerHeight * 0.5;
  const worldCenter = screenToWorld(prevCx, prevCy);
  resize();
  camera.offsetX = window.innerWidth * 0.5 - worldCenter.x * camera.scale;
  camera.offsetY = window.innerHeight * 0.5 - worldCenter.y * camera.scale;
  updateZoomLabel();
});
resize();

// --- Camera ------------------------------------------------------
// screen = world * scale + offset.
const camera = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  focusAnim: null  // { start, duration, from:{scale,offsetX,offsetY}, to:{...} }
};
function worldToScreen(x, y) {
  return { x: x * camera.scale + camera.offsetX, y: y * camera.scale + camera.offsetY };
}
function screenToWorld(x, y) {
  return { x: (x - camera.offsetX) / camera.scale, y: (y - camera.offsetY) / camera.scale };
}

// --- Star loader -------------------------------------------------
if (!window.ANOIKIS_SYSTEMS) {
  throw new Error('anoikis-systems.js did not load — check <script src="./data/anoikis-systems.js">');
}
const stars = window.ANOIKIS_SYSTEMS.map((s) => ({
  id: s.id,
  name: s.name,
  regionName: s.region,
  constellation: s.constellation || s.region,
  x: s.x,
  y: s.y,
  r: s.r,
  whClass: s.class,
  effect: s.effect || null,
  sunTypeId: s.sunTypeId || null,
  sun: s.sun || null,
  planets: s.planets || [],
  statics: [],
  twinklePhase: Math.random() * Math.PI * 2,
  twinkleSpeed: 0.55 + Math.random() * 0.9,
  flareUntil: 0
}));
document.getElementById('star-count').textContent = stars.length + ' wormhole systems';
// systemID -> star, used by the live kill feed to resolve incoming IDs.
const starById = new Map(stars.map((s) => [s.id, s]));
// name (J-code) -> star, used by search and static loader.
const starByName = new Map(stars.map((s) => [s.name, s]));

// Wormhole statics + type properties.
// statics: served from data/wh-statics.json.
// types:   pulled live from the user's own whtype.info site. Browser respects
//          the server's 10-minute Cache-Control, which is the effective update
//          cadence. The GH Pages URL 301s to whtype.info without CORS headers
//          on the redirect, so we hit whtype.info directly.
window.WH_STATICS = {};
window.WH_TYPES   = {};
fetch('./data/wh-statics.json?v=20260417')
  .then((r) => (r.ok ? r.json() : {}))
  .then((data) => {
    window.WH_STATICS = data || {};
    for (const [name, entry] of Object.entries(window.WH_STATICS)) {
      const star = starByName.get(name);
      if (star) star.statics = entry.static || [];
    }
    if (selected) selectStar(selected, false);
  })
  .catch(() => {});
fetch('https://whtype.info/data/wormholes.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((list) => {
    const map = {};
    for (const entry of list || []) {
      if (entry && entry.type) map[entry.type] = entry;
    }
    window.WH_TYPES = map;
    if (selected) selectStar(selected, false);
  })
  .catch(() => {});

// Named Drifter systems — keyed by SDE name; carries lore J-code + subclass.
const DRIFTER_INFO = {
  'Sentinel MZ':        { jcode: 'J055520', subclass: 'C14' },
  'Liberated Barbican': { jcode: 'J110145', subclass: 'C15' },
  'Sanctified Vidette': { jcode: 'J164710', subclass: 'C16' },
  'Conflux Eyrie':      { jcode: 'J200727', subclass: 'C17' },
  'Azdaja Redoubt':     { jcode: 'J174618', subclass: 'C18' },
};
function drifterDisplay(star) { return DRIFTER_INFO[star.name] ?? null; }

const CLASS_OVERRIDES = { 'Thera': 'C12' };
function displayClass(star) {
  const dd = drifterDisplay(star);
  if (dd) return dd.subclass;
  return CLASS_OVERRIDES[star.name] ?? star.whClass;
}
function displayName(star) {
  return star.name;
}

// Star bounds — used by resetView().
const starBounds = (() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stars) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  return { minX, minY, maxX, maxY };
})();

// J130621 is the horizontal anchor for the default view — it sits left of the
// bbox centre, so framing on it pushes the whole cluster slightly leftward.
const RESET_ANCHOR = stars.find((s) => s.name === 'J130621');

function computeResetTarget() {
  const padding = _isMobile ? 80 : 50;
  const cw = window.innerWidth, ch = window.innerHeight;
  const mapW = starBounds.maxX - starBounds.minX;
  const mapH = starBounds.maxY - starBounds.minY;
  const scale = clamp(
    Math.min((cw - padding * 2) / mapW, (ch - padding * 2) / mapH),
    MIN_SCALE, 1.5
  );
  const anchorX = RESET_ANCHOR ? RESET_ANCHOR.x : (starBounds.minX + starBounds.maxX) / 2;
  const anchorShiftPx = _isMobile ? 20 : 75;
  const anchorShiftPy = _isMobile ? -20 : 0;
  return {
    scale,
    offsetX: cw / 2 + anchorShiftPx - anchorX * scale,
    offsetY: ch / 2 + anchorShiftPy - ((starBounds.minY + starBounds.maxY) / 2) * scale
  };
}

function resetView() {
  const t = computeResetTarget();
  camera.scale = t.scale;
  camera.offsetX = t.offsetX;
  camera.offsetY = t.offsetY;
  camera.focusAnim = null;
  updateZoomLabel();
}

function animatedResetView() {
  deselectStar();
  const to = computeResetTarget();
  camera.focusAnim = {
    start: performance.now(),
    duration: 380,
    easePow: 4,
    from: { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY },
    to
  };
}
resetView();

let showLabels = localStorage.getItem('anoikis-labels') === '1';
let potatoMode = localStorage.getItem('anoikis-potato') === '1';
let showThera  = localStorage.getItem('anoikis-thera')  === '1';
// Active rings — defaults ON. Hides only the rotating dashed rings on the
// map; the // ACTIVE NOW // sidebar list stays visible regardless.
let showActiveRings = localStorage.getItem('anoikis-active-rings') !== '0';
// Star glow intensity (0..1). Multiplies BOTH halo alpha and halo size in
// the draw loop. 1.0 = today's appearance (max). Lower = subtler stars.
// The crisp center dot is untouched, so the map stays readable at any value.
let starGlow = parseFloat(localStorage.getItem('anoikis-star-glow'));
if (!Number.isFinite(starGlow) || starGlow < 0 || starGlow > 1) starGlow = 1;

// Active hot systems — fetched from backend /active every 60s. Each entry:
//   { systemId, name, class, killCount, lastKillTs, totalIsk,
//     lastKill: { shipTypeId, isk, ts } | null }
// Drives the // ACTIVE NOW // sidebar list and the yellow rotating dashed
// rings on the map. Empty when no system meets the four-condition rule.
let activeSystems = [];
// systemId -> per-system render state for the rotating ring on the map.
// Tracks fade-in/out alpha (for hot transitions), color shift state (for
// hot↔focused transitions), and a randomized initial rotation angle.
const activeRingState = new Map();
// User's currently-focused system for the killfeed scope feature. null when
// global. Independent of hot status — a focused system stays focused even
// when it stops being hot.
let focusedSystemId = null;
// Focused-mode killfeed state. Backed by /intel/{systemId} filtered to last
// 24h, sorted newest-first, paginated at HISTORY_PAGE_SIZE per page. Live
// WS kills for the focused system prepend to focusKills as they arrive.
// focusFetchToken is a monotonic counter used to invalidate stale fetches
// when the user switches focus mid-load.
const FOCUS_WINDOW_MS = 24 * 60 * 60 * 1000;     // 24h slice
let focusKills = [];                              // intel-shape kills, newest-first
let focusPage = 0;                                // 0-based current page index
let focusUnseenCount = 0;                         // banner counter (reset on page-1 view)
let focusFetchToken = 0;
// Kills arriving over WS while the /intel fetch is in flight need to be
// queued so they aren't dropped. Drained into focusKills after fetch resolves.
let focusPendingWsKills = [];
let focusFetching = false;
const ACTIVE_RING_DASH        = [12, 10];   // chunky scanning marks (was [6,8])
const ACTIVE_RING_ROTATION_MS = 8000;       // 1 turn per 8 seconds (was 5000)
const ACTIVE_RING_LINEWIDTH   = 2;
const ACTIVE_RING_ALPHA       = 0.8;        // peak alpha for active rings (was 0.9)
const ACTIVE_RING_COOLING_ALPHA_MIN = 0.4;  // alpha at end of 30-min linger
const ACTIVE_RING_RADIUS_PX   = 20;         // screen-pixel size, scaled by zoomK
const ACTIVE_RING_FADE_IN_MS  = 1000;
const ACTIVE_RING_FADE_OUT_MS = 2500;
const ACTIVE_RING_COLOR_SHIFT_MS = 500;     // tier↔tier or hot↔focused transition
// Tier-by-intensity color RGB triplets. Tiers (Option D, decoupled AND-rules):
// Tier 1 (yellow): qualifying floor (small fight, worth glancing).
// Tier 2 (ember):  ≥15 kills AND ≥3B ISK   (real fleet fight, worth flying to).
// Tier 3 (red):    ≥30 kills AND ≥10B ISK  (major event / eviction).
// Focused-only ring uses cyan.
const ACTIVE_RING_COLOR_TIER1   = [232, 212, 77];   // #e8d44d yellow
const ACTIVE_RING_COLOR_TIER2   = [232, 154, 77];   // #e89a4d ember/orange
const ACTIVE_RING_COLOR_TIER3   = [254,  55, 67];   // #fe3743 red (matches --danger)
const ACTIVE_RING_COLOR_FOCUSED = [  0, 200, 200];  // #00c8c8 cyan
const ACTIVE_RING_TIER2_KILLS = 15;
const ACTIVE_RING_TIER2_ISK   = 3_000_000_000;
const ACTIVE_RING_TIER3_KILLS = 30;
const ACTIVE_RING_TIER3_ISK   = 10_000_000_000;
// v3 — cooling linger window. Mirrors backend LINGER_MS.
const COOLING_LINGER_MS = 30 * 60 * 1000;

// Active Eve-Scout Thera connections, pushed by the backend over /ws.
// Each entry: { id, in_system_id, in_system_name, in_system_class,
//   wh_type, max_ship_size, remaining_hours, wh_exits_outward,
//   in_signature, out_signature, expires_at }.
let theraConnections = [];
// id of the Thera connection currently hovered in the sidebar list, or null.
// When set, drawTheraConnections dims every other arc so the hovered one pops.
let theraHoverId = null;
const THERA_SYSTEM_ID = 31000005;
const THERA_COLORS = {
  frigate: '#1f5eeb',
  medium:  '#36cccc',
  large:   '#d6d9cc',
  capital: '#f0a800',
  xlarge:  '#f0a800',
};
const THERA_DEFAULT_COLOR = '#888888';
function theraSizeColor(size) {
  return THERA_COLORS[size] || THERA_DEFAULT_COLOR;
}

// ─── Active hot systems ──────────────────────────────────────────────────
//
// Fetched from backend /active every 60s. The list drives both the sidebar
// "// ACTIVE NOW //" UI and the yellow rotating dashed rings on the map.
// Per-system render state for the rings (fade alpha, rotation angle, color
// transition) lives in activeRingState — entries are added when a system
// becomes hot or focused, kept across polls, and pruned after fade-out.

function fmtAge(ts) {
  if (!ts) return '';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60)    return sec + 's ago';
  if (sec < 3600)  return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

// Compact-but-precise age string for scatter dot tooltips. Sub-hour kills
// get minute precision; hour-scale kills show hours + minutes; day+ kills
// show whole days only. The 30s/4m/22m/1h 8m/11h 5m/4d shape gives recent
// kills the precision they need on 3h/12h scatter without inflating older
// kills with irrelevant minute remainders.
function fmtAgeScatter(ts) {
  if (!ts) return '';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60)    return sec + 's ago';
  const mins = Math.floor(sec / 60);
  if (mins < 60)   return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const remM = mins % 60;
    return remM > 0 ? `${hours}h ${remM}m ago` : `${hours}h ago`;
  }
  return Math.floor(hours / 24) + 'd ago';
}

// Long-form age string for tooltips that want a more readable phrase than
// the compact `fmtAge`. Used in active-list tooltips.
//   45 sec ago / 4 min ago / 1 hour ago / 2 hours ago / 3 days ago
function fmtAgeLong(ts) {
  if (!ts) return '';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60)    return sec + ' sec ago';
  if (sec < 3600)  return Math.floor(sec / 60) + ' min ago';
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
  }
  const d = Math.floor(sec / 86400);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function fmtIskCompact(v) {
  if (!v || v <= 0) return '0';
  if (v >= 1e12) return (v / 1e12).toFixed(1) + 'T';
  if (v >= 1e9)  return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6)  return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3)  return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

// Tooltip body for an active-list row. Two lines:
//   Active:  "16.0B ISK destroyed · Active for 14 min"
//            "Biggest loss: Vargur · 1.2B · 47 sec ago"
//   Cooling: "16.0B ISK destroyed · last kill 4 min ago"
//            "Biggest loss: Vargur · 1.2B · 47 sec ago"
// Cooling line 1 was "ended X ago" but "ended" is misleading — cooledAt is
// when the state machine flipped, not when activity stopped. Kills can keep
// arriving after that (just not at fight intensity). lastKillTs is honest.
// Resolves the ship name via window.TYPE_NAMES (already loaded). No ESI
// lookup — the data we need is in the /active payload.
function activeRowTooltip(s) {
  const lines = [];
  const isk = fmtIskCompact(s.clusterTotalIsk ?? s.totalIsk ?? 0);
  if (s.state === 'cooling') {
    lines.push(`${isk} ISK destroyed · last kill ${fmtAgeLong(s.lastKillTs)}`);
  } else if (s.clusterStartTs) {
    const mins = Math.max(1, Math.floor((Date.now() / 1000 - s.clusterStartTs) / 60));
    lines.push(`${isk} ISK destroyed · Active for ${mins} min`);
  } else {
    // Backwards-compat for v2 backend during rollout — show the v2 line.
    lines.push(`${s.killCount} kills · ${isk} ISK destroyed`);
  }
  const big = s.biggestKill || s.lastKill;
  if (big) {
    const shipName = window.TYPE_NAMES?.[big.shipTypeId] || 'Unknown';
    const biskF = fmtIskCompact(big.isk);
    const age = fmtAgeLong(big.ts);
    const label = s.biggestKill ? 'Biggest loss' : 'Last';
    lines.push(`${label}: ${shipName} · ${biskF} · ${age}`);
  }
  return lines.join('\n');
}

function buildActiveRow(s) {
  const row = document.createElement('div');
  row.className = 'active-now-row';
  if (s.state === 'cooling') row.classList.add('active-now-row--cooling');
  row.dataset.tip = activeRowTooltip(s);
  // Row meta: cluster kill count + cluster pilot count. Same format for both
  // active and cooling rows — temporal context lives in the section heading
  // (// ACTIVE NOW // vs // RECENTLY ACTIVE //) and the tooltip.
  // clusterPilotCount may be missing during the brief cross-deploy window
  // before the backend ships it — fall back to '…' so the row looks
  // intentional rather than broken.
  const kc = s.clusterKillCount ?? s.killCount;
  const pilots = s.clusterPilotCount ?? '…';
  const k = `${kc} kill${kc === 1 ? '' : 's'}`;
  const p = pilots === '…'
    ? '… pilots'
    : `${pilots} pilot${pilots === 1 ? '' : 's'}`;
  const meta = `${k} · ${p}`;
  row.innerHTML = `
    <span class="an-sys"><span class="an-sys-name">${escapeHtml(s.name)}</span><span class="an-sys-class"> · ${escapeHtml(s.class)}</span></span>
    <span class="an-meta">${meta}</span>
  `;
  row.addEventListener('click', () => {
    const star = starById.get(s.systemId);
    if (star) locateStar(star);
  });
  // Hover trace from the row to the system on the map — mirrors the
  // killfeed locate-button trace. Skipped on touch devices (hover events
  // don't fire there, same as the locate-button pattern).
  if (!isTouchDevice) {
    row.addEventListener('mouseenter', () => {
      const star = starById.get(s.systemId);
      // fromRightEdge: trace line origin starts at the row's right edge
      // (toward the map) instead of the center. Killfeed locate buttons
      // omit this flag and keep the center-origin behavior.
      if (star) locateHover = { el: row, star, fromRightEdge: true };
    });
    row.addEventListener('mouseleave', () => {
      if (locateHover && locateHover.el === row) locateHover = null;
    });
  }
  return row;
}

function renderActiveList() {
  const wrap        = document.getElementById('active-now');
  const list        = document.getElementById('active-now-list');
  const coolingWrap = document.getElementById('recently-active');
  const coolingList = document.getElementById('recently-active-list');
  if (!wrap || !list) return;

  // Partition the unified /active list by state. Cooling entries arrive
  // sorted newest-cooled-first by the backend; we honor that order.
  const activeRows  = activeSystems.filter(s => !s.state || s.state === 'active');
  const coolingRows = activeSystems.filter(s => s.state === 'cooling');

  // Top-level wrapper: empty only when BOTH sections are empty.
  wrap.classList.toggle('empty', activeRows.length === 0 && coolingRows.length === 0);

  // Clear any active-list-row hover trace before destroying the rows.
  // Otherwise the deleted row's mouseleave never fires and the trace stays
  // drawn indefinitely, pointing at a now-vanished active system.
  const inActiveList   = locateHover && list.contains(locateHover.el);
  const inCoolingList  = coolingList && locateHover && coolingList.contains(locateHover.el);
  if (inActiveList || inCoolingList) {
    locateHover = null;
  }
  // Same problem for the data-tip tooltip — if its target row vanishes,
  // mouseout never fires and the tooltip lingers. Hide it preemptively.
  const tipInActive  = customTipTarget && list.contains(customTipTarget);
  const tipInCooling = coolingList && customTipTarget && coolingList.contains(customTipTarget);
  if (tipInActive || tipInCooling) {
    customTipTarget = null;
    customTip.style.display = 'none';
  }

  // ACTIVE NOW section — hide the heading + list when no active rows.
  // The section wrapper exists in v3 HTML; older HTML has the list directly
  // under #active-now (no per-section toggle needed in that case).
  list.innerHTML = '';
  const activeSection = document.getElementById('active-now-section');
  if (activeSection) {
    activeSection.classList.toggle('empty', activeRows.length === 0);
  }
  for (const s of activeRows) list.appendChild(buildActiveRow(s));

  // RECENTLY ACTIVE section — only present if the HTML has the container.
  if (coolingWrap && coolingList) {
    coolingWrap.classList.toggle('empty', coolingRows.length === 0);
    coolingList.innerHTML = '';
    for (const s of coolingRows) coolingList.appendChild(buildActiveRow(s));
  }
}

// Poll backend /active. Updates activeSystems and triggers re-render of the
// sidebar list. Ring rendering reads activeSystems directly each frame in
// the draw loop, so nothing else needs to be poked here.
async function pollActive() {
  try {
    const r = await fetch(`${intelApiBase()}/active`);
    if (!r.ok) return;
    const body = await r.json();
    if (!body || !Array.isArray(body.systems)) return;
    activeSystems = body.systems;
    renderActiveList();
  } catch {
    // Network blip — the next poll will recover. Keep showing the last list.
  }
}

// Compute the desired ring color for a system right now. Returns a 3-tuple
// RGB array, or null if no ring should render.
//
// Tiers (Option D — decoupled AND-rules):
//   tier1 (yellow): qualifying floor             — small fight
//   tier2 (ember):  ≥15 kills AND ≥3B ISK        — real fleet fight
//   tier3 (red):    ≥30 kills AND ≥10B ISK       — major event / eviction
// Both dimensions must clear independently to promote a tier — many cheap
// kills alone (frigate-blob roams) no longer push score into ember.
//
// During cooling, the tier descends from frozenTier (snapshot at cool-start
// by the backend) through cooler tiers over the LINGER_MS window. Cooling
// tiers win over focused cyan — focus is orthogonal to fight state.
// Focused-but-not-hot-and-not-cooling systems use cyan.
function desiredRingColor(systemId) {
  const sys = activeSystems.find(s => s.systemId === systemId);
  if (sys) {
    if (sys.state === 'cooling') {
      // Snap-step through tiers. Start tier comes from frozenTier; descend
      // to lower tiers at thirds of the linger window. Tier1-start fights
      // hold yellow the whole linger.
      const ratio = clamp((Date.now() / 1000 - sys.cooledAt) * 1000 / COOLING_LINGER_MS, 0, 1);
      const frozen = sys.frozenTier || 'tier1';
      if (frozen === 'tier3') {
        if (ratio < 0.34) return ACTIVE_RING_COLOR_TIER3;
        if (ratio < 0.67) return ACTIVE_RING_COLOR_TIER2;
        return ACTIVE_RING_COLOR_TIER1;
      }
      if (frozen === 'tier2') {
        if (ratio < 0.5) return ACTIVE_RING_COLOR_TIER2;
        return ACTIVE_RING_COLOR_TIER1;
      }
      return ACTIVE_RING_COLOR_TIER1;
    }
    // state === 'active'. Use cluster fields (v3) when present, fall back
    // to 15-min fields (during the brief cross-deploy gap).
    const kc  = sys.clusterKillCount ?? sys.killCount;
    const isk = sys.clusterTotalIsk  ?? sys.totalIsk ?? 0;
    if (kc >= ACTIVE_RING_TIER3_KILLS && isk >= ACTIVE_RING_TIER3_ISK) return ACTIVE_RING_COLOR_TIER3;
    if (kc >= ACTIVE_RING_TIER2_KILLS && isk >= ACTIVE_RING_TIER2_ISK) return ACTIVE_RING_COLOR_TIER2;
    return ACTIVE_RING_COLOR_TIER1;
  }
  if (focusedSystemId === systemId) return ACTIVE_RING_COLOR_FOCUSED;
  return null;
}

// Compute the desired alpha (target) for a system's ring right now.
//   - active rings:  ACTIVE_RING_ALPHA (peak), with hot fade-in/out smoothing.
//   - cooling rings: linear fade from ACTIVE_RING_ALPHA down to
//                    ACTIVE_RING_COOLING_ALPHA_MIN over COOLING_LINGER_MS.
//   - focused-only:  ACTIVE_RING_ALPHA (snap, no fade).
function desiredRingAlpha(systemId) {
  const sys = activeSystems.find(s => s.systemId === systemId);
  if (sys) {
    if (sys.state === 'cooling') {
      const ratio = clamp((Date.now() / 1000 - sys.cooledAt) * 1000 / COOLING_LINGER_MS, 0, 1);
      return ACTIVE_RING_ALPHA - (ACTIVE_RING_ALPHA - ACTIVE_RING_COOLING_ALPHA_MIN) * ratio;
    }
    return ACTIVE_RING_ALPHA;
  }
  if (focusedSystemId === systemId) return ACTIVE_RING_ALPHA;
  return 0;
}

// Draws yellow rings on hot systems and cyan rings on focused-but-not-hot
// systems. Called from the main draw loop AFTER stars and Thera arcs but
// BEFORE kill ring pulses (so kill events stay visible on top during fights).
// Per-system state (alpha, color, angle) lives in activeRingState. Entries
// are created on first appearance and pruned after fade-out completes.
function drawHotSystemRings(now) {
  // Settings toggle gates the entire ring rendering. The active-list sidebar
  // and detector polling stay running — only map decoration is hidden.
  if (!showActiveRings) return;
  // Build the union of systemIds that need a ring this frame.
  const ids = new Set();
  for (const s of activeSystems) ids.add(s.systemId);
  if (focusedSystemId != null) ids.add(focusedSystemId);
  // Also include systems already in the state map that may still be fading out.
  for (const id of activeRingState.keys()) ids.add(id);

  for (const systemId of ids) {
    const star = starById.get(systemId);
    if (!star) continue;

    let st = activeRingState.get(systemId);
    if (!st) {
      st = {
        angle: Math.random() * Math.PI * 2,  // randomized initial angle
        alphaCurrent: 0,
        color: desiredRingColor(systemId) || ACTIVE_RING_COLOR_TIER1,
        // Smooth color shift when hot⇄focused transitions happen. While
        // colorShiftStart is set, the color RGB interpolates from
        // colorShiftFrom to colorShiftTo over ACTIVE_RING_COLOR_SHIFT_MS.
        colorShiftStart: 0,
        colorShiftFrom: null,
        colorShiftTo:   null,
        lastFrameTime:  now,
      };
      activeRingState.set(systemId, st);
    }

    // Time delta since last frame (for rotation + alpha animation).
    const dt = Math.max(0, now - (st.lastFrameTime || now));
    st.lastFrameTime = now;

    // Rotation — clockwise, ACTIVE_RING_ROTATION_MS per turn.
    st.angle += (Math.PI * 2) * (dt / ACTIVE_RING_ROTATION_MS);
    if (st.angle > Math.PI * 2) st.angle -= Math.PI * 2;

    const targetColor = desiredRingColor(systemId);
    const targetAlpha = desiredRingAlpha(systemId);

    // Alpha interpolation. Rule:
    //  - state==='active'  → fade in/out (smooth) toward ACTIVE_RING_ALPHA.
    //  - state==='cooling' → snap to targetAlpha (which already encodes the
    //                        linear linger fade in desiredRingAlpha).
    //  - focused-only / vanished → snap to targetAlpha (covers cyan + 0).
    // The 30-min linger cutoff: when the backend removes a cooling system
    // entirely, sys becomes undefined → targetAlpha=0 → ring snaps to
    // invisible. Per spec: "ring vanishes instantly, not faded to zero."
    const sys = activeSystems.find(s => s.systemId === systemId);
    if (sys?.state === 'active') {
      const fadeMs = targetAlpha > st.alphaCurrent ? ACTIVE_RING_FADE_IN_MS : ACTIVE_RING_FADE_OUT_MS;
      const step = dt / fadeMs;
      if (targetAlpha > st.alphaCurrent) {
        st.alphaCurrent = Math.min(targetAlpha, st.alphaCurrent + step * ACTIVE_RING_ALPHA);
      } else {
        st.alphaCurrent = Math.max(targetAlpha, st.alphaCurrent - step * ACTIVE_RING_ALPHA);
      }
    } else {
      st.alphaCurrent = targetAlpha;
    }

    // Color shift handling. When the desired color differs from the current
    // resting color and we're not already shifting, kick off a transition.
    if (targetColor) {
      const from = st.colorShiftTo || st.color;
      const same = from && from[0] === targetColor[0] && from[1] === targetColor[1] && from[2] === targetColor[2];
      if (!same && !st.colorShiftStart) {
        st.colorShiftStart = now;
        st.colorShiftFrom = from;
        st.colorShiftTo   = targetColor;
      }
    }
    let renderColor = st.color;
    if (st.colorShiftStart) {
      const t = Math.min(1, (now - st.colorShiftStart) / ACTIVE_RING_COLOR_SHIFT_MS);
      renderColor = [
        Math.round(st.colorShiftFrom[0] + (st.colorShiftTo[0] - st.colorShiftFrom[0]) * t),
        Math.round(st.colorShiftFrom[1] + (st.colorShiftTo[1] - st.colorShiftFrom[1]) * t),
        Math.round(st.colorShiftFrom[2] + (st.colorShiftTo[2] - st.colorShiftFrom[2]) * t),
      ];
      if (t >= 1) {
        st.color = st.colorShiftTo;
        st.colorShiftStart = 0;
        st.colorShiftFrom  = null;
        st.colorShiftTo    = null;
      }
    } else if (targetColor) {
      st.color = targetColor;
      renderColor = targetColor;
    }

    // Skip drawing if effectively invisible (and prune the state if it's
    // also at target zero — no further animation to drive).
    if (st.alphaCurrent < 0.01 && targetAlpha === 0) {
      activeRingState.delete(systemId);
      continue;
    }
    if (st.alphaCurrent < 0.01) continue;

    const p = worldToScreen(star.x, star.y);
    // Cull if offscreen (saves work during pan/zoom away from hot cluster).
    if (p.x < -50 || p.x > window.innerWidth + 50 || p.y < -50 || p.y > window.innerHeight + 50) continue;

    // Screen-pixel sizing — the ring stays the same on-screen size at any
    // zoom level. Without this, the ring would shrink to invisibility when
    // zoomed out. Mirrors the kill-ring pulse pattern.
    const zoomK = clamp(camera.scale, 0.5, 1.8);
    const radius = ACTIVE_RING_RADIUS_PX / zoomK;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(p.x, p.y);
    ctx.rotate(st.angle);
    ctx.setLineDash(ACTIVE_RING_DASH);
    ctx.lineWidth = ACTIVE_RING_LINEWIDTH;
    ctx.strokeStyle = `rgba(${renderColor[0]}, ${renderColor[1]}, ${renderColor[2]}, ${st.alphaCurrent})`;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ─── Killfeed focus mode ─────────────────────────────────────────────────
//
// When focused on a system, the live kill list filters to only that system.
// Map animations stay global. Header label gets a bold yellow J-code prefix.
// Persistence is none in v1 — focus resets on page reload.

function setKillFocus(systemId) {
  const wasFocused = focusedSystemId != null;
  focusedSystemId = systemId;
  // Show/hide the exit "<" back button in the kill header. Inverted: the
  // decorative ">" prefix shows in global mode, hides while focused.
  const exitBtn = document.getElementById('kill-focus-exit');
  if (exitBtn) exitBtn.style.display = systemId != null ? '' : 'none';
  const globalPrefix = document.getElementById('kill-global-prefix');
  if (globalPrefix) globalPrefix.style.display = systemId != null ? 'none' : '';

  if (systemId != null) {
    // Entering or switching focus — fetch from /intel and render paginated.
    enterFocusMode(systemId);
  } else if (wasFocused) {
    // Exiting focus — restore global mode.
    exitFocusMode();
  }
  // Update header label (live + focused or just live).
  updateKillHeaderLabel();
  updateKillCount();
}

// Returns the J-code string for the focused system, or null. Resolves via
// the existing star map — ANOIKIS_SYSTEMS already loaded.
function focusedSystemName() {
  if (focusedSystemId == null) return null;
  const star = starById.get(focusedSystemId);
  return star ? displayName(star) : null;
}

// Render the kill panel header label with the optional J-code prefix.
// Called from setKillView() and setKillFocus(). Replaces the previous
// direct textContent assignments.
function updateKillHeaderLabel() {
  const suffix = killViewMode === 'history' ? 'Killfeed History' : 'Killfeed Online';
  const jcode = focusedSystemName();
  if (jcode) {
    killHeaderLabelEl.innerHTML =
      `<span class="killfeed-focus-jcode">${escapeHtml(jcode)}</span>${escapeHtml(suffix)}`;
  } else {
    killHeaderLabelEl.textContent = suffix;
  }
}

// Rebuild the live kill list DOM from the buffer, applying the current
// focus filter. Called when entering or exiting focus, or when toggling
// to live view. Preserves chronological order (newest at top).
function rebuildKillListFromBuffer() {
  killList.innerHTML = '';
  const liveSlice = killBuffer.slice(0, MAX_KILLS);
  for (let i = liveSlice.length - 1; i >= 0; i--) {
    const { kill, star } = liveSlice[i];
    if (focusedSystemId != null && kill.systemId !== focusedSystemId) continue;
    const el = buildKillElement(killToParams(kill, star));
    killList.insertBefore(el, killList.firstChild);
  }
}

function renderTheraConnectionList() {
  const el = document.getElementById('si-thera-connections');
  const wrap = document.getElementById('si-thera-links');
  if (!el || !wrap) return;
  if (!selected) {
    wrap.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const isThera = selected.whClass === 'Thera';
  const matching = isThera
    ? theraConnections
    : theraConnections.filter(c => c.in_system_id === selected.id);
  if (!isThera && !matching.length) {
    wrap.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  wrap.style.display = '';
  if (!matching.length) {
    el.innerHTML = '<div class="si-thera-empty">No active connections</div>';
    return;
  }
  const rows = matching.slice().sort((a, b) => a.wh_type.localeCompare(b.wh_type));
  const theraStar = isThera ? null : starById.get(THERA_SYSTEM_ID);
  el.innerHTML = '';
  for (const c of rows) {
    const row = document.createElement('div');
    row.className = 'si-thera-row';
    const color = theraSizeColor(c.max_ship_size);
    // Nav jumps to whichever end of the connection isn't currently selected.
    const dest = isThera ? starById.get(c.in_system_id) : theraStar;
    row.dataset.systemId = String(dest ? dest.id : '');

    let otherName, otherClass;
    if (isThera) {
      const destStar = starById.get(c.in_system_id);
      otherName = c.in_system_name || '';
      otherClass = destStar ? displayClass(destStar) : (c.in_system_class || '');
    } else {
      otherName = 'Thera';
      otherClass = theraStar ? displayClass(theraStar) : 'C12';
    }
    // Arrow always points away from the panel's system. The connection's
    // `wh_exits_outward` is recorded from Thera's frame, so the non-Thera
    // panel sees the inverse.
    const arrowRight = isThera ? c.wh_exits_outward : !c.wh_exits_outward;

    const typeLink = document.createElement('a');
    typeLink.className = 'si-thera-type';
    typeLink.href = `https://whtype.info?type=${encodeURIComponent(c.wh_type)}`;
    typeLink.target = '_blank';
    typeLink.rel = 'noopener noreferrer';
    typeLink.style.color = color;
    typeLink.textContent = c.wh_type;

    const navBtn = document.createElement('button');
    navBtn.type = 'button';
    navBtn.className = 'si-thera-nav';
    navBtn.innerHTML =
      `<span class="si-thera-dir">${arrowRight ? '&gt;' : '&lt;'}</span>`
      + `<span class="si-thera-jcode">${escapeHtml(otherName)}</span>`
      + `<span class="si-thera-class">${escapeHtml(otherClass)}</span>`;
    // Clear hover state on commit — without this the cursor is still
    // physically over the row after click, so `theraHoverId` / `locateHover`
    // stay set and the arc + star glow linger until the user manually moves
    // the mouse off the row. Applies to both nav click (flies to dest) and
    // the type link (opens whtype in a new tab; on tab-return the state
    // would otherwise still be live).
    function clearTheraHover() {
      if (theraHoverId === c.id) theraHoverId = null;
      if (locateHover && locateHover.el === row) locateHover = null;
    }
    typeLink.addEventListener('click', clearTheraHover);
    navBtn.addEventListener('click', () => {
      clearTheraHover();
      if (dest) selectStar(dest, true);
    });

    row.appendChild(typeLink);
    row.appendChild(navBtn);

    // Hover-isolate + locate-glow are desktop-only. On touch devices browsers
    // fire mouseenter on tap and the hover state sticks until the next tap,
    // which would highlight a row every time the user tried to jump to a
    // system. The type link remains tappable independently.
    if (!_isMobile) {
      row.addEventListener('mouseenter', () => {
        theraHoverId = c.id;
        // Reuse the kill-feed locate-trace effect: dashed line from the row to
        // the destination star + additive glow + solid dot in the star's colour.
        if (dest) locateHover = { el: row, star: dest, noTrace: true };
      });
      row.addEventListener('mouseleave', () => {
        if (theraHoverId === c.id) theraHoverId = null;
        if (locateHover && locateHover.el === row) locateHover = null;
      });
    }

    el.appendChild(row);
  }
}

// --- Region & constellation bounding-box centers for label LOD -----
const regionBounds = new Map();
const constBounds = new Map();
for (const s of stars) {
  // Regions
  if (!regionBounds.has(s.regionName)) regionBounds.set(s.regionName, { minX: s.x, maxX: s.x, minY: s.y, maxY: s.y });
  else {
    const rb = regionBounds.get(s.regionName);
    if (s.x < rb.minX) rb.minX = s.x; if (s.x > rb.maxX) rb.maxX = s.x;
    if (s.y < rb.minY) rb.minY = s.y; if (s.y > rb.maxY) rb.maxY = s.y;
  }
  // Constellations
  if (!constBounds.has(s.constellation)) constBounds.set(s.constellation, { minX: s.x, maxX: s.x, minY: s.y, maxY: s.y });
  else {
    const cb = constBounds.get(s.constellation);
    if (s.x < cb.minX) cb.minX = s.x; if (s.x > cb.maxX) cb.maxX = s.x;
    if (s.y < cb.minY) cb.minY = s.y; if (s.y > cb.maxY) cb.maxY = s.y;
  }
}
function shortLabel(name) {
  return name.replace(/(-[RC])0+(\d)/, '$1$2');
}
const regionLabels = [];
for (const [name, b] of regionBounds) {
  regionLabels.push({ name: shortLabel(name), key: name, x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
}
const constLabels = [];
for (const [name, b] of constBounds) {
  constLabels.push({ name: shortLabel(name), key: name, x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
}

// Clickable label hit areas (rebuilt every frame)
const labelHits = [];  // {x1, y1, x2, y2, type: 'region'|'const', key: originalName}

function zoomToBounds(minX, minY, maxX, maxY, maxZoom) {
  const padding = 80;
  const cw = window.innerWidth, ch = window.innerHeight;
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const raw = Math.min((cw - padding * 2) / w, (ch - padding * 2) / h);
  const scale = clamp(raw * 0.75, MIN_SCALE, maxZoom || MAX_SCALE);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  camera.focusAnim = {
    start: performance.now(),
    duration: 380,
    easePow: 4,
    from: { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY },
    to: { scale, offsetX: cw / 2 - cx * scale, offsetY: ch / 2 - cy * scale }
  };
}

// Spatial index for hit testing (grid)
const GRID = 200;
const grid = new Map();
function gridKey(x, y) { return Math.floor(x / GRID) + ',' + Math.floor(y / GRID); }
for (const s of stars) {
  const k = gridKey(s.x, s.y);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(s);
}
function starsNear(wx, wy, wRadius) {
  const out = [];
  const gx0 = Math.floor((wx - wRadius) / GRID);
  const gx1 = Math.floor((wx + wRadius) / GRID);
  const gy0 = Math.floor((wy - wRadius) / GRID);
  const gy1 = Math.floor((wy + wRadius) / GRID);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const bucket = grid.get(gx + ',' + gy);
      if (bucket) for (const s of bucket) out.push(s);
    }
  }
  return out;
}

// --- Sprite cache (glow for each class) -------------------------
const SPRITE_SIZE = 128;
const spriteCache = {};
function rgba(arr, a) { return `rgba(${arr[0]},${arr[1]},${arr[2]},${a})`; }
function buildSprite(color) {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_SIZE;
  const sctx = c.getContext('2d');
  const cx = SPRITE_SIZE / 2, cy = SPRITE_SIZE / 2;
  const outer = sctx.createRadialGradient(cx, cy, 0, cx, cy, SPRITE_SIZE * 0.48);
  outer.addColorStop(0.00, rgba(color, 0.22));
  outer.addColorStop(0.20, rgba(color, 0.14));
  outer.addColorStop(0.45, rgba(color, 0.075));
  outer.addColorStop(1.00, 'rgba(255,255,255,0)');
  sctx.fillStyle = outer;
  sctx.beginPath();
  sctx.arc(cx, cy, SPRITE_SIZE * 0.48, 0, Math.PI * 2);
  sctx.fill();
  sctx.save();
  sctx.shadowBlur = 20;
  sctx.shadowColor = rgba(color, 0.9);
  sctx.fillStyle = 'rgba(255,255,255,0.95)';
  sctx.beginPath();
  sctx.arc(cx, cy, 7, 0, Math.PI * 2);
  sctx.fill();
  sctx.restore();
  sctx.fillStyle = 'rgba(255,255,255,0.98)';
  sctx.beginPath();
  sctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
  sctx.fill();
  return c;
}
for (const cls of Object.keys(CLASS_COLORS)) spriteCache[cls] = buildSprite(CLASS_COLORS[cls]);

// --- Orrery (solar system view) ----------------------------------
const orreryPanel  = document.getElementById('panel-orrery');
const orreryCanvas = document.getElementById('orrery-canvas');
const orreryTip    = document.getElementById('orrery-tip');
const orreryCtx    = orreryCanvas.getContext('2d');
let orreryOpen       = false;
let orreryRotate     = false;
let orreryProjection = 'orrery'; // 'orrery' (log-scaled) | 'map' (true XZ projection)
let orreryHits       = []; // [{x,y,hitR,typeId,ci,moons,isSun}] — rebuilt each draw frame
let orreryListHover  = null; // { imgEl, isSun, ci } — set when hovering a list row

const ROMAN = ['','I','II','III','IV','V','VI','VII','VIII','IX','X',
               'XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];
function toRoman(n) { return ROMAN[n] || String(n); }

// Hardcoded EVE planet typeID → {name, rgb}.
// TYPE_NAMES only covers ships/structures — planet types aren't included there.
// Colors approximate the EVE icon sphere for each planet type.
const PLANET_TYPES = {
  11:    { name: 'Temperate', rgb: [ 82, 112,  70] },  // muted blue-green, Earth-like
  12:    { name: 'Ice',       rgb: [188, 215, 228] },  // pale icy blue-white
  13:    { name: 'Gas',       rgb: [148, 122,  90] },  // grey-brown, Jupiter-ish
  2014:  { name: 'Oceanic',   rgb: [ 38,  95, 162] },  // deep ocean blue
  2015:  { name: 'Lava',      rgb: [212,  55,  16] },  // fiery orange-red
  2016:  { name: 'Barren',    rgb: [122,  92,  68] },  // dusty brown, Mars-like
  2017:  { name: 'Storm',     rgb: [ 62,  82, 128] },  // dark stormy blue-grey
  2063:  { name: 'Plasma',    rgb: [ 40, 150, 255] },  // electric blue
  30889: { name: 'Shattered', rgb: [ 86,  82,  78] },  // dark fractured grey
};

// Sun typeID → RGB. Grouped by spectral class.
const SUN_COLORS = {
  // G5 Yellow
  6: [255,228,110], 3802: [255,228,110], 45030: [255,210,90], 45041: [255,228,110], 45047: [255,150,40],
  // K Orange
  7: [255,152,52], 45031: [255,140,45], 45032: [255,152,52],
  3798: [255,162,62], 3800: [255,142,48], 45037: [255,162,62], 45039: [255,130,42], 45040: [255,142,48],
  // K5 Red Giant
  8: [255,72,22], 45033: [255,72,22],
  // B0 Blue
  9: [112,182,255], 45034: [112,182,255], 45046: [112,182,255],
  // F0 White — #10 (F0) swapped with #45042 (B5 White Dwarf)
  10: [192,218,255], 45035: [255,250,218],
  // O1 Bright Blue
  3796: [72,142,255],
  // G5 Pink — 45036/45038 shifted to pale lavender (white-purple)
  3797: [225,210,245], 3799: [245,210,240], 45036: [244,178,226], 45038: [205,180,240],
  // A0 Blue Small
  3801: [152,192,255], 34331: [200,188,248],
  // B5 White Dwarf — #45042 swapped with #10
  3803: [192,218,255], 45042: [255,255,250],
};

// Sun typeID → display name (from SDE types.jsonl).
const SUN_NAMES = {
  6: 'Sun G5 (Yellow)', 7: 'Sun K7 (Orange)', 8: 'Sun K5 (Red Giant)',
  9: 'Sun B0 (Blue)', 10: 'Sun F0 (White)', 3796: 'Sun O1 (Bright Blue)',
  3797: 'Sun G5 (Pink)', 3798: 'Sun K5 (Orange Bright)', 3799: 'Sun G3 (Pink Small)',
  3800: 'Sun M0 (Orange Radiant)', 3801: 'Sun A0 (Blue Small)', 3802: 'Sun K3 (Yellow Small)',
  3803: 'Sun B5 (White Dwarf)', 34331: 'Sun A0IV (Turbulent Blue Subgiant)',
  45030: 'Sun G5 (Yellow)', 45031: 'Sun K7 (Orange)', 45032: 'Sun K7 (Orange)',
  45033: 'Sun K5 (Red Giant)', 45034: 'Sun B0 (Blue)', 45035: 'Sun F0 (White)',
  45036: 'Sun G5 (Pink)', 45037: 'Sun K5 (Orange Bright)', 45038: 'Sun G3 (Pink Small)',
  45039: 'Sun M0 (Orange Radiant)', 45040: 'Sun M0 (Orange Radiant)', 45041: 'Sun K3 (Yellow Small)',
  45042: 'Sun B5 (White Dwarf)', 45046: 'Sun B0 (Blue)', 45047: 'Sun G5 (Yellow)',
};

function planetRGB(typeId) { return (PLANET_TYPES[typeId] || {}).rgb || [160, 160, 160]; }
function planetTypeName(typeId) { return (PLANET_TYPES[typeId] || {}).name || 'Unknown'; }

// Sun-coloured sprite cache for the 'eve' palette. One sprite per unique sun
// typeID in SUN_COLORS. Built lazily so unused types don't allocate.
const EVE_FALLBACK = [255, 228, 110];
const sunSpriteCache = {};
function sunSpriteFor(sunTypeId) {
  const key = sunTypeId != null && SUN_COLORS[sunTypeId] ? sunTypeId : '_';
  if (!sunSpriteCache[key]) {
    sunSpriteCache[key] = buildSprite(SUN_COLORS[sunTypeId] || EVE_FALLBACK);
  }
  return sunSpriteCache[key];
}
function sunColorFor(sunTypeId) {
  return SUN_COLORS[sunTypeId] || EVE_FALLBACK;
}

// Star → sprite / RGB, branched on the active palette.
function starSprite(star) {
  return currentPalette === 'eve' ? sunSpriteFor(star.sunTypeId) : spriteCache[star.whClass];
}
function starColor(star) {
  return currentPalette === 'eve' ? sunColorFor(star.sunTypeId) : (CLASS_COLORS[star.whClass] || [0, 200, 200]);
}

function drawOrrery(star) {
  const DPR_O = Math.min(window.devicePixelRatio || 1, 2);
  const CSS   = Math.round(orreryCanvas.clientWidth) || 260;
  if (orreryCanvas.width !== CSS * DPR_O || orreryCanvas.height !== CSS * DPR_O) {
    orreryCanvas.width  = CSS * DPR_O;
    orreryCanvas.height = CSS * DPR_O;
  }

  const oc  = orreryCtx;
  const cx  = CSS / 2;
  const cy  = CSS / 2;
  const now = Date.now();

  oc.save();
  oc.scale(DPR_O, DPR_O);
  oc.clearRect(0, 0, CSS, CSS);

  const planets = star.planets;
  orreryHits = [];

  if (!planets || !planets.length) {
    oc.fillStyle = '#3d8888';
    oc.font = '11px Roboto Mono, monospace';
    oc.textAlign = 'center';
    oc.textBaseline = 'middle';
    oc.fillText('No planet data', cx, cy - 8);
    oc.fillText('Rebuild SDE to enable', cx, cy + 10);
    oc.restore();
    return;
  }

  // --- Compute per-planet orbit radius (px) and angular position ---
  const t = now * 0.0001; // slow time base for optional rotation

  let positions; // [{px, py, rr}] — planet screen pos + orbit-circle radius
  let refRingPx; // pixel radius of the 14.3 AU reference ring

  if (orreryProjection === 'map') {
    // True XZ projection: linear scale, outermost planet at 90% of half-canvas.
    const maxR     = Math.max(planets.reduce((m, p) => Math.max(m, p.r || 0), 0), 14.3);
    const mapScale = (cx * 0.90) / maxR;
    refRingPx = 14.3 * mapScale;
    positions = planets.map((p, i) => {
      const base  = (p.a != null ? p.a : (i / planets.length) * Math.PI * 2) + Math.PI;
      const omega = 1.0 / Math.pow(Math.max(p.r, 0.1), 0.75);
      const angle = orreryRotate ? base + t * omega : base;
      const rr    = (p.r || 0) * mapScale;
      return { px: cx + Math.cos(angle) * rr, py: cy + Math.sin(angle) * rr, rr };
    });
  } else {
    // Orrery: log-scaled so all planets are visually separated.
    const logRs  = planets.map(p => Math.log10(Math.max(p.r, 0.01)));
    const logMin = Math.min(...logRs);
    const logMax = Math.max(Math.max(...logRs), Math.log10(14.3));
    const innerPx = Math.round(CSS * 0.085);
    const outerPx = Math.round(cx - CSS * 0.04);
    const orbitPx = logR => {
      if (logMax === logMin) return (innerPx + outerPx) / 2;
      return innerPx + ((logR - logMin) / (logMax - logMin)) * (outerPx - innerPx);
    };
    refRingPx = orbitPx(Math.log10(14.3));
    positions = planets.map((p, i) => {
      const rr    = orbitPx(logRs[i]);
      const base  = (p.a != null ? p.a : (i / planets.length) * Math.PI * 2) + Math.PI;
      const omega = 1.0 / Math.pow(Math.max(p.r, 0.1), 0.75);
      const angle = orreryRotate ? base + t * omega : base;
      return { px: cx + Math.cos(angle) * rr, py: cy + Math.sin(angle) * rr, rr };
    });
  }

  // Orbit tracks.
  oc.strokeStyle = 'rgba(0,200,200,0.32)';
  oc.lineWidth   = 1;
  for (const pos of positions) {
    oc.beginPath();
    oc.arc(cx, cy, pos.rr, 0, Math.PI * 2);
    oc.stroke();
  }

  // 14.3 AU scan-range reference circle.
  if (refRingPx > 4) {
    oc.save();
    oc.strokeStyle = 'rgba(255,195,60,0.65)';
    oc.lineWidth   = 1.2;
    oc.setLineDash([5, 4]);
    oc.beginPath();
    oc.arc(cx, cy, refRingPx, 0, Math.PI * 2);
    oc.stroke();
    oc.setLineDash([]);
    if (refRingPx < cx - CSS * 0.04 + 24) {
      oc.fillStyle    = 'rgba(255,195,60,0.80)';
      oc.font         = '9px Roboto Mono, monospace';
      oc.textAlign    = 'center';
      oc.textBaseline = 'bottom';
      oc.fillText('14.3 AU', cx, cy - refRingPx - 2);
    }
    oc.restore();
  }

  // Sun glow — colour driven by spectral type.
  const sc   = SUN_COLORS[star.sunTypeId] || [255, 228, 110];
  const sunR = Math.round(CSS * 0.054);
  const sunG = oc.createRadialGradient(cx, cy, 0, cx, cy, sunR);
  sunG.addColorStop(0,    'rgba(255,255,255,1)');
  sunG.addColorStop(0.22, rgba(sc, 0.9));
  sunG.addColorStop(0.65, rgba(sc, 0.35));
  sunG.addColorStop(1,    rgba(sc, 0));
  oc.fillStyle = sunG;
  oc.beginPath();
  oc.arc(cx, cy, sunR, 0, Math.PI * 2);
  oc.fill();
  oc.fillStyle = 'rgba(255,255,255,0.97)';
  oc.beginPath();
  oc.arc(cx, cy, Math.max(2, CSS * 0.013), 0, Math.PI * 2);
  oc.fill();
  orreryHits.push({ x: cx, y: cy, hitR: sunR * 0.55, isSun: true, sunTypeId: star.sunTypeId });

  // Planets.
  for (let i = 0; i < planets.length; i++) {
    const p             = planets[i];
    const { px, py }    = positions[i];
    const [pr, pg, pb]  = planetRGB(p.typeId);
    const pR            = 4;
    const omega         = 1.0 / Math.pow(Math.max(p.r, 0.1), 0.75);

    const glow = oc.createRadialGradient(px, py, 0, px, py, pR * 3);
    glow.addColorStop(0, `rgba(${pr},${pg},${pb},0.5)`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    oc.fillStyle = glow;
    oc.beginPath();
    oc.arc(px, py, pR * 3, 0, Math.PI * 2);
    oc.fill();

    oc.fillStyle = `rgb(${pr},${pg},${pb})`;
    oc.beginPath();
    oc.arc(px, py, pR, 0, Math.PI * 2);
    oc.fill();

    const mAngles   = p.mA || [];
    const moonCount = Math.min(mAngles.length || (p.moons || 0), 6);
    for (let m = 0; m < moonCount; m++) {
      const mBase  = mAngles[m] != null ? mAngles[m] : (m / moonCount) * Math.PI * 2;
      const mDist  = pR + 5 + m * 2.5;
      const mOmega = 250 / Math.pow(mDist, 1.5);
      const mAngle = orreryRotate ? mBase + t * mOmega : mBase;
      oc.fillStyle = 'rgba(160,160,160,0.65)';
      oc.beginPath();
      oc.arc(px + Math.cos(mAngle) * mDist, py + Math.sin(mAngle) * mDist, 1.5, 0, Math.PI * 2);
      oc.fill();
    }

    orreryHits.push({ x: px, y: py, hitR: pR + 5, typeId: p.typeId, ci: p.ci || 0, moons: p.moons || 0 });
  }

  oc.restore();
  updateOrreryTrace();
}

// SVG overlay for the list-row hover trace. Drawing on the orrery canvas
// clipped everything past the canvas's right edge, so the segment from the
// list row's image to the canvas border never rendered. An SVG overlay on
// .orrery-body can draw across both the canvas and the list area.
const traceSvgLine  = document.getElementById('orrery-trace-line');
const traceSvgGrad  = document.getElementById('orrery-trace-grad');
const traceSvgStops = traceSvgGrad.querySelectorAll('stop');
const orreryBodyEl  = document.querySelector('.orrery-body');

function updateOrreryTrace() {
  if (!orreryListHover) { traceSvgLine.classList.remove('on'); return; }
  const hit = orreryListHover.isSun
    ? orreryHits.find(h => h.isSun)
    : orreryHits.find(h => !h.isSun && h.ci === orreryListHover.ci);
  if (!hit) { traceSvgLine.classList.remove('on'); return; }
  const bodyRect = orreryBodyEl.getBoundingClientRect();
  const canvRect = orreryCanvas.getBoundingClientRect();
  const imgRect  = orreryListHover.imgEl.getBoundingClientRect();
  const bx = imgRect.left + 4                - bodyRect.left;
  const by = imgRect.top  + imgRect.height / 2 - bodyRect.top;
  const ex = hit.x + (canvRect.left - bodyRect.left);
  const ey = hit.y + (canvRect.top  - bodyRect.top);
  traceSvgLine.setAttribute('x1', bx);
  traceSvgLine.setAttribute('y1', by);
  traceSvgLine.setAttribute('x2', ex);
  traceSvgLine.setAttribute('y2', ey);
  traceSvgGrad.setAttribute('x1', bx);
  traceSvgGrad.setAttribute('y1', by);
  traceSvgGrad.setAttribute('x2', ex);
  traceSvgGrad.setAttribute('y2', ey);
  const endColor = orreryListHover.isSun
    ? `rgba(${(SUN_COLORS[orreryListHover.typeId] || [255,220,100]).join(',')},0.85)`
    : `rgba(${planetRGB(orreryListHover.typeId).join(',')},0.85)`;
  traceSvgStops[0].setAttribute('stop-color', 'rgba(0,200,200,0.85)');
  traceSvgStops[1].setAttribute('stop-color', endColor);
  traceSvgLine.classList.add('on');
}

function updateOrreryHeader(star) {
  document.getElementById('orrery-title').textContent = displayName(star) + ' · ' + displayClass(star);
  document.getElementById('orrery-planet-count').textContent = star.planets.length + ' planet' + (star.planets.length !== 1 ? 's' : '');
}

function buildOrreryList(star) {
  const el = document.getElementById('orrery-list');
  el.innerHTML = '';
  el.onclick = (ev) => {
    if (ev.target.closest('.olist-row--sun')) {
      ev.stopPropagation();
      toggleSunPopup(star);
    }
  };

  function attachRowHover(row, hoverData) {
    const img = row.querySelector('.olist-img');
    if (isTouchDevice) {
      row.addEventListener('click', (ev) => {
        if (hoverData.isSun) return; // sun has its own click handler
        ev.stopPropagation();
        const same = orreryListHover && orreryListHover.ci === hoverData.ci && orreryListHover.isSun === hoverData.isSun;
        orreryListHover = same ? null : { imgEl: img, ...hoverData };
      });
    } else {
      row.addEventListener('mouseenter', () => { orreryListHover = { imgEl: img, ...hoverData }; });
      row.addEventListener('mouseleave', () => { orreryListHover = null; });
    }
  }

  // Sun row.
  if (star.sunTypeId) {
    const row = document.createElement('div');
    row.className = 'olist-row olist-row--sun';
    row.innerHTML =
      `<img class="olist-img" src="https://images.evetech.net/types/${star.sunTypeId}/icon?size=64" alt="" loading="lazy">` +
      `<div><div class="olist-name">${escapeHtml(star.name)} Star</div>` +
      `<div class="olist-sub">${escapeHtml(SUN_NAMES[star.sunTypeId] || 'Sun')}</div></div>`;
    el.appendChild(row);
    if (isTouchDevice) {
      let pop = document.getElementById('sun-popup');
      if (!pop) {
        pop = document.createElement('div');
        pop.id = 'sun-popup';
      } else {
        pop.remove();
      }
      pop.classList.remove('open');
      el.insertBefore(pop, row.nextSibling);
    }
    attachRowHover(row, { isSun: true, typeId: star.sunTypeId });
    if (!isTouchDevice) row.addEventListener('mouseleave', closeSunPopup);
  }

  // Planet rows sorted by celestialIndex.
  const sorted = [...star.planets].sort((a, b) => (a.ci || 0) - (b.ci || 0));
  for (const p of sorted) {
    const roman   = p.ci ? toRoman(p.ci) : '?';
    const type    = planetTypeName(p.typeId);
    const moons   = p.moons || 0;
    const moonStr = moons === 0 ? 'no moons' : moons + ' moon' + (moons !== 1 ? 's' : '');
    const row = document.createElement('div');
    row.className = 'olist-row';
    row.innerHTML =
      `<img class="olist-img" src="https://images.evetech.net/types/${p.typeId}/icon?size=64" alt="" loading="lazy">` +
      `<div><div class="olist-name">${escapeHtml(star.name)} ${roman}</div>` +
      `<div class="olist-sub">${escapeHtml(type)} · ${moonStr}</div></div>`;
    el.appendChild(row);
    attachRowHover(row, { isSun: false, ci: p.ci, typeId: p.typeId });
  }
}

function formatSunAge(ageSeconds) {
  const years = ageSeconds / 31557600;
  if (years >= 1e9) {
    const bn = years / 1e9;
    return (bn >= 10 ? Math.round(bn) : bn.toFixed(1).replace('.', ',')) + ' billion years';
  }
  return Math.round(years / 1e6) + ' million years';
}
function formatSunRadius(meters) {
  const km = Math.round(meters / 1000);
  return km.toLocaleString('de-DE') + ' km';
}
function formatSunLuminosity(lum) {
  return lum.toFixed(2).replace('.', ',');
}
function toggleSunPopup(star) {
  const pop = document.getElementById('sun-popup');
  if (pop.classList.contains('open') && pop.dataset.sysId === String(star.id)) {
    pop.classList.remove('open');
    return;
  }
  const s = star.sun || {};
  pop.dataset.sysId = String(star.id);
  pop.innerHTML =
    `<div class="sun-popup-row"><b>Spectral class:</b> ${escapeHtml(s.spectralClass || '—')}</div>` +
    `<div class="sun-popup-row"><b>Luminosity:</b> ${s.luminosity != null ? formatSunLuminosity(s.luminosity) : '—'}</div>` +
    `<div class="sun-popup-row"><b>Age:</b> ${s.age != null ? formatSunAge(s.age) : '—'}</div>` +
    `<div class="sun-popup-row"><b>Radius:</b> ${s.radius != null ? formatSunRadius(s.radius) : '—'}</div>` +
    `<div class="sun-popup-row"><b>Temperature:</b> ${s.temperature != null ? Math.round(s.temperature) + 'K' : '—'}</div>`;
  pop.classList.add('open');
}
function closeSunPopup() {
  const pop = document.getElementById('sun-popup');
  if (pop) pop.classList.remove('open');
}

function openOrrery(star) {
  if (intelOpen) closeIntel();
  orreryOpen = true;
  orreryPanel.classList.add('open');
  if (isTouchDevice) document.getElementById('panel-left').classList.add('panel--hidden');
  updateOrreryHeader(star);
  buildOrreryList(star);
  document.getElementById('si-system-view').classList.add('active');
}

function closeOrrery() {
  const wasOpen = orreryOpen;
  orreryOpen      = false;
  orreryListHover = null;
  orreryRotate    = false;
  const rotBtn = document.getElementById('orrery-rotate-btn');
  rotBtn.textContent = 'Rotation: Off';
  rotBtn.classList.remove('on');
  orreryPanel.classList.remove('open');
  if (isTouchDevice && wasOpen) document.getElementById('panel-left').classList.remove('panel--hidden');
  orreryTip.textContent = '';
  closeSunPopup();
  document.getElementById('si-system-view').classList.remove('active');
}

document.getElementById('close-orrery').addEventListener('click', closeOrrery);

document.getElementById('orrery-proj-orrery').addEventListener('click', () => {
  orreryProjection = 'orrery';
  document.getElementById('orrery-proj-orrery').classList.add('on');
  document.getElementById('orrery-proj-map').classList.remove('on');
});
document.getElementById('orrery-proj-map').addEventListener('click', () => {
  orreryProjection = 'map';
  document.getElementById('orrery-proj-map').classList.add('on');
  document.getElementById('orrery-proj-orrery').classList.remove('on');
});

document.getElementById('si-system-view').addEventListener('click', () => {
  if (!selected) return;
  if (orreryOpen) closeOrrery();
  else openOrrery(selected);
});

document.getElementById('orrery-rotate-btn').addEventListener('click', (e) => {
  orreryRotate = !orreryRotate;
  e.currentTarget.textContent = orreryRotate ? 'Rotation: On' : 'Rotation: Off';
  e.currentTarget.classList.toggle('on', orreryRotate);
});

orreryCanvas.addEventListener('mousemove', (e) => {
  const rect = orreryCanvas.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;
  let hit = null;
  for (const h of orreryHits) {
    const dx = mx - h.x, dy = my - h.y;
    if (dx*dx + dy*dy < h.hitR * h.hitR) { hit = h; break; }
  }
  if (hit) {
    if (hit.isSun) {
      orreryTip.textContent = SUN_NAMES[hit.sunTypeId] || 'Star';
    } else {
      const sysName = selected ? selected.name : '';
      const roman   = hit.ci ? toRoman(hit.ci) : '?';
      const moonStr = hit.moons === 0 ? 'no moons' : hit.moons + ' moon' + (hit.moons !== 1 ? 's' : '');
      orreryTip.textContent = sysName + ' ' + roman + ' · ' + planetTypeName(hit.typeId) + ' · ' + moonStr;
    }
  } else {
    orreryTip.textContent = '';
  }
});

orreryCanvas.addEventListener('mouseleave', () => { orreryTip.textContent = ''; });

// --- Intel panel ------------------------------------------------
const intelPanel = document.getElementById('panel-intel');
let intelOpen    = false;

const DAY_LABELS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAY_ORDER   = [1,2,3,4,5,6,0]; // Mon–Sun display order

function heatColor(count, max, rgb) {
  if (count === 0 || max === 0) return '#0d1f1f';
  const t = Math.sqrt(count / max); // sqrt scale: small values still visible
  const [r, g, b] = rgb;
  return `rgb(${Math.round(13 + t*(r-13))},${Math.round(31 + t*(g-31))},${Math.round(31 + t*(b-31))})`;
}

function utcToLocalHour(utcH) {
  const offsetMin = new Date().getTimezoneOffset();
  return ((utcH - offsetMin / 60) % 24 + 24) % 24;
}

const DOW_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Update existing heatmap cells in place when the shape (mode) is unchanged,
// so hover state survives progressive batch re-renders. Only rebuild on first
// render or mode switch.
function ensureGridCells(grid, n, className) {
  if (grid.childElementCount === n) return false;
  grid.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const cell = document.createElement('div');
    cell.className = className;
    grid.appendChild(cell);
  }
  return true;
}

function renderHmShort(counts, rgb, mode) {
  const grid   = document.getElementById('intel-hm24');
  const labels = document.getElementById('intel-hm24-labels');
  const total  = counts.reduce((s, v) => s + v, 0);
  document.getElementById('intel-count-24h').textContent =
    `${total} kill${total !== 1 ? 's' : ''}`;
  const max = Math.max(...counts, 1);
  const n   = counts.length;
  const rebuilt = ensureGridCells(grid, n, 'intel-hm-cell');
  // Labels are rebuilt whenever the grid is rebuilt OR when loadIntel
  // (re-open) cleared the labels but the grid was preserved.
  const needLabels = rebuilt || labels.childElementCount === 0;
  if (needLabels) labels.innerHTML = '';

  const now = new Date();
  if (mode === '12d') {
    for (let i = 0; i < n; i++) {
      const daysAgo = (n - 1) - i;
      const d = new Date(now.getTime() - daysAgo * INTEL_DAY_MS);
      const dayLbl = DOW_ABBR[d.getUTCDay()];
      const dateLbl = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      const c = counts[i];
      const cell = grid.children[i];
      cell.style.background = c > 0
        ? `rgba(232, 212, 77, ${(0.1 + (c / max) * 0.8).toFixed(3)})`
        : 'rgba(15, 46, 46, 0.35)';
      cell.dataset.tip = `${dayLbl} ${dateLbl}\n${c} kill${c !== 1 ? 's' : ''}`;
      if (needLabels) {
        const lbl = document.createElement('div');
        lbl.className = 'intel-hlabel';
        if (daysAgo === 0) { lbl.textContent = 'NOW'; lbl.style.fontWeight = '700'; }
        else lbl.textContent = dayLbl;
        lbl.style.textAlign = 'center';
        labels.appendChild(lbl);
      }
    }
    return;
  }

  const curH = now.getUTCHours();
  for (let i = 0; i < n; i++) {
    const h    = (curH - 23 + i + 24) % 24;
    const hStr = String(h).padStart(2, '0');
    const locH = String(Math.floor(utcToLocalHour(h))).padStart(2, '0');
    const c    = counts[i];
    const cell = grid.children[i];
    cell.style.background = c > 0
      ? `rgba(232, 212, 77, ${(0.1 + (c / max) * 0.8).toFixed(3)})`
      : 'rgba(15, 46, 46, 0.35)';
    cell.dataset.tip = `EVE Time  ${hStr}:00\nLocal     ${locH}:00\n${c} kill${c !== 1 ? 's' : ''}`;
    if (needLabels) {
      const lbl = document.createElement('div');
      lbl.className = 'intel-hlabel';
      lbl.style.textAlign = 'center';
      const hoursAgo = 23 - i;
      if (hoursAgo === 0) { lbl.textContent = 'NOW'; lbl.style.fontWeight = '700'; }
      else if (hoursAgo % 6 === 0) lbl.textContent = `-${hoursAgo}h`;
      else lbl.textContent = '';
      labels.appendChild(lbl);
    }
  }
}

function renderHm60(matrix60, rgb, peakHours) {
  const grid      = document.getElementById('intel-hm60');
  const labels    = document.getElementById('intel-hm60-labels');
  const labelsBt  = document.getElementById('intel-hm60-labels-bottom');
  const dlbls     = document.getElementById('intel-dlabels');
  const dlblsRt   = document.getElementById('intel-dlabels-right');
  const flatMax = Math.max(...matrix60.flat(), 1);

  // Build the 7 row containers + day labels + hour labels once; on subsequent
  // renders just refresh each cell's background + tooltip in place so hover
  // state survives progressive batch updates.
  const rebuilt = grid.childElementCount !== 7;
  if (rebuilt) {
    grid.innerHTML = labels.innerHTML = dlbls.innerHTML = '';
    if (labelsBt) labelsBt.innerHTML = '';
    if (dlblsRt)  dlblsRt.innerHTML = '';
    for (const dow of DAY_ORDER) {
      const dlbl = document.createElement('div');
      dlbl.className = 'intel-dlabel';
      dlbl.textContent = DAY_LABELS[dow];
      dlbls.appendChild(dlbl);
      if (dlblsRt) {
        const dlblR = document.createElement('div');
        dlblR.className = 'intel-dlabel';
        dlblR.textContent = DAY_LABELS[dow];
        dlblsRt.appendChild(dlblR);
      }
      const row = document.createElement('div');
      row.className = 'intel-hm60-row';
      for (let hr = 0; hr < 24; hr++) {
        const cell = document.createElement('div');
        cell.className = 'intel-hm-cell';
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
    for (let hr = 0; hr < 24; hr++) {
      const lbl = document.createElement('div');
      lbl.className = 'intel-hlabel';
      lbl.style.textAlign = 'center';
      lbl.textContent = (hr % 6 === 0) ? String(hr).padStart(2, '0') : '';
      labels.appendChild(lbl);
      if (labelsBt) {
        const lbl2 = document.createElement('div');
        lbl2.className = 'intel-hlabel';
        lbl2.style.textAlign = 'center';
        lbl2.textContent = lbl.textContent;
        labelsBt.appendChild(lbl2);
      }
    }
  }

  const peakSet = peakHours && peakHours.length ? new Set(peakHours) : null;

  DAY_ORDER.forEach((dow, ri) => {
    const row = grid.children[ri];
    for (let hr = 0; hr < 24; hr++) {
      const c    = matrix60[dow][hr];
      const hStr = String(hr).padStart(2, '0');
      const locH = String(Math.floor(utcToLocalHour(hr))).padStart(2, '0');
      const cell = row.children[hr];
      if (c > 0) {
        const a = 0.08 + (c / flatMax) * 0.82;
        cell.style.background = `rgba(232, 212, 77, ${a.toFixed(3)})`;
      } else {
        cell.style.background = 'rgba(15, 46, 46, 0.35)';
      }
      cell.classList.toggle('peak-col', !!(peakSet && peakSet.has(hr)));
      cell.dataset.tip =
        `EVE Time  ${hStr}:00\nLocal     ${locH}:00\n${DAY_LABELS[dow]} — ${c} kill${c !== 1 ? 's' : ''}`;
    }
  });
}

function renderEntityList(containerId, items, kind) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  if (!items.length) {
    el.innerHTML = '<div class="intel-empty">None</div>';
    return;
  }
  const clickable = intelView === 'scatter';
  for (const item of items) {
    const row  = document.createElement('div');
    row.className = 'intel-entity-row';
    if (!clickable) row.classList.add('intel-entity-row--nofilter');
    const link = document.createElement('a');
    link.href      = `https://zkillboard.com/${kind}/${item.id}/`;
    link.target    = '_blank';
    link.rel       = 'noopener';
    link.className = 'intel-entity-link';
    link.textContent = item.name;
    const spark = document.createElement('canvas');
    spark.className = 'intel-entity-spark';
    drawSparkline(spark, item.dailyV, item.dailyA);
    const filterKind = kind === 'corporation' ? 'corp' : 'alli';
    if (intelEntityFilter && intelEntityFilter.kind === filterKind && intelEntityFilter.id === item.id) {
      row.classList.add('selected');
    }
    if (clickable) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.intel-entity-link')) return;
        toggleEntityFilter(filterKind, item.id);
      });
    }
    const cnt  = document.createElement('span');
    cnt.className  = 'intel-entity-count';
    cnt.textContent = item.count;
    row.appendChild(link);
    row.appendChild(spark);
    row.appendChild(cnt);
    el.appendChild(row);
  }
}

function drawSparkline(canvas, dailyV, dailyA) {
  if (!dailyV || !dailyV.length) return;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = 70;
  const cssH = 14;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const n = dailyV.length;
  let max = 1;
  for (let i = 0; i < n; i++) max = Math.max(max, dailyV[i], dailyA[i]);
  const padY = 1;
  const usableH = cssH - padY * 2;
  const xAt = (i) => (n === 1 ? cssW / 2 : (i / (n - 1)) * cssW);
  const yAt = (v) => padY + usableH - (v / max) * usableH;

  const drawSeries = (data, fill, stroke) => {
    ctx.beginPath();
    ctx.moveTo(0, cssH);
    for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(data[i]));
    ctx.lineTo(cssW, cssH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i);
      const y = yAt(data[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  drawSeries(dailyA, 'rgba(0, 220, 220, 0.22)', 'rgba(0, 220, 220, 0.85)');
  drawSeries(dailyV, 'rgba(255, 90, 90, 0.22)',  'rgba(255, 90, 90, 0.85)');
}

function intelApiBase() {
  return (location.hostname === 'localhost' ||
          location.hostname === '127.0.0.1' ||
          location.protocol === 'file:')
    ? 'http://localhost:8080'
    : 'https://ws.anoikis.info';
}

// 16-segment animated loading bar — same visual as the legacy full-panel
// #intel-loading, now reused per section. CSS handles the staggered wave
// via nth-child animation delays.
function buildLoadBar() {
  let segs = '';
  for (let i = 0; i < 16; i++) segs += '<div class="intel-load-seg"></div>';
  return '<div class="intel-load-text">Loading<span class="cursor-blink">_</span></div>' +
         `<div class="intel-load-segs">${segs}</div>`;
}

// Parties section has two columns (corps + alliances). Rebuilt once per load.
function renderPartiesColumns() {
  const lists = document.querySelector('.intel-lists');
  lists.innerHTML =
    '<div class="intel-list-col">' +
      '<div class="intel-section-label">Corporations</div>' +
      '<div id="intel-corps"></div>' +
    '</div>' +
    '<div class="intel-list-col">' +
      '<div class="intel-section-label">Alliances</div>' +
      '<div id="intel-alliances"></div>' +
    '</div>';
}
function markPartiesError(msg) {
  const lists = document.querySelector('.intel-lists');
  lists.innerHTML = `<div class="intel-section-error">${msg}</div>`;
}

// ============================================================================
// Intel — kill fetching + aggregation
//
// Each visitor's browser hits zKillboard and ESI directly, so CCP's per-IP
// rate-limit budget scales with the number of users instead of being shared
// through one backend IP. The backend's role is exclusively the live R2Z2
// fan-out via /ws — it does not host or proxy any intel data.
//
// Flow on click:
//   1. fetchSystemKills() pulls zKB's w-space slim list for the system, then
//      hydrates each entry via ESI /killmails/{id}/{hash}/ in batches.
//   2. After every batch, the heatmaps re-render from the partial result.
//      zKB returns newest-killmail-id-first, so the visual fill effect runs
//      "now → backwards" naturally without explicit ordering.
//   3. Once all kills are hydrated, the corp/alli party lists are aggregated
//      and their names resolved via ESI (cached in nameCache forever).
//
// Cache: intelKillCache holds the hydrated kill array per system for 15 min,
// and dedupes concurrent loads via an in-flight promise. Re-clicking a system
// inside the TTL is instant.
// ============================================================================

const INTEL_CACHE_TTL    = 15 * 60 * 1000;
const INTEL_DAY_MS       = 24 * 60 * 60 * 1000;
let intelRangeShort = '24h'; // '24h' | '12d'
let intelRangeLong  = '30d'; // '30d' | '60d'

// Most recent hydrated kill set + star color for the open intel panel. Used
// by the range toggle handlers to re-aggregate without re-fetching.
let intelCurrentKills = null;
let intelCurrentRgb   = null;
let intelCurrentStar  = null;
let intelCurrentToken = 0;

// Live-update plumbing for the intel panel:
//
// - intelFreshKills: a per-killmail "this just arrived" Map keyed by killId.
//   Drives the brief size-pulse on new dots in the scatter view. Entries
//   self-prune via the rAF loop after FRESH_DOT_DURATION_MS.
//
// - scatterPulseRaf: handle for the requestAnimationFrame loop that drives
//   the pulse animation. Only runs while intelFreshKills is non-empty;
//   self-terminates when the last entry expires. Zero idle cost.
//
// - intelHeavyRenderQueued: handle for the trailing-throttle setTimeout that
//   batches expensive intel renders (hm60, prime time, rhythm, parties)
//   into 3-second windows. Many live kills in a burst result in at most
//   one heavy render every 3 seconds.
const FRESH_DOT_DURATION_MS = 2500;
const FRESH_DOT_DELTA       = 3;       // peak adds 3px on top of normal radius
const HEAVY_RENDER_THROTTLE_MS = 3000;
const intelFreshKills = new Map();     // killId -> firstShownTimestamp (performance.now())
let scatterPulseRaf = null;
let intelHeavyRenderQueued = null;

// systemId → { fetchedAt, kills, pending }
const intelKillCache = new Map();

// Intel data now comes from the backend killstore (/intel/:systemId). The
// backend maintains a 60-day rolling window of pre-hydrated kills persisted
// to a Railway volume, so the request path is a single HTTP fetch with no
// zKB pagination, no ESI hydration, and no per-user rate-limit budget.
// The returned kill objects use ESI field names (killmail_time, victim,
// attackers, _zkbValue) so the downstream aggregation code reads them
// unchanged from its previous ESI-direct incarnation.
async function fetchSystemKills(systemId, onProgress) {
  const cached = intelKillCache.get(systemId);
  if (cached?.pending) return cached.pending;
  if (cached && Date.now() - cached.fetchedAt < INTEL_CACHE_TTL) {
    onProgress?.(cached.kills);
    return cached.kills;
  }

  const promise = (async () => {
    const res = await fetch(`${intelApiBase()}/intel/${systemId}`);
    if (!res.ok) throw new Error(`intel ${res.status}`);
    const body = await res.json();
    const kills = Array.isArray(body?.kills) ? body.kills : [];
    console.log(`[intel] ${systemId} → ${kills.length} kills from backend`);
    onProgress?.(kills);
    return kills;
  })();

  intelKillCache.set(systemId, { pending: promise, fetchedAt: Date.now(), kills: [] });
  try {
    const kills = await promise;
    intelKillCache.set(systemId, { pending: null, fetchedAt: Date.now(), kills });
    return kills;
  } catch (e) {
    intelKillCache.delete(systemId);
    throw e;
  }
}

// Short section: '24h' → 24 hourly buckets, '12d' → 12 daily buckets.
function intelAggregateShort(kills, mode) {
  const now    = Date.now();
  const n      = mode === '12d' ? 12 : 24;
  const stepMs = mode === '12d' ? INTEL_DAY_MS : 3_600_000;
  const cutoff = now - n * stepMs;
  const counts = new Array(n).fill(0);
  for (const k of kills) {
    if (!passesIntelFilter(k)) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const idx = (n - 1) - Math.min(Math.floor((now - ts) / stepMs), n - 1);
    counts[idx]++;
  }
  return { counts, total: counts.reduce((s, v) => s + v, 0) };
}

// Long section: 7×24 day-of-week × hour-of-day matrix over `days` days.
function intelAggregateLong(kills, days) {
  const cutoff   = Date.now() - days * INTEL_DAY_MS;
  const matrix   = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let killCount  = 0;
  for (const k of kills) {
    if (!passesIntelFilter(k)) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const d = new Date(ts);
    matrix[d.getUTCDay()][d.getUTCHours()]++;
    killCount++;
  }
  return { matrix, killCount };
}

function intelAggregateParties(kills, days) {
  const now    = Date.now();
  const cutoff = now - days * INTEL_DAY_MS;
  const cMap = new Map();
  const aMap = new Map();
  const ensure = (m, id) => {
    let e = m.get(id);
    if (!e) {
      e = {
        count:  0,
        dailyV: new Array(days).fill(0),
        dailyA: new Array(days).fill(0),
      };
      m.set(id, e);
    }
    return e;
  };
  for (const k of kills) {
    if (!passesIntelFilter(k)) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const dayIdx = (days - 1) - Math.min(Math.floor((now - ts) / INTEL_DAY_MS), days - 1);

    const vCorp = k.victim?.corporation_id;
    const vAlli = k.victim?.alliance_id;
    if (vCorp) ensure(cMap, vCorp).dailyV[dayIdx]++;
    if (vAlli) ensure(aMap, vAlli).dailyV[dayIdx]++;

    const seenC = new Set();
    const seenA = new Set();
    if (Array.isArray(k.attackers)) {
      for (const at of k.attackers) {
        const cId = at.corporation_id;
        const aId = at.alliance_id;
        if (cId && !seenC.has(cId) && cId !== vCorp) {
          seenC.add(cId);
          ensure(cMap, cId).dailyA[dayIdx]++;
        }
        if (aId && !seenA.has(aId) && aId !== vAlli) {
          seenA.add(aId);
          ensure(aMap, aId).dailyA[dayIdx]++;
        }
      }
    }
  }
  for (const m of [cMap, aMap]) {
    for (const e of m.values()) {
      let total = 0;
      for (let i = 0; i < days; i++) total += e.dailyV[i] + e.dailyA[i];
      e.count = total;
    }
  }
  const top = (m, n) =>
    [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([id, e]) => ({ id, count: e.count, dailyV: e.dailyV, dailyA: e.dailyA }));
  return { topCorps: top(cMap, 10), topAllis: top(aMap, 10) };
}

// Hour-scale variant of intelAggregateParties for short scatter windows
// (3h / 12h). Same shape return, same field names — drawSparkline is fully
// bucket-count agnostic and reads dailyV.length, so the sparkline renders
// unchanged with hourly buckets instead of daily ones.
//
// Field names kept as `dailyV` / `dailyA` (despite the name being misleading
// at hour-scale) so the rendering pipeline doesn't need to fork. They're
// "per-bucket victim/attacker counts" — the daily naming is descriptive
// of how the original function uses them, not a constraint.
function intelAggregatePartiesLive(kills, windowMs, bucketCount) {
  const now      = Date.now();
  const cutoff   = now - windowMs;
  const bucketMs = windowMs / bucketCount;
  const cMap = new Map();
  const aMap = new Map();
  const ensure = (m, id) => {
    let e = m.get(id);
    if (!e) {
      e = {
        count:  0,
        dailyV: new Array(bucketCount).fill(0),
        dailyA: new Array(bucketCount).fill(0),
      };
      m.set(id, e);
    }
    return e;
  };
  for (const k of kills) {
    if (!passesIntelFilter(k)) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    // Same shape as the day-scale formula: oldest bucket on the left,
    // most-recent on the right.
    const bucketIdx = (bucketCount - 1) - Math.min(Math.floor((now - ts) / bucketMs), bucketCount - 1);

    const vCorp = k.victim?.corporation_id;
    const vAlli = k.victim?.alliance_id;
    if (vCorp) ensure(cMap, vCorp).dailyV[bucketIdx]++;
    if (vAlli) ensure(aMap, vAlli).dailyV[bucketIdx]++;

    const seenC = new Set();
    const seenA = new Set();
    if (Array.isArray(k.attackers)) {
      for (const at of k.attackers) {
        const cId = at.corporation_id;
        const aId = at.alliance_id;
        if (cId && !seenC.has(cId) && cId !== vCorp) {
          seenC.add(cId);
          ensure(cMap, cId).dailyA[bucketIdx]++;
        }
        if (aId && !seenA.has(aId) && aId !== vAlli) {
          seenA.add(aId);
          ensure(aMap, aId).dailyA[bucketIdx]++;
        }
      }
    }
  }
  for (const m of [cMap, aMap]) {
    for (const e of m.values()) {
      let total = 0;
      for (let i = 0; i < bucketCount; i++) total += e.dailyV[i] + e.dailyA[i];
      e.count = total;
    }
  }
  const top = (m, n) =>
    [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([id, e]) => ({ id, count: e.count, dailyV: e.dailyV, dailyA: e.dailyA }));
  return { topCorps: top(cMap, 10), topAllis: top(aMap, 10) };
}

// Dispatch helper — picks the right aggregation function based on current
// view + scatter range. Centralizes the branch so the two call sites
// (renderIntelAll + the throttled-render block) stay identical.
function getPartyAggregation(kills) {
  if (intelView === 'scatter' && (intelScatterRange === '3h' || intelScatterRange === '12h')) {
    return intelAggregatePartiesLive(kills, SCATTER_RANGE_MS[intelScatterRange], 12);
  }
  // Day-scale path — match scatter range when in scatter view, else fall
  // back to the long-range setting (heatmap/prime/rhythm context).
  const partyDays = intelView === 'scatter'
    ? (intelScatterRange === '60d' ? 60 : 30)
    : (intelRangeLong === '60d' ? 60 : 30);
  return intelAggregateParties(kills, partyDays);
}

// Kill scatter view. Each kill = one dot. X = time, Y = log10(ISK value),
// color = victim ship class. Reveals system character at a glance — ratter
// farm vs. brawl hub vs. capital killing field.
let intelView         = 'recent'; // 'recent' | 'heatmap' | 'scatter'
let intelScatterRange = '30d';     // '3h' | '12h' | '30d' | '60d'
// Lookup of scatter range → window in ms. Used by renderScatter and
// updateFilteredCount. Hour-scale ranges are scatter-only — parties +
// other intel views always operate on day-scale windows.
const SCATTER_RANGE_MS = {
  '3h':  3  * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '60d': 60 * 24 * 60 * 60 * 1000,
};
let scatterHits       = [];        // {x, y, k, color, label} — rebuilt each draw
let intelEntityFilter = null;      // { kind: 'corp'|'alli', id }

// Intel-wide filter: ships are always counted, fighters are always excluded,
// the rest are toggleable via the footer chips. Applied by every intel
// aggregator (short/long/parties) and the scatter renderer.
//
// EVE SDE groupID 31 is the Shuttle group. Used by the Shuttles chip in
// both the killfeed and intel filters to identify shuttle kills via
// authoritative SDE classification (window.TYPE_GROUPS), not icon slugs.
// Declared here (before passesIntelFilter uses it) — the killfeed section
// later in the file references the same constant.
const SHUTTLE_GROUP_ID = 31;
const INTEL_KINDS_KEY = 'anoikis-intel-kinds';
const INTEL_NPC_KEY = 'anoikis-intel-npc';
const INTEL_SHUTTLE_KEY = 'anoikis-intel-shuttle';
const intelFilterKinds = new Set(JSON.parse(localStorage.getItem(INTEL_KINDS_KEY)) || ['structure']);
let intelFilterNpc = localStorage.getItem(INTEL_NPC_KEY) === '1';
// Default ON for new users; existing users get ON unless they explicitly
// store '0' below by toggling the chip off. This matches the chip's
// default-on visual state in the HTML.
let intelFilterShuttle = localStorage.getItem(INTEL_SHUTTLE_KEY) !== '0';
function passesIntelFilter(k) {
  const kind = k.kind;
  if (kind === 'fighter') return false;
  if (kind === 'structure' || kind === 'tower' || kind === 'deployable') {
    if (!intelFilterKinds.has(kind)) return false;
  }
  if (k.isNpc && !intelFilterNpc) return false;
  // Shuttle filter — uses authoritative SDE groupID lookup. Falls through
  // to passing the kill if TYPE_GROUPS is unavailable (defensive).
  if (!intelFilterShuttle) {
    const tid = k.victim?.ship_type_id;
    if (tid && window.TYPE_GROUPS && window.TYPE_GROUPS[tid] === SHUTTLE_GROUP_ID) {
      return false;
    }
  }
  return true;
}

function killMatchesEntityFilter(k) {
  if (!intelEntityFilter) return true;
  return entityRoleInKill(k) !== null;
}

// Returns 'victim' | 'attacker' | null for the currently filtered entity.
// Self-kill (same corp/alliance on both sides) resolves to 'victim' — that's
// the more visceral signal, and we only need one colour per dot.
function entityRoleInKill(k) {
  if (!intelEntityFilter) return null;
  const { kind, id } = intelEntityFilter;
  const field = kind === 'corp' ? 'corporation_id' : 'alliance_id';
  if (k.victim?.[field] === id) return 'victim';
  if (Array.isArray(k.attackers)) {
    for (const a of k.attackers) if (a[field] === id) return 'attacker';
  }
  return null;
}

const ROLE_COLOR_VICTIM   = '#ff5566';
const ROLE_COLOR_ATTACKER = '#55e0ff';

function toggleEntityFilter(kind, id) {
  if (intelEntityFilter && intelEntityFilter.kind === kind && intelEntityFilter.id === id) {
    intelEntityFilter = null;
  } else {
    intelEntityFilter = { kind, id };
    if (intelView !== 'scatter') setIntelView('scatter');
  }
  renderIntelAll();
}

// Display label per class slug. Slugs that share a label collapse into one
// legend entry. Fighters and deployables are intentionally excluded —
// scatterClassFor returns null for them and the renderer skips those kills.
const SCATTER_CLASS_LABELS = {
  frigate: 'Frigate',
  rookie:  'Frigate',
  capsule: 'Pods/Shuttles',
  shuttle: 'Pods/Shuttles',
  destroyer: 'Destroyer',
  cruiser:   'Cruiser',
  battlecruiser: 'Battlecruiser',
  battleship: 'Battleship',
  capital: 'Capital',
  supercarrier: 'Capital',
  titan: 'Capital',
  freighter:         'Industrial',
  industrial:        'Industrial',
  industrialcommand: 'Industrial',
  miningbarge:       'Industrial',
  miningfrigate:     'Industrial',
};
const SCATTER_CLASS_COLOR = {
  Frigate:            '#5ab8ff',
  Destroyer:          '#ff8a3a',
  Cruiser:            '#ffd24a',
  Battlecruiser:      '#a8e060',
  Battleship:         '#ff5a5a',
  Capital:            '#c66bff',
  Industrial:         '#c8a878',
  Structures:         '#ffffff',
  'Towers/Depl.':     '#b0b0c8',
  'Pods/Shuttles':    '#888888',
};
const SCATTER_LEGEND_ORDER = [
  'Frigate', 'Destroyer', 'Cruiser', 'Industrial',
  'Battlecruiser', 'Battleship', 'Capital', 'Structures',
  'Pods/Shuttles', 'Towers/Depl.',
];

function scatterClassFor(typeId) {
  const kind = window.TYPE_KINDS && window.TYPE_KINDS[typeId];
  if (kind === 'structure')  return 'Structures';
  if (kind === 'tower')      return 'Towers/Depl.';
  if (kind === 'deployable') return 'Towers/Depl.';
  const slug = window.TYPE_ICONS && window.TYPE_ICONS[typeId];
  if (slug && SCATTER_CLASS_LABELS[slug]) return SCATTER_CLASS_LABELS[slug];
  return null; // pods, shuttles, fighters — not plotted
}

function buildScatterLegend() {
  const el = document.getElementById('intel-scatter-legend-list');
  if (!el) return;
  el.innerHTML = '';
  if (intelEntityFilter) {
    const entries = [
      ['Losses', ROLE_COLOR_VICTIM],
      ['Kills',  ROLE_COLOR_ATTACKER],
    ];
    for (const [label, color] of entries) {
      const span = document.createElement('span');
      const dot  = document.createElement('i');
      dot.style.background = color;
      span.appendChild(dot);
      span.appendChild(document.createTextNode(label));
      el.appendChild(span);
    }
    return;
  }
  const bottomLabels = ['Pods/Shuttles', 'Towers/Depl.'];
  for (const label of SCATTER_LEGEND_ORDER) {
    if (bottomLabels.includes(label)) continue;
    const span = document.createElement('span');
    const dot  = document.createElement('i');
    dot.style.background = SCATTER_CLASS_COLOR[label];
    span.appendChild(dot);
    span.appendChild(document.createTextNode(label));
    el.appendChild(span);
  }
  if (_isMobile) {
    for (const label of bottomLabels) {
      const span = document.createElement('span');
      const dot  = document.createElement('i');
      dot.style.background = SCATTER_CLASS_COLOR[label];
      span.appendChild(dot);
      span.appendChild(document.createTextNode(label));
      el.appendChild(span);
    }
  } else {
    const row = document.createElement('span');
    row.className = 'intel-scatter-legend-bottom';
    for (const label of bottomLabels) {
      const span = document.createElement('span');
      const dot  = document.createElement('i');
      dot.style.background = SCATTER_CLASS_COLOR[label];
      span.appendChild(dot);
      span.appendChild(document.createTextNode(label));
      row.appendChild(span);
    }
    el.appendChild(row);
  }
}

function formatIskCompact(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(n >= 1e13 ? 0 : 1).replace(/\.0$/, '') + 'T';
  if (n >= 1e9)  return Math.round(n / 1e9) + 'B';
  if (n >= 1e6)  return Math.round(n / 1e6) + 'M';
  return Math.round(n / 1e3) + 'k';
}

function renderScatter() {
  const canvas = document.getElementById('intel-scatter');
  if (!canvas || intelView !== 'scatter') return;
  buildScatterLegend();
  const kills = intelCurrentKills;
  if (!kills) { scatterHits = []; return; }

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 280;
  const cssH = 260;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const rangeMs = SCATTER_RANGE_MS[intelScatterRange] || SCATTER_RANGE_MS['30d'];
  const padL = 30, padR = 8, padT = 8, padB = 22;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const now    = Date.now();
  const cutoff = now - rangeMs;
  // Y ceiling: 15B by default, but auto-grows if a kill in-window exceeds it
  // (with 20% headroom). Floor stays at 1M.
  const minLog = 6; // 1M ISK
  let observedMax = 0;
  for (const k of kills) {
    if (!passesIntelFilter(k)) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const cls = scatterClassFor(k.victim?.ship_type_id);
    if (!cls) continue;
    const v = k._zkbValue || 0;
    if (v > observedMax) observedMax = v;
  }
  const defaultCeil = 15e9;
  const step = 5e9;
  const ceil = observedMax > defaultCeil
    ? Math.ceil(observedMax / step) * step
    : defaultCeil;
  const maxLog = Math.log10(ceil);
  // Piecewise mapping: compress 1M→100M into the bottom 25%, give 100M→1B
  // the next 40%, and leave the top 35% for 1B→ceiling. The pure-log mapping
  // wasted space on cheap kills (the bulk of activity) and squeezed the
  // expensive band where the interesting reads live.
  const anchors = [
    [minLog, 0.0],
    [8,      0.25],
    [9,      0.65],
    [maxLog, 1.0],
  ];
  const valueLogToFrac = (lv) => {
    const c = Math.max(minLog, Math.min(lv, maxLog));
    for (let i = 1; i < anchors.length; i++) {
      if (c <= anchors[i][0]) {
        const [a0, f0] = anchors[i - 1];
        const [a1, f1] = anchors[i];
        return f0 + ((c - a0) / (a1 - a0)) * (f1 - f0);
      }
    }
    return 1;
  };

  ctx.font = '10px monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 1;
  // Axis label color matches the heatmap labels (var(--dim) = #3d8888) so
  // every label across the intel panel reads at the same visual weight.
  // Gridline at 1B kept slightly brighter — that's a structural reference,
  // not a label.
  const labelDim = '#3d8888';
  // Static ticks at 1M / 100M / 1B (emphasized). Dynamic top tick = ceiling.
  const ticks = [
    [6, '<1M',  false],
    [8, '100M', false],
    [9, '1B',   true],
  ];
  ticks.push([maxLog, formatIskCompact(ceil), false]);
  for (const [v, lbl, emph] of ticks) {
    const y = padT + plotH - valueLogToFrac(v) * plotH;
    ctx.strokeStyle = emph ? 'rgba(0,200,200,0.32)' : 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y);
    ctx.stroke();
    ctx.fillStyle = labelDim;
    if (emph) ctx.font = 'bold 10px monospace';
    ctx.fillText(lbl, 2, y + 3);
    if (emph) ctx.font = '10px monospace';
  }
  ctx.fillStyle = labelDim;
  // X-axis tick presets per range. Each entry: { ticks: [...], unit, span }.
  // The numeric ticks are positioned at (span - tick) / span * plotW so 0
  // sits at the right edge ("NOW") and the largest tick at the left edge.
  const tickPresets = {
    '3h':  { ticks: [3, 2, 1, 0],     unit: 'h', span: 3  },
    '12h': { ticks: [12, 9, 6, 3, 0], unit: 'h', span: 12 },
    '30d': { ticks: [30, 20, 10, 0],  unit: 'd', span: 30 },
    '60d': { ticks: [60, 45, 30, 15, 0], unit: 'd', span: 60 },
  };
  const preset = tickPresets[intelScatterRange] || tickPresets['30d'];
  for (const t of preset.ticks) {
    const x = padL + ((preset.span - t) / preset.span) * plotW;
    const isNow = t === 0;
    const lbl = isNow ? 'NOW' : `-${t}${preset.unit}`;
    if (isNow) ctx.font = 'bold 10px monospace';
    ctx.fillText(lbl, x - ctx.measureText(lbl).width / 2, cssH - 3);
    if (isNow) ctx.font = '10px monospace';
  }

  scatterHits = [];
  for (const k of kills) {
    if (!passesIntelFilter(k)) continue;
    const ts = new Date(k.killmail_time).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const matched = killMatchesEntityFilter(k);
    const cls = scatterClassFor(k.victim?.ship_type_id);
    if (!cls) continue;
    const v = k._zkbValue || 0;
    if (v <= 0) continue;
    const lv = Math.log10(v);
    const x = padL + ((ts - cutoff) / (now - cutoff)) * plotW;
    const y = padT + plotH - valueLogToFrac(lv) * plotH;
    let color = SCATTER_CLASS_COLOR[cls];
    if (intelEntityFilter && matched) {
      const role = entityRoleInKill(k);
      if (role === 'victim')   color = ROLE_COLOR_VICTIM;
      if (role === 'attacker') color = ROLE_COLOR_ATTACKER;
    }
    // Fresh-kill size pulse: dots that arrived in the last few seconds via
    // the live WS stream are drawn larger and shrink back to normal radius
    // over FRESH_DOT_DURATION_MS. The ease-out curve makes the shrink fast
    // at first, slow near the end — feels like the dot "settling in."
    let baseRadius = matched ? 2.6 : 2;
    const t0 = intelFreshKills.get(k.id);
    if (t0 != null) {
      const t = Math.min(1, (performance.now() - t0) / FRESH_DOT_DURATION_MS);
      const ease = (1 - t) * (1 - t); // quadratic ease-out
      baseRadius += FRESH_DOT_DELTA * ease;
    }
    ctx.fillStyle = color;
    ctx.globalAlpha = matched ? 0.85 : 0.1;
    ctx.beginPath();
    ctx.arc(x, y, baseRadius, 0, Math.PI * 2);
    ctx.fill();
    if (matched) scatterHits.push({ x, y, k, color, cls });
  }
  ctx.globalAlpha = 1;

  const legendEl = document.getElementById('intel-scatter-legend');
  legendEl.textContent = `${scatterHits.length} kill${scatterHits.length !== 1 ? 's' : ''}`;
}

function setIntelView(view) {
  if (view === intelView) return;
  if (view === 'heatmap' && intelEntityFilter) intelEntityFilter = null;
  intelView = view;
  document.getElementById('intel-view-heatmap').style.display = view === 'heatmap' ? '' : 'none';
  document.getElementById('intel-view-scatter').style.display = view === 'scatter' ? '' : 'none';
  document.getElementById('intel-view-recent').style.display  = view === 'recent'  ? '' : 'none';
  document.getElementById('intel-parties-section').style.display = view === 'recent' ? 'none' : '';
  document.getElementById('panel-intel').classList.toggle('intel-view-scatter', view === 'scatter');
  document.querySelectorAll('[data-view-toggle] button').forEach((b) =>
    b.classList.toggle('on', b.dataset.view === view));
  if (view === 'scatter') {
    buildScatterLegend();
    renderScatter();
  }
  if (view === 'recent') {
    renderIntelRecent();
    startRecentAgeTick();
  } else {
    stopRecentAgeTick();
  }
  renderIntelAll();
}

document.querySelectorAll('[data-view-toggle] button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => setIntelView(btn.dataset.view));
});

// Hover tooltip on scatter dots — closest dot within 6px wins.
(function wireScatterHover() {
  const canvas = document.getElementById('intel-scatter');
  const tip    = document.getElementById('intel-scatter-tip');
  if (!canvas || !tip) return;
  canvas.addEventListener('mousemove', (e) => {
    if (intelView !== 'scatter' || scatterHits.length === 0) {
      tip.style.display = 'none';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestD2 = 36; // 6px radius
    for (const h of scatterHits) {
      const dx = h.x - mx;
      const dy = h.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = h; }
    }
    if (!best) { tip.style.display = 'none'; return; }
    const k = best.k;
    const shipId   = k.victim?.ship_type_id;
    const shipName = (window.TYPE_NAMES && window.TYPE_NAMES[shipId]) || `Type ${shipId}`;
    const isk = k._zkbValue || 0;
    const tsSec = Math.floor(new Date(k.killmail_time).getTime() / 1000);
    const agoLbl = fmtAgeScatter(tsSec);
    tip.innerHTML =
      `<div style="color:${best.color};font-weight:600;">${shipName}</div>` +
      `<div style="color:var(--muted);">${best.cls}</div>` +
      `<div>${formatIsk(isk)} ISK</div>` +
      `<div style="color:var(--dim);">${agoLbl}</div>`;
    tip.style.display = 'block';
    // Position above-right of cursor; flip if near edges.
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let tx = best.x + 8;
    let ty = best.y - tipH - 6;
    if (tx + tipW > rect.width)  tx = best.x - tipW - 8;
    if (ty < 0)                  ty = best.y + 8;
    tip.style.left = `${tx}px`;
    tip.style.top  = `${ty}px`;
  });
  canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  if (matchMedia('(pointer: coarse)').matches) {
    canvas.addEventListener('click', (e) => {
      if (intelView !== 'scatter' || scatterHits.length === 0) { tip.style.display = 'none'; return; }
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best = null;
      let bestD2 = 400; // 20px radius for easier tap
      for (const h of scatterHits) {
        const dx = h.x - mx;
        const dy = h.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = h; }
      }
      if (!best) { tip.style.display = 'none'; return; }
      const k = best.k;
      const shipId   = k.victim?.ship_type_id;
      const shipName = (window.TYPE_NAMES && window.TYPE_NAMES[shipId]) || `Type ${shipId}`;
      const isk = k._zkbValue || 0;
      const tsSec = Math.floor(new Date(k.killmail_time).getTime() / 1000);
      const agoLbl = fmtAgeScatter(tsSec);
      tip.innerHTML =
        `<div style="color:${best.color};font-weight:600;">${shipName}</div>` +
        `<div style="color:var(--muted);">${best.cls}</div>` +
        `<div>${formatIsk(isk)} ISK</div>` +
        `<div style="color:var(--dim);">${agoLbl}</div>`;
      tip.style.display = 'block';
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let tx = best.x + 8;
      let ty = best.y - tipH - 6;
      if (tx + tipW > rect.width)  tx = best.x - tipW - 8;
      if (ty < 0)                  ty = best.y + 8;
      tip.style.left = `${tx}px`;
      tip.style.top  = `${ty}px`;
    });
  }
})();

// ---------- Latest 24H tab ----------
//
// Filters intelCurrentKills to the last 24h, renders a timeline ribbon (one
// dot per kill, big if >=1B ISK, latest gets a yellow ring) and up to 3
// engagement cards (victim ↔ final blow). Hovering a dot lights its paired
// card; hovering a card lights its dot. A 60-second tick keeps dot positions
// and "X min ago" text current while the panel sits open.

const RECENT_WINDOW_S    = 24 * 3600;
const RECENT_BIG_ISK     = 1e9;
const RECENT_MAX_CARDS   = 5;
let recentAgeTickTimer = null;

function recentKills() {
  if (!intelCurrentKills) return [];
  const cutoff = Date.now() / 1000 - RECENT_WINDOW_S;
  const out = [];
  for (const k of intelCurrentKills) {
    if (!passesIntelFilter(k)) continue;
    const ts = k.killmail_time ? Date.parse(k.killmail_time) / 1000 : 0;
    if (ts < cutoff) continue;
    out.push({ k, ts });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function recentFormatAge(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.floor(s / 60) + ' min ago';
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const hLbl = h + ' hour' + (h === 1 ? '' : 's');
    return m > 0 ? `${hLbl} ${m} min ago` : `${hLbl} ago`;
  }
  return Math.floor(s / 86400) + 'd ago';
}

function recentScatterColor(typeId) {
  const cls = scatterClassFor(typeId);
  if (cls && SCATTER_CLASS_COLOR[cls]) return { cls, color: SCATTER_CLASS_COLOR[cls] };
  // Pods/shuttles fall through scatterClassFor — give them their legend colour.
  return { cls: 'Pods/Shuttles', color: SCATTER_CLASS_COLOR['Pods/Shuttles'] || '#888888' };
}

function renderIntelRecent() {
  const listEl   = document.getElementById('intel-recent-list');
  const headerEl = document.getElementById('intel-recent-list-header');
  const emptyEl  = document.getElementById('intel-recent-empty');
  const trackEl  = document.getElementById('intel-recent-track');
  const countEl  = document.getElementById('intel-recent-count');
  const tipEl    = document.getElementById('intel-recent-tip');
  if (!listEl || !trackEl) return;

  // Hide tooltip across re-renders so a stale node doesn't linger.
  if (tipEl) tipEl.style.display = 'none';

  const entries = recentKills();
  countEl.textContent = `${entries.length} kill${entries.length === 1 ? '' : 's'}`;

  // ---------- Ribbon dots ----------
  trackEl.innerHTML = '';
  entries.forEach((e, idx) => {
    const isLatest = idx === 0;
    const isBig    = (e.k._zkbValue || 0) >= RECENT_BIG_ISK;
    const ageS     = Math.max(0, Date.now() / 1000 - e.ts);
    const rightPct = Math.min(100, Math.max(0, (ageS / RECENT_WINDOW_S) * 100));
    const ship     = typeNameFor(e.k.victim?.ship_type_id);
    const sc       = recentScatterColor(e.k.victim?.ship_type_id);
    const dot = document.createElement('span');
    dot.className = 'intel-recent-dot' + (isBig ? ' big' : '') + (isLatest ? ' latest' : '');
    dot.style.right = rightPct.toFixed(2) + '%';
    if (e.k.id != null) dot.dataset.kid = String(e.k.id);
    dot.dataset.ship  = ship;
    dot.dataset.cls   = sc.cls;
    dot.dataset.color = sc.color;
    dot.dataset.isk   = formatIskCompact(e.k._zkbValue || 0) + ' ISK';
    dot.dataset.age   = recentFormatAge(e.ts);
    trackEl.appendChild(dot);
  });

  // ---------- Engagement cards ----------
  if (entries.length === 0) {
    listEl.innerHTML = '';
    headerEl.style.display = 'none';
    emptyEl.style.display  = '';
    wireRecentInteractions();
    return;
  }
  emptyEl.style.display = 'none';
  const cardEntries = entries.slice(0, RECENT_MAX_CARDS);
  headerEl.style.display = '';
  document.getElementById('intel-recent-list-count').textContent = '';

  listEl.innerHTML = '';
  cardEntries.forEach((e) => {
    const card = buildRecentCard(e);
    listEl.appendChild(card);
  });
  wireRecentInteractions();
}

function buildRecentCard({ k, ts }) {
  const card = document.createElement('div');
  card.className = 'intel-recent-card';
  if (k.id != null) card.dataset.kid = String(k.id);

  const fb = (k.attackers || []).find((a) => a.final_blow) || (k.attackers || [])[0] || null;
  const attackerCount = typeof k._attackerCount === 'number'
    ? k._attackerCount
    : (k.attackers || []).length;
  let tagInner = '';
  if (attackerCount === 1) tagInner = '<span class="solo-tag">SOLO</span>';
  else if (attackerCount > 1) tagInner = `<span class="gang-tag">+${attackerCount - 1} other${attackerCount - 1 === 1 ? '' : 's'}</span>`;
  const tag = tagInner ? `<span class="intel-recent-hdr-tag">${tagInner} · </span>` : '';
  const ageLbl = recentFormatAge(ts);

  const victimShipId = k.victim?.ship_type_id;
  const victimImg    = victimShipId != null
    ? `https://images.evetech.net/types/${victimShipId}/render?size=64` : '';
  const isk = formatIsk(k._zkbValue || 0);
  const implant = k.hasImplants
    ? `<span class="intel-recent-implant" data-tip="Pod had implants" aria-label="Pod had implants"><img src="./img/graphic/implant.png" alt="" /></span>`
    : '';

  const fbShipId = fb?.ship_type_id;
  const fbImg    = fbShipId != null
    ? `https://images.evetech.net/types/${fbShipId}/render?size=64` : '';

  const zkbHref = k.id != null ? `https://zkillboard.com/kill/${k.id}/` : '#';

  card.innerHTML = `
    <div class="intel-recent-hdr"><span>${tag}<span class="age">${ageLbl}</span></span></div>
    <div class="intel-recent-body">
      <div class="intel-recent-party">
        <div class="intel-recent-party-img" ${victimImg ? `style="background-image:url('${victimImg}')"` : ''}></div>
        <div class="intel-recent-party-info">
          <div class="intel-recent-party-label">Victim</div>
          <div class="intel-recent-party-ship">
            <span class="name" data-role="victim-ship">${escapeHtml(typeNameFor(victimShipId))}</span>
            <span class="sep-dot">·</span>
            <span class="isk">${isk}</span>
            ${implant}
          </div>
          <div class="intel-recent-party-pilot" data-role="victim-pilot">${k.isNpc ? 'NPC' : (k.victim?.character_id ? 'Loading…' : '')}</div>
          <div class="intel-recent-party-corp"  data-role="victim-corp">${k.isNpc ? '' : 'Loading…'}</div>
        </div>
      </div>
      <div class="intel-recent-arrow">
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M11 6l-6 6 6 6" /></svg>
      </div>
      <div class="intel-recent-party">
        <div class="intel-recent-party-img" ${fbImg ? `style="background-image:url('${fbImg}')"` : ''}></div>
        <div class="intel-recent-party-info">
          <div class="intel-recent-party-label"><span data-role="fb-label">${k.isNpc ? 'NPC KILL' : 'Final blow'}</span>${tagInner ? `<span class="intel-recent-fb-tag">${tagInner}</span>` : ''}</div>
          <div class="intel-recent-party-ship">
            <span class="name" data-role="fb-ship">${escapeHtml(typeNameFor(fbShipId))}</span>
          </div>
          <div class="intel-recent-party-pilot" data-role="fb-pilot">${fb && !fb.character_id ? 'o7' : (fb?.character_id ? 'Loading…' : '—')}</div>
          <div class="intel-recent-party-corp"  data-role="fb-corp">${!k.isNpc && fb?.corporation_id ? 'Loading…' : ''}</div>
        </div>
      </div>
      <a class="intel-recent-zkb" href="${zkbHref}" target="_blank" rel="noopener" aria-label="Open on zKillboard">
        <img src="./img/graphic/zkb.svg" class="zkb-img" alt="" aria-hidden="true" />
      </a>
    </div>
  `;

  // Async: ship-name fill if SDE didn't have it (covers types added post-SDE).
  if (victimShipId != null && !(window.TYPE_NAMES && window.TYPE_NAMES[victimShipId])) {
    resolveType(victimShipId, card.querySelector('[data-role="victim-ship"]'), null);
  }
  if (fbShipId != null && !(window.TYPE_NAMES && window.TYPE_NAMES[fbShipId])) {
    resolveType(fbShipId, card.querySelector('[data-role="fb-ship"]'), null);
  }

  // Async: pilot + corp names.
  const token = intelCurrentToken;
  const fillName = (kind, id, sel) => {
    if (!id) return;
    const el = card.querySelector(sel);
    if (!el) return;
    const cached = nameCache.get(kind + ':' + id);
    if (cached != null) { el.textContent = cached; return; }
    resolveEntityName(kind, id).then((name) => {
      if (token !== intelCurrentToken) return;
      if (!el.isConnected) return;
      el.textContent = name || (kind === 'char' ? 'Unknown pilot' : 'Unknown corp');
    });
  };
  fillName('char', k.victim?.character_id,    '[data-role="victim-pilot"]');
  fillName('corp', k.victim?.corporation_id,  '[data-role="victim-corp"]');
  if (fb?.character_id) fillName('char', fb.character_id,         '[data-role="fb-pilot"]');
  if (!k.isNpc && fb?.corporation_id) fillName('corp', fb.corporation_id, '[data-role="fb-corp"]');

  return card;
}

function wireRecentInteractions() {
  const ribbon = document.querySelector('.intel-recent-ribbon');
  const tip    = document.getElementById('intel-recent-tip');
  if (!ribbon || !tip) return;
  const dots   = ribbon.querySelectorAll('.intel-recent-dot');
  const cards  = document.querySelectorAll('#intel-recent-list .intel-recent-card');

  // The "now" dot is whichever .latest is on the track.
  const latestDot = ribbon.querySelector('.intel-recent-dot.latest');
  const latestKid = latestDot ? latestDot.dataset.kid : null;
  const setSuppress = (on) => ribbon.classList.toggle('suppress-latest', on);

  const findCard = (kid) => {
    if (!kid) return null;
    for (const c of cards) if (c.dataset.kid === kid) return c;
    return null;
  };
  const findDot = (kid) => {
    if (!kid) return null;
    for (const d of dots) if (d.dataset.kid === kid) return d;
    return null;
  };

  const showTip = (dot) => {
    tip.innerHTML =
      `<div style="color:${dot.dataset.color};font-weight:600;">${escapeHtml(dot.dataset.ship)}</div>` +
      `<div style="color:var(--muted);">${escapeHtml(dot.dataset.cls)}</div>` +
      `<div>${dot.dataset.isk}</div>` +
      `<div style="color:var(--dim);">${escapeHtml(dot.dataset.age)}</div>`;
    tip.style.display = 'block';
    const ribbonRect = ribbon.getBoundingClientRect();
    const dotRect    = dot.getBoundingClientRect();
    const cx = (dotRect.left + dotRect.right) / 2 - ribbonRect.left;
    const ty = dotRect.top - ribbonRect.top - tip.offsetHeight - 8;
    let tx = cx - tip.offsetWidth / 2;
    if (tx < 4) tx = 4;
    if (tx + tip.offsetWidth > ribbonRect.width - 4) tx = ribbonRect.width - tip.offsetWidth - 4;
    tip.style.left = tx + 'px';
    tip.style.top  = ty + 'px';
  };
  const hideTip = () => { tip.style.display = 'none'; };

  const isCoarse = matchMedia('(pointer: coarse)').matches;
  dots.forEach((dot) => {
    dot.addEventListener('mouseenter', () => {
      showTip(dot);
      const card = findCard(dot.dataset.kid);
      if (card) card.classList.add('linked');
      setSuppress(dot.dataset.kid !== latestKid);
    });
    dot.addEventListener('mouseleave', () => {
      hideTip();
      const card = findCard(dot.dataset.kid);
      if (card) card.classList.remove('linked');
      setSuppress(false);
    });
    if (isCoarse) {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        showTip(dot);
      });
    }
  });
  if (isCoarse && !window.__recentTipDismissBound) {
    window.__recentTipDismissBound = true;
    document.addEventListener('click', (e) => {
      const tipEl = document.getElementById('intel-recent-tip');
      if (!tipEl || tipEl.style.display === 'none') return;
      if (e.target.classList && e.target.classList.contains('intel-recent-dot')) return;
      tipEl.style.display = 'none';
    });
  }
  cards.forEach((card) => {
    card.addEventListener('mouseenter', () => {
      const dot = findDot(card.dataset.kid);
      if (dot) dot.classList.add('linked');
      setSuppress(card.dataset.kid !== latestKid);
    });
    card.addEventListener('mouseleave', () => {
      const dot = findDot(card.dataset.kid);
      if (dot) dot.classList.remove('linked');
      setSuppress(false);
    });
  });
}

function startRecentAgeTick() {
  if (recentAgeTickTimer) return;
  recentAgeTickTimer = setInterval(() => {
    if (!intelOpen || intelView !== 'recent') { stopRecentAgeTick(); return; }
    renderIntelRecent();
  }, 60 * 1000);
}
function stopRecentAgeTick() {
  if (recentAgeTickTimer) clearInterval(recentAgeTickTimer);
  recentAgeTickTimer = null;
}

let livenessTickTimer = null;
function startLivenessTick() {
  if (livenessTickTimer) return;
  livenessTickTimer = setInterval(() => {
    if (!intelOpen) { stopLivenessTick(); return; }
    renderLiveness();
  }, 60 * 1000);
}
function stopLivenessTick() {
  if (livenessTickTimer) clearInterval(livenessTickTimer);
  livenessTickTimer = null;
}

// Re-render every intel section from the current cached kill set + toggle
// state. Called on every batch during loading, and by the range-toggle
// handlers when the user flips 24h↔7d or 30d↔60d.
// Liveness pill in the intel header. Active (red) = kill in last 24h,
// quiet (amber) = 24–72h, dormant (cyan) = older or none. Uses the newest
// kill across the full 60d cache — liveness is a global system property,
// not tied to the selected heatmap window.
function fmtLiveAge(ts) {
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 3600)       return `${Math.max(1, Math.floor(sec / 60))}min ago`;
  if (sec < 86400)      return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 30 * 86400) return `${Math.floor(sec / 86400)}d ago`;
  return `${Math.floor(sec / (30 * 86400))}mo ago`;
}
function renderLiveness() {
  const el = document.getElementById('intel-live');
  if (!el) return;
  const textEl = el.querySelector('.intel-live-text');
  const kills = intelCurrentKills;
  let latestTs = 0;
  if (kills) {
    for (const k of kills) {
      const ts = k.ts || (k.killmail_time ? Math.floor(new Date(k.killmail_time).getTime() / 1000) : 0);
      if (ts > latestTs) latestTs = ts;
    }
  }
  el.classList.remove('active', 'quiet', 'dormant');
  if (!latestTs) {
    el.classList.add('dormant');
    textEl.textContent = 'No kills in 60d';
    return;
  }
  const age = Math.floor(Date.now() / 1000) - latestTs;
  const cls = age < 24 * 3600 ? 'active' : age < 72 * 3600 ? 'quiet' : 'dormant';
  el.classList.add(cls);
  textEl.innerHTML = `Last kill: <strong>${fmtLiveAge(latestTs)}</strong>`;
}

// 4h sliding-window peak/dead range derived from the 7×24 matrix. Returns
// null when the sample is too small to be meaningful (matches the preview's
// 12-kill threshold).
function computePrimeTime(matrix, totalKills) {
  if (totalKills < 12) return null;
  const buckets = new Array(24).fill(0);
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) buckets[h] += matrix[d][h];
  const WIN = 4;
  let best  = { sum: -1, start: 0 };
  let worst = { sum: Infinity, start: 0 };
  for (let s = 0; s < 24; s++) {
    let sum = 0;
    for (let i = 0; i < WIN; i++) sum += buckets[(s + i) % 24];
    if (sum > best.sum)  best  = { sum, start: s };
    if (sum < worst.sum) worst = { sum, start: s };
  }
  const fmt = (h) => String(h).padStart(2, '0') + ':00';
  const fmtLocal = (h) => String(Math.floor(utcToLocalHour(h))).padStart(2, '0') + ':00';
  const peakHours = [];
  for (let i = 0; i < WIN; i++) peakHours.push((best.start + i) % 24);
  const peakEnd  = (best.start + WIN) % 24;
  const quietEnd = (worst.start + WIN) % 24;
  return {
    peak: {
      range: `${fmt(best.start)} – ${fmt(peakEnd)}`,
      local: `Local  ${fmtLocal(best.start)} – ${fmtLocal(peakEnd)}`,
      pct:   Math.round(best.sum / totalKills * 100),
      hours: peakHours,
    },
    quiet: {
      range: `${fmt(worst.start)} – ${fmt(quietEnd)}`,
      local: `Local  ${fmtLocal(worst.start)} – ${fmtLocal(quietEnd)}`,
      pct:   Math.round(worst.sum / totalKills * 100),
    },
  };
}

function renderPrimeTime(prime, longDays) {
  const el = document.getElementById('intel-prime-time');
  if (!el) return;
  if (!prime) {
    const tail = longDays === 60
      ? 'No meaningful pattern to extract.'
      : 'Try 60 days for a wider sample.';
    el.innerHTML = `<span class="ipt-empty">Not enough activity for a reliable peak window. ${tail}</span>`;
    return;
  }
  el.innerHTML = `
    <div class="ipt-row">
      <span class="ipt-label">Prime</span>
      <span class="ipt-value" data-tip="${prime.peak.local}">${prime.peak.range} EVE TIME</span>
      <span class="ipt-pct">· ${prime.peak.pct}% of kills</span>
    </div>
    <div class="ipt-row ipt-quiet">
      <span class="ipt-label">Dead</span>
      <span class="ipt-value" data-tip="${prime.quiet.local}">${prime.quiet.range} EVE TIME</span>
      <span class="ipt-pct">· ${prime.quiet.pct}% of kills</span>
    </div>`;
}

// Avg kills/day, longest calendar-day quiet streak, hottest weekday.
// Walks the filtered kill set once to build a dayKey set + weekday histogram,
// then scans the span day-by-day to find the longest gap.
function computeRhythm(kills, days) {
  const filtered = kills.filter(passesIntelFilter);
  const nowMs  = Date.now();
  const cutoff = nowMs - days * INTEL_DAY_MS;
  const scoped = filtered.filter((k) => {
    const ts = new Date(k.killmail_time).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (scoped.length < 5) return null;

  const byDay = new Set();
  const byDow = new Array(7).fill(0);
  for (const k of scoped) {
    const d = new Date(new Date(k.killmail_time).getTime());
    byDay.add(`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`);
    byDow[d.getUTCDay()]++;
  }
  let longestQuiet = 0, run = 0;
  const startTs = Math.floor(cutoff / 1000);
  const endTs   = Math.floor(nowMs / 1000);
  for (let t = startTs; t <= endTs; t += 86400) {
    const d = new Date(t * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (byDay.has(key)) run = 0;
    else { run++; if (run > longestQuiet) longestQuiet = run; }
  }
  let hotDow = 0;
  for (let i = 1; i < 7; i++) if (byDow[i] > byDow[hotDow]) hotDow = i;
  return {
    avgPerDay:   scoped.length / days,
    longestQuiet,
    hotDow:      DAY_LABELS[hotDow],
    hotDowCount: byDow[hotDow],
  };
}

function renderRhythm(rh, longDays) {
  const el = document.getElementById('intel-rhythm');
  if (!el) return;
  if (!rh) {
    const tail = longDays === 60
      ? 'No meaningful pattern to extract.'
      : 'Try 60 days for a wider sample.';
    el.innerHTML = `<span class="ir-empty">Not enough activity for a reliable rhythm read. ${tail}</span>`;
    return;
  }
  el.innerHTML = `
    <div class="ir-cell"><span class="ir-label">Avg</span><span class="ir-value">${rh.avgPerDay.toFixed(1)}/day</span></div>
    <div class="ir-cell"><span class="ir-label">Longest quiet</span><span class="ir-value">${rh.longestQuiet}d</span></div>
    <div class="ir-cell"><span class="ir-label">Hottest day</span><span class="ir-value">${rh.hotDow} · ${rh.hotDowCount} kill${rh.hotDowCount !== 1 ? 's' : ''}</span></div>`;
}

// Mark a freshly-arrived kill so the next scatter render draws its dot at
// boosted size. The size decays back to normal over FRESH_DOT_DURATION_MS
// via the rAF loop. Safe to call when scatter isn't the active tab — the
// pulse loop self-skips the paint and just prunes expired entries.
function markFreshKill(killId) {
  intelFreshKills.set(killId, performance.now());
  startScatterPulseLoop();
}

// rAF loop that drives the fresh-dot size pulse. Runs only while at least
// one entry is in intelFreshKills; self-terminates when the Map is empty.
// Each frame: prune expired entries, repaint the scatter (if active), and
// continue if anything is still pulsing.
function startScatterPulseLoop() {
  if (scatterPulseRaf) return;
  const tick = () => {
    const now = performance.now();
    for (const [id, t0] of intelFreshKills) {
      if (now - t0 > FRESH_DOT_DURATION_MS) intelFreshKills.delete(id);
    }
    if (intelOpen && intelView === 'scatter') renderScatter();
    if (intelFreshKills.size > 0) {
      scatterPulseRaf = requestAnimationFrame(tick);
    } else {
      scatterPulseRaf = null;
    }
  };
  scatterPulseRaf = requestAnimationFrame(tick);
}

// Trailing throttle for the heavy intel renders: hm60, prime time, rhythm,
// corp/alliance lists, 60d kill count. First call schedules a render in
// HEAVY_RENDER_THROTTLE_MS; subsequent calls within that window are no-ops;
// at fire time, runs the renders against whatever the cache currently holds.
// Mirrors the heavy-render block from renderIntelAll exactly.
function scheduleHeavyRender() {
  if (intelHeavyRenderQueued) return;
  intelHeavyRenderQueued = setTimeout(() => {
    intelHeavyRenderQueued = null;
    if (!intelOpen || !intelCurrentKills || !intelCurrentRgb) return;
    const kills = intelCurrentKills;
    const rgb   = intelCurrentRgb;
    const longDays = intelRangeLong === '60d' ? 60 : 30;
    const aLong = intelAggregateLong(kills, longDays);
    const prime = computePrimeTime(aLong.matrix, aLong.killCount);
    renderPrimeTime(prime, longDays);
    renderHm60(aLong.matrix, rgb, prime ? prime.peak.hours : null);
    renderRhythm(computeRhythm(kills, longDays), longDays);
    document.getElementById('intel-count-60d').textContent =
      `${aLong.killCount} kill${aLong.killCount !== 1 ? 's' : ''}`;
    // Parties window dispatch — getPartyAggregation picks day-scale
    // (intelAggregateParties) or hour-scale (intelAggregatePartiesLive)
    // based on current view + scatter range. Sparkline render is identical
    // regardless of bucket count.
    const { topCorps, topAllis } = getPartyAggregation(kills);
    renderParty('intel-corps',     topCorps, 'corporation', 'corp', (id) => `Corp ${id}`);
    renderParty('intel-alliances', topAllis, 'alliance',    'alli', (id) => `Alliance ${id}`);
  }, HEAVY_RENDER_THROTTLE_MS);
}

function renderIntelAll() {
  const kills = intelCurrentKills;
  const rgb   = intelCurrentRgb;
  if (!kills || !rgb) return;
  renderLiveness();
  const short = intelAggregateShort(kills, intelRangeShort);
  renderHmShort(short.counts, rgb, intelRangeShort);
  const longDays = intelRangeLong === '60d' ? 60 : 30;
  const aLong = intelAggregateLong(kills, longDays);
  const prime = computePrimeTime(aLong.matrix, aLong.killCount);
  renderPrimeTime(prime, longDays);
  renderHm60(aLong.matrix, rgb, prime ? prime.peak.hours : null);
  renderRhythm(computeRhythm(kills, longDays), longDays);
  document.getElementById('intel-count-60d').textContent =
    `${aLong.killCount} kill${aLong.killCount !== 1 ? 's' : ''}`;
  // Parties window follows whichever view is active so the corp/alli list
  // matches what the user is looking at. getPartyAggregation handles the
  // day-scale vs hour-scale dispatch.
  const { topCorps, topAllis } = getPartyAggregation(kills);
  renderParty('intel-corps',     topCorps, 'corporation', 'corp', (id) => `Corp ${id}`);
  renderParty('intel-alliances', topAllis, 'alliance',    'alli', (id) => `Alliance ${id}`);
  if (intelView === 'scatter') renderScatter();
  if (intelView === 'recent')  renderIntelRecent();

  updateFilteredCount();
}

// Show how many kills are hidden by the current filter, scoped to the
// active tab's time window (24h for recent, 30/60d for heatmap + scatter).
// Extracted from renderIntelAll so the live-kill WS handler can call it
// without duplicating the cutoff/filter logic.
function updateFilteredCount() {
  const kills = intelCurrentKills;
  if (!kills) return;
  const el = document.getElementById('intel-filtered-count');
  if (!el) return;
  // Filtered-count window. Scatter on hour-scale (3h/12h) still uses the
  // 30d window for the "X hidden" counter — that counter is a longer-term
  // signal of "how much filtering is hiding from you" and isn't meaningful
  // at hour resolution.
  let cutoff;
  if (intelView === 'recent') {
    cutoff = Date.now() - INTEL_DAY_MS;
  } else if (intelView === 'scatter') {
    // Use the actual scatter range when day-scale, else default to 30d.
    const isHourScale = intelScatterRange === '3h' || intelScatterRange === '12h';
    const windowDays = intelScatterRange === '60d' ? 60 : 30;
    cutoff = isHourScale
      ? Date.now() - 30 * INTEL_DAY_MS
      : Date.now() - windowDays * INTEL_DAY_MS;
  } else {
    const windowDays = intelRangeLong === '60d' ? 60 : 30;
    cutoff = Date.now() - windowDays * INTEL_DAY_MS;
  }
  let filtered = 0;
  for (const k of kills) {
    if (k.kind === 'fighter') continue;
    const ts = k.killmail_time ? Date.parse(k.killmail_time) : 0;
    if (ts < cutoff) continue;
    if (!passesIntelFilter(k)) filtered++;
  }
  el.textContent = filtered > 0 ? `${filtered} hidden` : '';
}

function renderParty(containerId, items, kind, prefix, fallback) {
  const token = intelCurrentToken;
  const withNames = items.map((it) => ({
    ...it,
    name: nameCache.get(prefix + ':' + it.id) || fallback(it.id),
  }));
  renderEntityList(containerId, withNames, kind);
  const el = document.getElementById(containerId);
  const rows = el.querySelectorAll('.intel-entity-row');
  items.forEach((it, i) => {
    if (nameCache.has(prefix + ':' + it.id)) return;
    const link = rows[i]?.querySelector('.intel-entity-link');
    if (!link) return;
    resolveEntityName(prefix, it.id).then((name) => {
      if (token !== intelCurrentToken) return;
      if (name) link.textContent = name;
    });
  });
}

// Wire the range toggles once at startup. Clicks flip module state + re-render
// from the cached kill set — no refetch, no extra ESI traffic.
document.querySelectorAll('.intel-range-toggle').forEach((toggle) => {
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    const range = toggle.dataset.range; // 'short' | 'long' | 'scatter'
    if (!range) return;
    const mode  = btn.dataset.mode;
    if (range === 'short') {
      if (intelRangeShort === mode) return;
      intelRangeShort = mode;
    } else if (range === 'scatter') {
      if (intelScatterRange === mode) return;
      intelScatterRange = mode;
    } else {
      if (intelRangeLong === mode) return;
      intelRangeLong = mode;
    }
    toggle.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
    renderIntelAll();
  });
});

// Single intel loader. Fetches kills once; on first batch flips the full-panel
// loader to the body, then re-renders heatmaps + parties progressively as each
// batch of hydrated kills arrives. Entity names resolve per-id (cached across
// batches) and patch their row text in place when they land.
async function loadIntel(star, token) {
  const loadingEl = document.getElementById('intel-loading');
  const bodyEl    = document.getElementById('intel-body');
  const partiesEl = document.getElementById('intel-parties-section');

  document.getElementById('intel-hm24-labels').innerHTML = '';
  // hm60-labels (hours 0–23) and dlabels (Mon–Sun) are static — don't clear
  // them, or the `rebuilt` shortcut in renderHm60 (keyed off grid child count)
  // will skip repopulating and leave the day column empty on every re-open.
  document.getElementById('intel-count-24h').textContent = '';
  document.getElementById('intel-count-60d').textContent = '';
  document.getElementById('intel-prime-time').innerHTML = '';
  document.getElementById('intel-rhythm').innerHTML = '';
  partiesEl.style.display = intelView === 'recent' ? 'none' : '';
  renderPartiesColumns();

  intelCurrentRgb   = starColor(star);
  intelCurrentKills = null;
  intelCurrentStar  = star;
  intelCurrentToken = token;
  intelEntityFilter = null;
  let flipped = false;

  const onBatch = (kills) => {
    if (token !== intelLoadToken) return;
    intelCurrentKills = kills;
    if (!flipped) {
      flipped = true;
      loadingEl.style.display = 'none';
      bodyEl.style.display    = '';
    }
    renderIntelAll();
  };

  try {
    await fetchSystemKills(star.id, onBatch);
  } catch (err) {
    if (token !== intelLoadToken) return;
    console.error('intel load failed', err);
    if (!flipped) {
      loadingEl.innerHTML = '<div class="intel-section-error">Failed to load.</div>';
    } else {
      markPartiesError('Failed to load.');
    }
  }
}

// Monotonic token cancels stale loaders when the user switches systems
// mid-fetch — without it, a slow 60d response for a previous system could
// land on top of the current system's freshly-rendered data.
let intelLoadToken = 0;

function openIntel(star) {
  if (orreryOpen) closeOrrery();
  intelOpen = true;
  intelPanel.classList.add('open');
  if (isTouchDevice) document.getElementById('panel-left').classList.add('panel--hidden');
  const titleEl = document.getElementById('intel-title');
  titleEl.textContent = displayName(star) + ' · ' + displayClass(star);
  if (star.effect) {
    const eff = document.createElement('span');
    eff.className = 'intel-title-effect';
    eff.textContent = ' · ' + star.effect;
    titleEl.appendChild(eff);
  }
  document.getElementById('intel-subtitle').textContent = '';
  const liveEl = document.getElementById('intel-live');
  liveEl.classList.remove('active', 'quiet', 'dormant');
  liveEl.querySelector('.intel-live-text').textContent = '—';
  // Single full-panel loader; flipped to body on first batch of kills.
  document.getElementById('intel-loading').style.display = '';
  document.getElementById('intel-body').style.display    = 'none';
  document.getElementById('si-intel').classList.add('active');
  if (intelView === 'recent') startRecentAgeTick();
  startLivenessTick();
  const token = ++intelLoadToken;
  loadIntel(star, token);
}

function closeIntel() {
  const wasOpen = intelOpen;
  intelOpen = false;
  intelPanel.classList.remove('open');
  document.getElementById('si-intel').classList.remove('active');
  if (isTouchDevice && wasOpen) document.getElementById('panel-left').classList.remove('panel--hidden');
  stopRecentAgeTick();
  stopLivenessTick();
}

document.getElementById('close-intel').addEventListener('click', closeIntel);

document.getElementById('si-intel').addEventListener('click', () => {
  if (!selected) return;
  if (intelOpen) closeIntel();
  else openIntel(selected);
});

// --- Focus Killfeed wiring --------------------------------------
document.getElementById('si-focus-btn')?.addEventListener('click', () => {
  if (!selected) return;
  setKillFocus(selected.id);
  // On touch devices, jump to the killfeed panel so the user immediately
  // sees the focused state. Mirrors the pattern used by locate buttons.
  // Also clear the search-icon active state since the left panel just got
  // hidden — without this, both icons read as active in the bottom nav.
  if (isTouchDevice) {
    document.getElementById('panel-left')?.classList.add('panel--hidden');
    document.getElementById('panel-right')?.classList.remove('panel--hidden');
    document.getElementById('mnav-search')?.classList.remove('active');
    document.getElementById('mnav-killfeed')?.classList.add('active');
  }
});
document.getElementById('kill-focus-exit')?.addEventListener('click', () => {
  setKillFocus(null);
});

// --- Active hot systems polling ---------------------------------
// Poll backend /active every 60s. First poll fires on page load.
pollActive();
setInterval(pollActive, 60_000);

// --- Kill animations --------------------------------------------
// Ring pulse is sized and timed per kill weight. Tiny stuff (pods, shuttles,
// fighters) gets a smaller, quicker ring; structures get a bigger, longer
// one. The multiplier scales both radius and stroke thickness so every ring
// looks like a true scale copy of the baseline. RING_BUCKETS.medium.dur is
// the baseline and equals RING_MS.
const RING_BUCKETS = {
  tiny:      { mult: 0.90, dur: RING_MS },
  small:     { mult: 1.00, dur: RING_MS },
  medium:    { mult: 1.00, dur: RING_MS },
  large:     { mult: 1.08, dur: 2150 },
  huge:      { mult: 1.17, dur: 2300 },
  structure: { mult: 1.25, dur: 2500 },
};
const RING_TINY_SLUGS  = new Set(['capsule', 'shuttle', 'rookie']);
const RING_SMALL_SLUGS = new Set(['frigate', 'miningfrigate', 'destroyer']);
const RING_LARGE_SLUGS = new Set(['battleship', 'freighter']);
const RING_HUGE_SLUGS  = new Set(['capital', 'supercarrier', 'titan']);
function getRingBucket(kind, typeId) {
  if (kind === 'structure')  return RING_BUCKETS.structure;
  if (kind === 'tower')      return RING_BUCKETS.huge;
  if (kind === 'fighter')    return RING_BUCKETS.tiny;
  if (kind === 'deployable') return RING_BUCKETS.small;
  const slug = (window.TYPE_ICONS && typeId != null) ? window.TYPE_ICONS[typeId] : null;
  if (slug) {
    if (RING_TINY_SLUGS.has(slug))  return RING_BUCKETS.tiny;
    if (RING_SMALL_SLUGS.has(slug)) return RING_BUCKETS.small;
    if (RING_LARGE_SLUGS.has(slug)) return RING_BUCKETS.large;
    if (RING_HUGE_SLUGS.has(slug))  return RING_BUCKETS.huge;
  }
  return RING_BUCKETS.medium;
}
const activeAnims = [];
function triggerKillAnim(star, delayed, kind, typeId) {
  const now = performance.now();
  if (!delayed) star.flareUntil = now + FLARE_MS;
  const b = getRingBucket(kind, typeId);
  activeAnims.push({ star, t0: now, dur: b.dur, mult: b.mult, delayed: !!delayed });
}

// --- Thera connections (Eve-Scout) -------------------------------
// Draws a curved dashed arc between Thera and each active w-space
// connection. Dashes animate along the arc to show the direction of
// the wormhole: outward (exits Thera) flows toward the destination,
// inward flows toward Thera. Colour encodes the max ship size.
const THERA_DASH_PX_PER_SEC = 10;
const THERA_DASH_PATTERN = [8, 6];
const THERA_ALPHA_SCALE = 0.7;
function drawTheraConnections(now) {
  const thera = starById.get(THERA_SYSTEM_ID);
  if (!thera) return;
  const tp = worldToScreen(thera.x, thera.y);
  // Absolute screen-pixel speed, deliberately unscaled by zoom. Multiplying
  // by camera.scale kept fraction-of-arc-per-second constant but made the
  // on-retina velocity grow linearly with zoom, which visually read as
  // "dashes fly when zoomed in." The eye cares about absolute pixel speed,
  // so we leave it flat and just pick a slow constant.
  const dashShift = (now / 1000) * THERA_DASH_PX_PER_SEC;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.setLineDash(THERA_DASH_PATTERN);

  for (const c of theraConnections) {
    const dest = starById.get(c.in_system_id);
    if (!dest) continue;
    const dp = worldToScreen(dest.x, dest.y);
    const dx = dp.x - tp.x;
    const dy = dp.y - tp.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;

    // Perpendicular offset for a consistent slight bulge on every arc.
    const nx = -dy / len;
    const ny =  dx / len;
    const bulge = Math.min(140, len * 0.18);
    const cx = (tp.x + dp.x) / 2 + nx * bulge;
    const cy = (tp.y + dp.y) / 2 + ny * bulge;

    // Two-state brightness: full above 4h remaining, 0.50 effective opacity
    // at/under 4h. When the user hovers a sidebar row, isolate that arc:
    // hovered = full, everything else dims to 0.15 regardless of lifetime.
    // Then scale the whole thing by THERA_ALPHA_SCALE to take ~10% off —
    // user wanted arcs a touch dimmer than raw brightness. The dim-arc factor
    // is pre-divided so the final on-canvas opacity lands at exactly 0.50.
    const hours = c.remaining_hours ?? 12;
    let alpha = hours > 4 ? 1 : (0.5 / THERA_ALPHA_SCALE);
    if (theraHoverId !== null) {
      alpha = c.id === theraHoverId ? 1 : 0.15;
    }
    ctx.strokeStyle = theraSizeColor(c.max_ship_size);
    ctx.globalAlpha = alpha * THERA_ALPHA_SCALE;
    ctx.lineWidth = 1.4;
    // Path runs Thera → dest. positive offset shifts dashes toward start
    // (toward Thera); negative toward end (toward dest). Outward = dashes
    // flow to the destination.
    ctx.lineDashOffset = c.wh_exits_outward ? -dashShift : dashShift;

    ctx.beginPath();
    ctx.moveTo(tp.x, tp.y);
    ctx.quadraticCurveTo(cx, cy, dp.x, dp.y);
    ctx.stroke();
  }

  ctx.restore();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// --- Render ------------------------------------------------------
function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (camera.focusAnim) {
    const fa = camera.focusAnim;
    const t = clamp((performance.now() - fa.start) / fa.duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, fa.easePow ?? 3);
    camera.scale   = fa.from.scale   + (fa.to.scale   - fa.from.scale)   * eased;
    camera.offsetX = fa.from.offsetX + (fa.to.offsetX - fa.from.offsetX) * eased;
    camera.offsetY = fa.from.offsetY + (fa.to.offsetY - fa.from.offsetY) * eased;
    if (t >= 1) camera.focusAnim = null;
    updateZoomLabel();
  }

  const cw = window.innerWidth, ch = window.innerHeight;

  const pad = 80;
  const topLeft = screenToWorld(-pad, -pad);
  const botRight = screenToWorld(cw + pad, ch + pad);

  ctx.save();
  ctx.scale(DPR, DPR);

  const now = performance.now();
  const baseZoom = clamp((camera.scale - 0.18) / 1.35, 0, 1);
  const spriteSize = 16 + baseZoom * 34;
  const zoomT = clamp((camera.scale - 0.2) / 1.6, 0, 1);
  const glowFactor = 0.18 + zoomT * 0.82;

  for (const s of stars) {
    if (s.x < topLeft.x || s.x > botRight.x) continue;
    if (s.y < topLeft.y || s.y > botRight.y) continue;
    const p = worldToScreen(s.x, s.y);
    const spr = starSprite(s);
    const color = starColor(s);

    const twinkle = 0.94 + Math.sin(now * 0.0012 * s.twinkleSpeed + s.twinklePhase) * 0.06;
    const flare = s.flareUntil > now ? Math.pow((s.flareUntil - now) / FLARE_MS, 0.72) : 0;
    const intensity = twinkle + flare * 1.25;
    const size = spriteSize * (0.45 + s.r * 0.11 + flare * 0.22) * (0.75 + zoomT * 0.95);

    if (potatoMode) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp(0.80 + flare * 0.2, 0.75, 1);
      const dotR = Math.max(1.2, (0.6 + s.r * 0.2) * (0.8 + zoomT * 0.8));
      ctx.fillStyle = flare > 0.03 ? 'rgba(255,255,255,0.98)' : rgba(color, 0.95);
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Halo: alpha and size both multiplied by starGlow (settings slider).
      // 1.0 = today's appearance, 0 = invisible halo. The crisp center dot
      // below stays untouched so the map remains readable at any slider value.
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = clamp(0.16 + intensity * 0.24 * glowFactor, 0.10, 0.56 + flare * 0.35) * starGlow;
      const haloSize = size * starGlow;
      if (haloSize > 0.5 && ctx.globalAlpha > 0.001) {
        ctx.drawImage(spr, p.x - haloSize / 2, p.y - haloSize / 2, haloSize, haloSize);
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp(0.75 + zoomT * 0.2 + flare * 0.2, 0.65, 1);
      const crispR = Math.max(0.75, (0.35 + s.r * 0.16) * (0.7 + zoomT * 0.9));
      ctx.fillStyle = flare > 0.03 ? 'rgba(255,255,255,0.98)' : rgba(color, 0.95);
      ctx.beginPath();
      ctx.arc(p.x, p.y, crispR, 0, Math.PI * 2);
      ctx.fill();

      if (flare > 0.02) {
        const haloR = (8 + zoomT * 12) + flare * 24;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
        g.addColorStop(0, `rgba(255,255,255,${0.40 * flare})`);
        g.addColorStop(0.26, rgba(color, 0.22 * flare));
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'lighter';

  if (showThera && theraConnections.length) drawTheraConnections(now);

  // Hot-system rotating dashed rings — sit between Thera arcs and kill ring
  // pulses so individual kill events stay visible on top during fights.
  drawHotSystemRings(now);

  ctx.globalCompositeOperation = 'lighter';
  for (let i = activeAnims.length - 1; i >= 0; i--) {
    const a = activeAnims[i];
    const t = (now - a.t0) / a.dur;
    if (t >= 1) { activeAnims.splice(i, 1); continue; }
    const p = worldToScreen(a.star.x, a.star.y);
    if (p.x < -200 || p.x > cw + 200 || p.y < -200 || p.y > ch + 200) continue;
    const zoomK = clamp(camera.scale, 0.5, 1.8);
    const radius = (10 + t * 70) * zoomK * a.mult;
    const alpha = Math.pow(1 - t, 1.6);
    const color = a.delayed
      ? [160, 170, 180]
      : (currentPalette === 'ghost' ? [255, 140, 0] : starColor(a.star));
    ctx.strokeStyle = rgba(color, (a.delayed ? 0.55 : 0.80) * alpha);
    ctx.lineWidth = ((a.delayed ? 1.2 : 1.7) + alpha * (a.delayed ? 0.8 : 1.3)) * a.mult;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  labelHits.length = 0;

  if (showLabels) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';

    // Shared label collision helper — nudges labels to avoid overlap
    const placed = [];  // {x1, y1, x2, y2} screen-space rects
    function rectsOverlap(a, b) {
      return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
    }
    function findSlot(cx, cy, hw, hh) {
      const offsets = [
        [0, 0], [0, -hh * 2.2], [0, hh * 2.2],
        [-hw * 1.1, 0], [hw * 1.1, 0],
        [-hw * 1.1, -hh * 2.2], [hw * 1.1, -hh * 2.2],
        [-hw * 1.1, hh * 2.2], [hw * 1.1, hh * 2.2],
      ];
      for (const [dx, dy] of offsets) {
        const r = { x1: cx - hw + dx, y1: cy - hh + dy, x2: cx + hw + dx, y2: cy + hh + dy };
        let ok = true;
        for (const p of placed) {
          if (rectsOverlap(r, p)) { ok = false; break; }
        }
        if (ok) { placed.push(r); return { x: cx + dx, y: cy + dy }; }
      }
      // All slots taken — draw at original position anyway
      const r = { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh };
      placed.push(r);
      return { x: cx, y: cy };
    }

    // Region labels: visible at reset zoom, fade out as you zoom in
    const regionFade = camera.scale < 1.4 ? 1
                     : camera.scale < 2.0 ? 1 - (camera.scale - 1.4) / 0.6
                     : 0;
    if (regionFade > 0) {
      placed.length = 0;
      const rSize = 16;
      ctx.font = `600 ${rSize}px -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      const rPadH = 6, rPadV = 3;
      for (const r of regionLabels) {
        if (r.x < topLeft.x || r.x > botRight.x) continue;
        if (r.y < topLeft.y || r.y > botRight.y) continue;
        const p = worldToScreen(r.x, r.y);
        const tw = ctx.measureText(r.name).width;
        const hw = tw / 2 + rPadH, hh = rSize / 2 + rPadV;
        const slot = findSlot(p.x, p.y, hw, hh);
        ctx.fillStyle = `rgba(0,0,0,${regionFade * 0.4})`;
        ctx.fillRect(slot.x - hw, slot.y - hh, hw * 2, hh * 2);
        ctx.fillStyle = `rgba(200,220,255,${regionFade * 0.9})`;
        ctx.fillText(r.name, slot.x, slot.y);
        labelHits.push({ x1: slot.x - hw, y1: slot.y - hh, x2: slot.x + hw, y2: slot.y + hh, type: 'region', key: r.key });
      }
    }

    // Constellation labels: fade in at mid zoom, fade out before system labels
    const constFade = camera.scale < 1.8 ? 0
                    : camera.scale < 2.4 ? (camera.scale - 1.8) / 0.6
                    : camera.scale < 9.0 ? 1
                    : camera.scale < 11.0 ? 1 - (camera.scale - 9.0) / 2.0
                    : 0;
    if (constFade > 0) {
      placed.length = 0;
      const cSize = 14;
      ctx.font = `600 ${cSize}px -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = 'middle';
      const cPadH = 5, cPadV = 2;
      for (const c of constLabels) {
        if (c.x < topLeft.x || c.x > botRight.x) continue;
        if (c.y < topLeft.y || c.y > botRight.y) continue;
        const p = worldToScreen(c.x, c.y);
        const tw = ctx.measureText(c.name).width;
        const hw = tw / 2 + cPadH, hh = cSize / 2 + cPadV;
        const slot = findSlot(p.x, p.y, hw, hh);
        ctx.fillStyle = `rgba(0,0,0,${constFade * 0.35})`;
        ctx.fillRect(slot.x - hw, slot.y - hh, hw * 2, hh * 2);
        ctx.fillStyle = `rgba(200,220,255,${constFade * 0.9})`;
        ctx.fillText(c.name, slot.x, slot.y);
        labelHits.push({ x1: slot.x - hw, y1: slot.y - hh, x2: slot.x + hw, y2: slot.y + hh, type: 'const', key: c.key });
      }
    }

    // System labels (J-codes): fade in at high zoom
    if (camera.scale > 10.0) {
      placed.length = 0;
      const labelAlpha = Math.min(1, (camera.scale - 10.0) / 1.5);
      const labelSize = 11 + clamp((camera.scale - 10.0) / 3.6, 0, 1) * 4;
      const labelOffset = 6 + labelSize * 0.25;
      ctx.font = labelSize.toFixed(1) + 'px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textBaseline = 'top';
      for (const s of stars) {
        if (s.x < topLeft.x || s.x > botRight.x) continue;
        if (s.y < topLeft.y || s.y > botRight.y) continue;
        const p = worldToScreen(s.x, s.y);
        const name = drifterDisplay(s)?.displayName ?? s.name;
        const tw = ctx.measureText(name).width;
        const hw = tw / 2 + 2, hh = labelSize / 2 + 1;
        const slot = findSlot(p.x, p.y + labelOffset, hw, hh);
        ctx.fillStyle = `rgba(232,239,255,${labelAlpha * 0.9})`;
        ctx.fillText(name, slot.x, slot.y - hh + 1);
      }
    }
  }

  if (locateHover) {
    const sp = worldToScreen(locateHover.star.x, locateHover.star.y);
    const traceColor = starColor(locateHover.star);
    if (!locateHover.noTrace) {
      const rect = locateHover.el.getBoundingClientRect();
      // Active-list rows trace from the right edge (toward the map).
      // Other locate sources (kill rows, etc.) trace from the center.
      const bx = locateHover.fromRightEdge ? rect.right : (rect.left + rect.width / 2);
      const by = rect.top + rect.height / 2;
      const grad = ctx.createLinearGradient(bx, by, sp.x, sp.y);
      grad.addColorStop(0, 'rgba(0,200,200,0.80)');
      grad.addColorStop(1, rgba(traceColor, 0.80));
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      ctx.lineDashOffset = 0;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(sp.x, sp.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Highlight the target star with a subtle glowing dot in its own color.
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, 14);
    glow.addColorStop(0, rgba(traceColor, 0.55));
    glow.addColorStop(1, rgba(traceColor, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgba(traceColor, 0.95);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (selected) {
    const p = worldToScreen(selected.x, selected.y);
    const selColor = starColor(selected);
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 14);
    glow.addColorStop(0, rgba(selColor, 0.55));
    glow.addColorStop(1, rgba(selColor, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgba(selColor, 0.95);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (searchMarker) {
    const age = now - searchMarker.start;
    if (age > searchMarker.duration) {
      searchMarker = null;
    } else {
      const p = worldToScreen(searchMarker.star.x, searchMarker.star.y);
      const t = age / searchMarker.duration;
      const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 6);
      const base = (16 + pulse * 6) * clamp(camera.scale, 0.55, 1.35);
      const alpha = 0.85 * Math.pow(1 - t, 0.55);

      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(0, 200, 200, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.rect(p.x - base, p.y - base, base * 2, base * 2);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(0, 200, 200, ${alpha * 0.9})`;
      ctx.lineWidth = 1.4;
      const arm = base + 10;
      const gap = base * 0.55;
      ctx.beginPath();
      ctx.moveTo(p.x - arm, p.y); ctx.lineTo(p.x - gap, p.y);
      ctx.moveTo(p.x + gap, p.y); ctx.lineTo(p.x + arm, p.y);
      ctx.moveTo(p.x, p.y - arm); ctx.lineTo(p.x, p.y - gap);
      ctx.moveTo(p.x, p.y + gap); ctx.lineTo(p.x, p.y + arm);
      ctx.stroke();

      ctx.fillStyle = `rgba(0, 200, 200, ${alpha * 0.75})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
  updateCorners(cw, ch);
  if (orreryOpen && selected) drawOrrery(selected);
  // Mobile: keep tooltip anchored to selected star; hide if a panel covers the map.
  if (isTouchDevice && selected) {
    const tt = document.getElementById('tooltip');
    if (tt) {
      const panelCovers = !document.getElementById('panel-left').classList.contains('panel--hidden');
      if (panelCovers) {
        tt.classList.remove('visible');
      } else if (tt.classList.contains('visible')) {
        const sp = worldToScreen(selected.x, selected.y);
        tt.style.left = (sp.x + 14) + 'px';
        tt.style.top  = (sp.y - 40) + 'px';
      }
    }
  }
  requestAnimationFrame(draw);
}

// --- Interaction -------------------------------------------------
let dragging = false;
let dragStart = null;
let dragMoved = false;
const DRAG_THRESHOLD = 2;
canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  dragMoved = false;
  dragStart = { x: e.clientX, y: e.clientY, ox: camera.offsetX, oy: camera.offsetY };
  canvas.classList.add('dragging');
  camera.focusAnim = null;
});
window.addEventListener('mouseup', () => {
  dragging = false;
  canvas.classList.remove('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (dragging) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!dragMoved && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      dragMoved = true;
    }
    if (dragMoved) {
      camera.offsetX = dragStart.ox + dx;
      camera.offsetY = dragStart.oy + dy;
    }
  }
  // Suppress map tooltip when hovering over any UI element other than the map canvas.
  if (e.target !== canvas) {
    tooltip.classList.remove('visible');
    return;
  }
  handleHover(e.clientX, e.clientY);
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const before = screenToWorld(mx, my);
  const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
  camera.scale = clamp(camera.scale * zoomFactor, MIN_SCALE, MAX_SCALE);
  camera.offsetX = mx - before.x * camera.scale;
  camera.offsetY = my - before.y * camera.scale;
  camera.focusAnim = null;
  updateZoomLabel();
  handleHover(e.clientX, e.clientY);
}, { passive: false });

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

canvas.addEventListener('click', (e) => {
  if (dragMoved) return;
  // Labels take priority over stars (labels cover stars visually)
  if (showLabels) {
    const sx = e.clientX, sy = e.clientY;
    for (const lh of labelHits) {
      if (sx >= lh.x1 && sx <= lh.x2 && sy >= lh.y1 && sy <= lh.y2) {
        const b = lh.type === 'region' ? regionBounds.get(lh.key) : constBounds.get(lh.key);
        const cap = lh.type === 'region' ? 5 : MAX_SCALE;
        if (b) { deselectStar(); zoomToBounds(b.minX, b.minY, b.maxX, b.maxY, cap); }
        return;
      }
    }
  }
  const hit = pickStar(e.clientX, e.clientY);
  if (hit) selectStar(hit, true);
  else deselectStar();
});

canvas.addEventListener('dblclick', (e) => {
  if (pickStar(e.clientX, e.clientY)) return;
  animatedResetView();
});

// --- Touch interaction (mobile) --------------------------------------
let touchState = null;
const isTouchDevice = matchMedia('(pointer: coarse)').matches;
if (isTouchDevice) MIN_SCALE = 0.30;
canvas.style.touchAction = 'none';

function touchDist(a, b) {
  const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}
function touchMid(a, b) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches;
  if (t.length === 1) {
    touchState = {
      mode: 'pan',
      startX: t[0].clientX, startY: t[0].clientY,
      ox: camera.offsetX, oy: camera.offsetY,
      moved: false,
    };
    camera.focusAnim = null;
  } else if (t.length === 2) {
    const mid = touchMid(t[0], t[1]);
    touchState = {
      mode: 'pinch',
      dist0: touchDist(t[0], t[1]),
      scale0: camera.scale,
      midX: mid.x, midY: mid.y,
      ox: camera.offsetX, oy: camera.offsetY,
      moved: true,  // prevent tap on finger lift
    };
    camera.focusAnim = null;
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!touchState) return;
  const t = e.touches;
  if (touchState.mode === 'pan' && t.length === 1) {
    const dx = t[0].clientX - touchState.startX;
    const dy = t[0].clientY - touchState.startY;
    if (!touchState.moved && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      touchState.moved = true;
    }
    if (touchState.moved) {
      camera.offsetX = touchState.ox + dx;
      camera.offsetY = touchState.oy + dy;
    }
  } else if (touchState.mode === 'pinch' && t.length === 2) {
    const dist = touchDist(t[0], t[1]);
    const ratio = dist / touchState.dist0;
    const newScale = clamp(touchState.scale0 * ratio, MIN_SCALE, MAX_SCALE);
    const rect = canvas.getBoundingClientRect();
    const mx = touchState.midX - rect.left;
    const my = touchState.midY - rect.top;
    const world = screenToWorld(mx, my);
    camera.scale = newScale;
    camera.offsetX = mx - world.x * camera.scale;
    camera.offsetY = my - world.y * camera.scale;
    updateZoomLabel();
  }
}, { passive: false });

let lastTapTime = 0;
canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (touchState && touchState.mode === 'pan' && !touchState.moved && e.touches.length === 0) {
    const now = performance.now();
    const sx = touchState.startX, sy = touchState.startY;
    if (now - lastTapTime < 350) {
      // Double tap — reset view (unless tapping a star)
      lastTapTime = 0;
      if (!pickStar(sx, sy)) {
        animatedResetView();
      }
    } else {
      lastTapTime = now;
      // Fire star selection immediately — no 350ms wait
      const hit = pickStar(sx, sy);
      if (hit) selectStar(hit, true);
      else deselectStar();
    }
  }
  if (e.touches.length === 0) touchState = null;
  else if (e.touches.length === 1) {
    // Went from pinch back to one finger — start a fresh pan
    touchState = {
      mode: 'pan',
      startX: e.touches[0].clientX, startY: e.touches[0].clientY,
      ox: camera.offsetX, oy: camera.offsetY,
      moved: true,  // came from pinch — suppress tap
    };
  }
}, { passive: false });

function pickStar(sx, sy) {
  const w = screenToWorld(sx, sy);
  const wRadius = 18 / camera.scale;
  const nearby = starsNear(w.x, w.y, wRadius);
  let best = null, bestD = Infinity;
  for (const s of nearby) {
    const dx = s.x - w.x, dy = s.y - w.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < wRadius * wRadius && d2 < bestD) { best = s; bestD = d2; }
  }
  return best;
}

// --- Hover tooltip ----------------------------------------------
const tooltip = document.getElementById('tooltip');
const ttName = tooltip.querySelector('.tt-name');
const ttClass = tooltip.querySelector('.tt-class');
function hitsLabel(sx, sy) {
  for (const lh of labelHits) {
    if (sx >= lh.x1 && sx <= lh.x2 && sy >= lh.y1 && sy <= lh.y2) return true;
  }
  return false;
}
function handleHover(sx, sy) {
  if (isTouchDevice || dragging) { tooltip.classList.remove('visible'); return; }
  const s = pickStar(sx, sy);
  const overLabel = showLabels && hitsLabel(sx, sy);
  if (s) {
    ttName.textContent = displayName(s) + '  ' + displayClass(s);
    ttClass.textContent = shortLabel(s.regionName) + ' · ' + shortLabel(s.constellation);
    tooltip.style.left = (sx + 14) + 'px';
    tooltip.style.top = (sy + 14) + 'px';
    tooltip.classList.add('visible');
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.classList.remove('visible');
    canvas.style.cursor = overLabel ? 'pointer' : (dragging ? 'grabbing' : 'grab');
  }
}

// --- Custom tooltip (replaces browser title= tooltips) ----------
const customTip = document.getElementById('custom-tip');
let customTipTarget = null;

document.addEventListener('mouseover', (e) => {
  if (isTouchDevice) return;
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  customTipTarget = el;
  customTip.textContent = el.dataset.tip;
  // Active-list rows use no-wrap tooltips so each line stays on a single
  // visual line regardless of width — long ship names won't break to a
  // second visual line. Toggled per-target so other tooltips keep their
  // 300px wrap behavior.
  customTip.classList.toggle('tooltip--no-wrap', !!el.closest('.active-now-row'));
  customTip.style.display = 'block';
});

document.addEventListener('mousemove', (e) => {
  if (!customTipTarget) return;
  const x = e.clientX + 14;
  const y = e.clientY + 14;
  const tipW = customTip.offsetWidth;
  const tipH = customTip.offsetHeight;
  customTip.style.left = (x + tipW > window.innerWidth  ? e.clientX - tipW - 6 : x) + 'px';
  customTip.style.top  = (y + tipH > window.innerHeight ? e.clientY - tipH - 6 : y) + 'px';
});

document.addEventListener('mouseout', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  customTipTarget = null;
  customTip.style.display = 'none';
});

// --- Corner brackets --------------------------------------------
const cornerEls = {
  tl: document.querySelector('.corner--tl'),
  tr: document.querySelector('.corner--tr'),
  bl: document.querySelector('.corner--bl'),
  br: document.querySelector('.corner--br'),
};
const CORNER_SIZE = 24;
const RETICLE_R  = 22; // px from star centre to inner edge of each bracket


function updateCorners(cw, ch) {
  // On mobile, corners stay as screen decorations — no reticle repositioning.
  // The canvas glow + dot already marks the selected star.
  if (isTouchDevice) return;

  const R = RETICLE_R, S = CORNER_SIZE, M = 10;
  const nat = {
    tl: { x: M,          y: M          },
    tr: { x: cw - M - S, y: M          },
    bl: { x: M,          y: ch - M - S },
    br: { x: cw - M - S, y: ch - M - S },
  };

  if (!selected) {
    for (const k of ['tl', 'tr', 'bl', 'br']) {
      cornerEls[k].style.transform = 'translate(0,0)';
    }
    return;
  }

  const p = worldToScreen(selected.x, selected.y);
  const sx = p.x, sy = p.y;
  const tgt = {
    tl: { x: sx - R - S, y: sy - R - S },
    tr: { x: sx + R,     y: sy - R - S },
    bl: { x: sx - R - S, y: sy + R     },
    br: { x: sx + R,     y: sy + R     },
  };
  for (const k of ['tl', 'tr', 'bl', 'br']) {
    const dx = tgt[k].x - nat[k].x;
    const dy = tgt[k].y - nat[k].y;
    cornerEls[k].style.transform = `translate(${dx}px,${dy}px)`;
  }
}

// --- Selection + system info ------------------------------------
let selected = null;
let searchMarker = null;
const siEl = document.getElementById('system-info');
let initialUrlSys = null;

function clearUrlSysParam() {
  if (location.search) {
    history.replaceState({}, '', location.pathname);
  }
  initialUrlSys = null;
}

function deselectStar() {
  selected = null;
  siEl.classList.add('empty');
  for (const el of Object.values(cornerEls)) el.classList.remove('corner--active');
  closeOrrery();
  closeIntel();
  clearUrlSysParam();
  // Hide the Focus Killfeed section — only relevant when a system is selected.
  const focusSection = document.getElementById('si-focus-killfeed');
  if (focusSection) focusSection.style.display = 'none';
  if (isTouchDevice) tooltip.classList.remove('visible');
}

function selectStar(s, focus) {
  selected = s;
  if (initialUrlSys && s.name.toUpperCase() !== initialUrlSys) clearUrlSysParam();
  for (const el of Object.values(cornerEls)) el.classList.add('corner--active');
  siEl.classList.remove('empty');
  const dd = drifterDisplay(s);
  const nameEl = document.getElementById('si-name');
  const name = displayName(s);
  nameEl.textContent = name;
  nameEl.style.fontSize = name.length > 8 ? '12px' : '';
  const jcodeRow = document.getElementById('si-jcode-row');
  jcodeRow.style.display = dd ? '' : 'none';
  if (dd) document.getElementById('si-jcode').textContent = dd.jcode;
  const rawClass = displayClass(s);
  const longClass = /^C(\d+)$/.test(rawClass) ? 'Class ' + rawClass.slice(1) : rawClass;
  document.getElementById('si-class').textContent = longClass;
  document.getElementById('si-region').textContent = s.regionName;
  document.getElementById('si-const').textContent = s.constellation;
  document.getElementById('si-effect').textContent = s.effect || 'None';
  const stEl = document.getElementById('si-statics');
  stEl.innerHTML = '';
  stEl.classList.toggle('statics--grid3', _isMobile && s.statics.length >= 6);
  const destOrder = { C1: 0, C2: 1, C3: 2, C4: 3, C5: 4, C6: 5, C13: 6, Thera: 7, HS: 8, LS: 9, NS: 10 };
  const sortedStatics = s.statics.slice().sort((a, b) => {
    const da = (window.WH_TYPES && window.WH_TYPES[a] && window.WH_TYPES[a].leadsTo && window.WH_TYPES[a].leadsTo[0]) || '';
    const db = (window.WH_TYPES && window.WH_TYPES[b] && window.WH_TYPES[b].leadsTo && window.WH_TYPES[b].leadsTo[0]) || '';
    const oa = destOrder[da] ?? 99;
    const ob = destOrder[db] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
  for (const st of sortedStatics) {
    const chip = document.createElement('a');
    chip.className = 'static-chip';
    chip.href = 'https://whtype.info?type=' + encodeURIComponent(st);
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    const typeInfo = window.WH_TYPES && window.WH_TYPES[st];
    const dest = typeInfo && typeInfo.leadsTo && typeInfo.leadsTo[0];
    if (dest) chip.dataset.dest = dest;
    if (dest) {
      const destEl = document.createElement('b');
      destEl.className = 'static-chip-dest';
      destEl.textContent = dest;
      chip.appendChild(destEl);
      const sep = document.createElement('span');
      sep.className = 'static-chip-sep';
      chip.appendChild(sep);
      chip.appendChild(document.createTextNode(st));
    } else {
      chip.textContent = st;
    }
    stEl.appendChild(chip);
  }
  document.getElementById('si-ember-info').style.display = s.name === 'J101145' ? '' : 'none';
  renderTheraConnectionList();
  if (focus) {
    flyTo(s.x, s.y, 10, 520);
    searchMarker = { star: s, start: performance.now(), duration: 2600 };
  }
  // If orrery or intel was open for a previous system, refresh for the new one.
  if (orreryOpen) {
    updateOrreryHeader(s);
    buildOrreryList(s);
    closeSunPopup();
  }
  if (intelOpen) openIntel(s);
  // Show the Focus Killfeed section in the system info panel for any
  // selected system (hot or not). Hidden by default in HTML; we just toggle
  // its display whenever a system gets selected.
  const focusSection = document.getElementById('si-focus-killfeed');
  if (focusSection) focusSection.style.display = '';
  if (isTouchDevice) {
    ttName.textContent = displayName(s) + '  ' + displayClass(s);
    ttClass.textContent = shortLabel(s.regionName) + ' · ' + shortLabel(s.constellation);
    tooltip.classList.add('visible');
  }
}

function locateStar(s) {
  selectStar(s, true);
}

function flyTo(x, y, scale, dur) {
  const cw = window.innerWidth, ch = window.innerHeight;
  const finalScale = clamp(scale, MIN_SCALE, MAX_SCALE);
  const from = { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY };
  const to = {
    scale:   finalScale,
    offsetX: cw / 2 - x * finalScale,
    offsetY: ch / 2 - y * finalScale
  };
  camera.focusAnim = { start: performance.now(), duration: dur, from, to };
}

// --- Search ------------------------------------------------------
const searchEl = document.getElementById('search');
const searchResults = document.getElementById('search-results');
searchEl.addEventListener('input', () => {
  const raw = searchEl.value.trim();
  const q = raw.toLowerCase();
  searchResults.innerHTML = '';

  // Secret: "vSDE" shows SDE build info and a manual update trigger.
  if (raw === 'vSDE') {
    showSdePanel();
    return;
  }

  if (q.length < 2) return;

  // Region & constellation matches (only when labels are ON)
  if (showLabels) {
    for (const [fullName, b] of regionBounds) {
      const short = shortLabel(fullName);
      const fl = fullName.toLowerCase(), sl = short.toLowerCase();
      if (fl.includes(q) || sl.includes(q)) {
        const item = document.createElement('div');
        item.className = 'sr-item';
        item.innerHTML = `<span class="sr-name">${escapeHtml(fullName)}</span><span class="sr-class">${escapeHtml(short)}</span>`;
        item.addEventListener('click', () => {
          deselectStar();
          zoomToBounds(b.minX, b.minY, b.maxX, b.maxY, 5);
          searchEl.value = '';
          searchResults.innerHTML = '';
        });
        searchResults.appendChild(item);
      }
    }
    for (const [fullName, b] of constBounds) {
      const short = shortLabel(fullName);
      const fl = fullName.toLowerCase(), sl = short.toLowerCase();
      if (fl.includes(q) || sl.includes(q)) {
        const item = document.createElement('div');
        item.className = 'sr-item';
        item.innerHTML = `<span class="sr-name">${escapeHtml(fullName)}</span><span class="sr-class">${escapeHtml(short)}</span>`;
        item.addEventListener('click', () => {
          deselectStar();
          zoomToBounds(b.minX, b.minY, b.maxX, b.maxY);
          searchEl.value = '';
          searchResults.innerHTML = '';
        });
        searchResults.appendChild(item);
      }
    }
  }

  // Star matches
  const matches = [];
  for (const s of stars) {
    const dn = displayName(s).toLowerCase();
    const jc = drifterDisplay(s)?.jcode.toLowerCase() ?? '';
    if (s.name.toLowerCase().includes(q) || dn.includes(q) || jc.includes(q) || s.regionName.toLowerCase().includes(q)) {
      matches.push(s);
      if (matches.length >= 20) break;
    }
  }
  for (const s of matches) {
    const item = document.createElement('div');
    item.className = 'sr-item';
    item.innerHTML = `<span class="sr-name">${escapeHtml(displayName(s))}</span><span class="sr-class">${displayClass(s)}</span>`;
    item.addEventListener('click', () => {
      selectStar(s, true);
      searchEl.value = '';
      searchResults.innerHTML = '';
    });
    searchResults.appendChild(item);
  }
});

// Easter egg: "praise bob" → 15 random kill pulses across Anoikis over 1s.
// Fires once per page load. Subsequent attempts get acknowledged via the
// search input's placeholder ("praise bob!", yellow) — Bob hears you, but
// he's pleased enough for now. Placeholder lingers 2s then reverts. Refresh
// resets the once-per-load gate.
const SEARCH_DEFAULT_PLACEHOLDER = searchEl.placeholder;
let bobPraised = false;
let bobLingerTimer = null;

searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (searchEl.value.trim().toLowerCase() === 'praise bob') {
    e.preventDefault();
    searchEl.value = '';
    searchResults.innerHTML = '';
    if (!bobPraised) {
      // First fire: pulses only. No yellow response — the visual is the
      // animation itself. Placeholder stays default.
      triggerBob();
      bobPraised = true;
    } else {
      // Bob is already pleased — show yellow "praise bob!" placeholder for
      // 2s, then revert. Cancels any prior linger timer so spammed presses
      // share one revert cycle.
      searchEl.placeholder = 'praise bob!';
      searchEl.classList.add('search--bob');
      clearTimeout(bobLingerTimer);
      bobLingerTimer = setTimeout(() => {
        if (searchEl.placeholder === 'praise bob!') {
          searchEl.placeholder = SEARCH_DEFAULT_PLACEHOLDER;
          searchEl.classList.remove('search--bob');
        }
      }, 2000);
    }
    return;
  }
  const first = searchResults.querySelector('.sr-item');
  if (first) first.click();
});

function triggerBob() {
  const KIND_POOL = ['ship', 'structure', 'tower', 'fighter', 'deployable'];
  for (let i = 0; i < 15; i++) {
    const delay = Math.random() * 1000;
    setTimeout(() => {
      const star = stars[Math.floor(Math.random() * stars.length)];
      if (!star) return;
      const kind = KIND_POOL[Math.floor(Math.random() * KIND_POOL.length)];
      triggerKillAnim(star, false, kind, null);
    }, delay);
  }
}

// --- vSDE panel --------------------------------------------------
async function showSdePanel() {
  searchResults.innerHTML = '';
  const localBuild = window.SDE_BUILD_NUMBER
    ? `${window.SDE_BUILD_NUMBER} (${window.SDE_BUILD_DATE || 'unknown'})`
    : (window.SDE_BUILD_DATE || 'unknown');

  const panel = document.createElement('div');
  panel.className = 'sde-panel';
  panel.innerHTML = `
    <div class="sde-row"><span class="sde-label">Local SDE</span><span class="sde-val">${escapeHtml(localBuild)}</span></div>
    <div class="sde-row"><span class="sde-label">Remote build</span><span class="sde-val sde-remote">Checking…</span></div>
    <div class="sde-version-status"></div>
  `;
  searchResults.appendChild(panel);

  const remoteEl = panel.querySelector('.sde-remote');
  const verEl    = panel.querySelector('.sde-version-status');

  // Fetch remote build number from CCP
  try {
    const res = await fetch('https://developers.eveonline.com/static-data/tranquility/latest.jsonl');
    const obj = res.ok ? await res.json() : null;
    const remoteBuild = obj?.buildNumber ?? null;
    const releaseDate = obj?.releaseDate ? obj.releaseDate.replace('T', ' ').replace('Z', ' UTC').slice(0, 20) + ' UTC' : null;
    if (remoteBuild) {
      remoteEl.textContent = releaseDate ? `${remoteBuild} (${releaseDate})` : String(remoteBuild);
      // Extract local build number from SDE_BUILD_DATE if present,
      // otherwise compare the full string. The workflow stores buildNumber
      // in sde_build_id.txt but TYPE_NAMES just has a date string — so we
      // compare against window.SDE_BUILD_NUMBER if it exists (future), or
      // fall back to checking if local contains the remote number.
      const localNum = window.SDE_BUILD_NUMBER ?? null;
      const isLatest = localNum
        ? String(localNum) === String(remoteBuild)
        : localBuild.includes(String(remoteBuild));
      if (isLatest) {
        verEl.textContent = `✓ You are using the latest SDE (build ${remoteBuild})`;
        verEl.style.color = '#6ef28a';
      } else {
        verEl.textContent = `⚠ Update available: local build ${localNum || localBuild} → remote ${remoteBuild}`;
        verEl.style.color = '#ffd37a';
      }
    } else {
      remoteEl.textContent = 'unavailable';
    }
  } catch {
    remoteEl.textContent = 'unavailable';
  }

}

// Zoom indicator was removed from the settings panel along with the +/- buttons,
// but wheel/pinch zoom still drives camera.scale. This is a no-op stub kept so
// other callers (wheel handler, animated reset, etc.) don't need edits.
function updateZoomLabel() {}
document.getElementById('reset-view').addEventListener('click', animatedResetView);
const labelsBtn = document.getElementById('toggle-labels');
if (showLabels) labelsBtn.classList.add('on');
labelsBtn.addEventListener('click', () => {
  showLabels = !showLabels;
  labelsBtn.classList.toggle('on', showLabels);
  localStorage.setItem('anoikis-labels', showLabels ? '1' : '0');
});

const potatoBtn = document.getElementById('toggle-potato');
if (potatoMode) potatoBtn.classList.add('on');
potatoBtn.addEventListener('click', () => {
  potatoMode = !potatoMode;
  potatoBtn.classList.toggle('on', potatoMode);
  localStorage.setItem('anoikis-potato', potatoMode ? '1' : '0');
  // The star-glow slider is irrelevant in potato mode (flat dots, no halo).
  // Dim + disable so the user knows it's not currently affecting anything.
  if (glowSlider) glowSlider.disabled = potatoMode;
});

// Star glow slider — multiplies halo alpha + size in the draw loop. Lives
// in the settings panel. Disabled while potato mode is on (flat-dot rendering
// has no halo to dampen). Persisted in localStorage so the setting carries
// across page loads.
const glowSlider = document.getElementById('star-glow-slider');
if (glowSlider) {
  glowSlider.value = Math.round(starGlow * 100);
  glowSlider.disabled = potatoMode;
  glowSlider.addEventListener('input', () => {
    const n = parseInt(glowSlider.value, 10);
    starGlow = Math.max(0, Math.min(1, (Number.isFinite(n) ? n : 100) / 100));
    localStorage.setItem('anoikis-star-glow', String(starGlow));
  });
}

// Two buttons share the same showThera state: the one in the settings panel
// and a contextual one inside the system-info panel (visible only when Thera
// is selected). Flipping either should update both visuals and persist.
const theraBtn   = document.getElementById('toggle-thera');
const siTheraBtn = document.getElementById('si-toggle-thera');
function setShowThera(v) {
  showThera = v;
  theraBtn.classList.toggle('on', showThera);
  siTheraBtn.classList.toggle('on', showThera);
  localStorage.setItem('anoikis-thera', showThera ? '1' : '0');
}
setShowThera(showThera);
theraBtn.addEventListener('click',   () => setShowThera(!showThera));
siTheraBtn.addEventListener('click', () => setShowThera(!showThera));

// Active rings toggle — gates the rotating dashed ring rendering on the map.
// Sidebar list and backend polling are unaffected. Default ON.
const activeRingsBtn = document.getElementById('toggle-active-rings');
function setShowActiveRings(v) {
  showActiveRings = v;
  activeRingsBtn.classList.toggle('on', showActiveRings);
  localStorage.setItem('anoikis-active-rings', showActiveRings ? '1' : '0');
}
setShowActiveRings(showActiveRings);
activeRingsBtn.addEventListener('click', () => setShowActiveRings(!showActiveRings));

// NOTE: The 'anoikis' palette has been removed from the settings panel UI
// but the palette data and this handler are preserved for future use.
const paletteEmberBtn   = document.getElementById('palette-ember');
const paletteAnoikisBtn = document.getElementById('palette-anoikis');
const paletteWhtypeBtn  = document.getElementById('palette-whtype');
const paletteGhostBtn   = document.getElementById('palette-ghost');
const paletteEveBtn     = document.getElementById('palette-eve');
function setPalette(name) {
  applyPalette(name);
  localStorage.setItem('anoikis-palette', name);
  paletteEmberBtn?.classList.toggle('on',   name === 'ember');
  paletteAnoikisBtn?.classList.toggle('on', name === 'anoikis');
  paletteWhtypeBtn?.classList.toggle('on',  name === 'whtype');
  paletteGhostBtn?.classList.toggle('on',   name === 'ghost');
  paletteEveBtn?.classList.toggle('on',     name === 'eve');
}
if (currentPalette !== 'eve') setPalette(currentPalette);
paletteEmberBtn?.addEventListener('click',   () => setPalette('ember'));
paletteAnoikisBtn?.addEventListener('click', () => setPalette('anoikis'));
paletteWhtypeBtn?.addEventListener('click',  () => setPalette('whtype'));
paletteGhostBtn?.addEventListener('click',   () => setPalette('ghost'));
paletteEveBtn?.addEventListener('click',     () => setPalette('eve'));

// --- Panel visibility toggles ------------------------------------
document.getElementById('hide-left').addEventListener('click', () => {
  document.getElementById('panel-left').classList.add('panel--hidden');
  document.getElementById('restore-left').classList.add('visible');
});
document.getElementById('restore-left').addEventListener('click', () => {
  document.getElementById('panel-left').classList.remove('panel--hidden');
  document.getElementById('restore-left').classList.remove('visible');
});
const cinemaBtn = document.getElementById('cinema-btn');
document.getElementById('hide-right').addEventListener('click', () => {
  document.getElementById('panel-right').classList.add('panel--hidden');
  document.getElementById('restore-right').classList.add('visible');
  cinemaBtn.classList.add('visible');
});
const restoreRightBtn = document.getElementById('restore-right');
restoreRightBtn.addEventListener('click', () => {
  document.getElementById('panel-right').classList.remove('panel--hidden');
  restoreRightBtn.classList.remove('visible');
  restoreRightBtn.classList.remove('kill-flash');
  cinemaBtn.classList.remove('visible');
  document.body.classList.remove('cinema');
  cinemaBtn.classList.remove('active');
});

function flashRestoreRight() {
  if (!document.getElementById('panel-right').classList.contains('panel--hidden')) return;
  restoreRightBtn.classList.remove('kill-flash');
  void restoreRightBtn.offsetWidth;
  restoreRightBtn.classList.add('kill-flash');
  if (isTouchDevice) {
    const btn = document.getElementById('mnav-killfeed');
    if (btn) {
      btn.classList.remove('kill-flash');
      void btn.offsetWidth;
      btn.classList.add('kill-flash');
    }
  }
}

// --- Settings panel toggle ---------------------------------------
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
// Single source of truth for the panel state so both the desktop gear and the
// mobile bottom-nav icon get their `.active` class in sync with the panel.
function setSettingsOpen(open) {
  settingsPanel.classList.toggle('open', open);
  settingsBtn.classList.toggle('active', open);
  const mnav = document.getElementById('mnav-settings');
  if (mnav) mnav.classList.toggle('active', open);
}
settingsBtn.addEventListener('click', () => {
  setSettingsOpen(!settingsPanel.classList.contains('open'));
});
// Close on outside tap. Using `pointerdown` instead of `click` — mobile
// sometimes swallows click events (scroll gesture, 300ms phantom, etc.) which
// made the panel randomly refuse to close. pointerdown fires reliably the
// moment a finger touches the screen.
document.addEventListener('pointerdown', (e) => {
  if (!settingsPanel.classList.contains('open')) return;
  if (settingsPanel.contains(e.target)) return;
  if (settingsBtn.contains(e.target)) return;
  const mnav = document.getElementById('mnav-settings');
  if (mnav && mnav.contains(e.target)) return;
  setSettingsOpen(false);
});

// --- Mobile bottom nav bar ---------------------------------------
if (isTouchDevice) {
  const leftPanel  = document.getElementById('panel-left');
  const rightPanel = document.getElementById('panel-right');
  const mnavSearch   = document.getElementById('mnav-search');
  const mnavKillfeed = document.getElementById('mnav-killfeed');
  const mnavSettings = document.getElementById('mnav-settings');
  const mnavCinema   = document.getElementById('mnav-cinema');

  function syncMobileNav() {
    mnavSearch.classList.toggle('active', !leftPanel.classList.contains('panel--hidden'));
    mnavKillfeed.classList.toggle('active', !rightPanel.classList.contains('panel--hidden'));
  }

  // Start both panels hidden on mobile
  leftPanel.classList.add('panel--hidden');
  rightPanel.classList.add('panel--hidden');
  document.body.classList.remove('no-flash');
  syncMobileNav();

  mnavSearch.addEventListener('click', () => {
    const orreryWasOpen = document.getElementById('panel-orrery').classList.contains('open');
    const intelWasOpen  = document.getElementById('panel-intel').classList.contains('open');
    closeOrrery();
    closeIntel();
    if (orreryWasOpen || intelWasOpen) {
      // Just closed a sub-panel — keep left panel visible (back to system info)
      setSettingsOpen(false);
      syncMobileNav();
      return;
    }
    const wasOpen = !leftPanel.classList.contains('panel--hidden');
    if (wasOpen) {
      leftPanel.classList.add('panel--hidden');
    } else {
      leftPanel.classList.remove('panel--hidden');
      rightPanel.classList.add('panel--hidden');
    }
    setSettingsOpen(false);
    syncMobileNav();
  });

  mnavKillfeed.addEventListener('click', () => {
    closeOrrery();
    closeIntel();
    const wasOpen = !rightPanel.classList.contains('panel--hidden');
    if (wasOpen) {
      rightPanel.classList.add('panel--hidden');
    } else {
      rightPanel.classList.remove('panel--hidden');
      leftPanel.classList.add('panel--hidden');
    }
    setSettingsOpen(false);
    syncMobileNav();
  });

  mnavSettings.addEventListener('click', () => {
    setSettingsOpen(!settingsPanel.classList.contains('open'));
  });

  mnavCinema.addEventListener('click', () => {
    const on = document.body.classList.toggle('cinema');
    mnavCinema.classList.toggle('active', on);
  });

  // Kill header X button on mobile
  document.getElementById('mobile-kill-close').addEventListener('click', () => {
    rightPanel.classList.add('panel--hidden');
    syncMobileNav();
  });
}

// --- Cinema mode toggle ------------------------------------------
cinemaBtn.addEventListener('click', () => {
  const on = document.body.classList.toggle('cinema');
  cinemaBtn.classList.toggle('active', on);
});

// --- Kill feed ---------------------------------------------------
const killList = document.getElementById('kill-list');
const killCountEl = document.getElementById('kill-count');
const MAX_KILLS = 50;
const HISTORY_BUFFER_SIZE = 500;
const HISTORY_PAGE_SIZE = 50;
const killBuffer = []; // newest first, capped at HISTORY_BUFFER_SIZE
let killViewMode = 'live'; // 'live' | 'history'
let historyPage = 0;
let unseenLiveKills = 0;

function formatIsk(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + '<b>B</b>';
  if (v >= 1e6) return (v / 1e6).toFixed(0) + '<b>M</b>';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + '<b>K</b>';
  return '' + v;
}

function formatAge(ts) {
  if (!ts) return 'just now';
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (delta < 30) return 'just now';
  if (delta < 60) return delta + 's ago';
  if (delta < 3600) return Math.floor(delta / 60) + 'm ago';
  if (delta < 86400) return Math.floor(delta / 3600) + 'h ago';
  return Math.floor(delta / 86400) + 'd ago';
}

function formatKillTimeTip(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  const eveH = pad(d.getUTCHours()), eveM = pad(d.getUTCMinutes());
  const eveDate = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  const locH = pad(d.getHours()), locM = pad(d.getMinutes());
  const locDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return `EVE Time   ${eveDate} ${eveH}:${eveM}\nLocal      ${locDate} ${locH}:${locM}`;
}

// ESI cache for type metadata not in the local SDE table (e.g. new ships
// added between SDE builds). Stores both name and icon slug from a single
// /universe/types/{id}/ response so we don't fetch twice.
const esiTypeCache = new Map(); // typeId → { name, iconSlug }

function iconSrc(slug) {
  return slug ? `./img/icons/${slug}_64.png` : '';
}

function iconSlugFor(typeId) {
  if (typeId == null) return null;
  return (window.TYPE_ICONS && window.TYPE_ICONS[typeId]) || null;
}

// Resolve both the name and icon for a typeID. Fast path uses the SDE-built
// window.TYPE_NAMES / window.TYPE_ICONS tables synchronously; if either is
// missing we fall back to ESI /universe/types/{id}/ and use its group_id to
// look up an icon slug via window.GROUP_ICONS. The same fetch fills both.
async function resolveType(typeId, nameEl, iconEl) {
  if (typeId == null) {
    if (nameEl) nameEl.textContent = 'Unknown';
    return;
  }
  const localName = window.TYPE_NAMES && window.TYPE_NAMES[typeId];
  const localIcon = iconSlugFor(typeId);
  if (nameEl && localName) nameEl.textContent = localName;
  if (iconEl && localIcon) iconEl.src = iconSrc(localIcon);
  if (localName && (localIcon || !iconEl)) return;

  if (esiTypeCache.has(typeId)) {
    const c = esiTypeCache.get(typeId);
    // Cache-hit is synchronous — caller often invokes us before appending the
    // card to the DOM, so no isConnected guard here (unlike the async fetch
    // path below). If the element is detached, it'll still get the right text
    // when it's appended a moment later.
    if (nameEl && !localName) nameEl.textContent = c.name;
    if (iconEl && !localIcon && c.iconSlug) iconEl.src = iconSrc(c.iconSlug);
    return;
  }
  if (nameEl && !localName) nameEl.textContent = 'Type ' + typeId;
  try {
    const res = await fetch(`https://esi.evetech.net/latest/universe/types/${typeId}/`);
    if (!res.ok) return; // don't poison the cache on rate-limit / transient errors
    const data = await res.json();
    const name = data?.name;
    if (!name) return;
    const groupId = data?.group_id;
    const slug = (groupId != null && window.GROUP_ICONS && window.GROUP_ICONS[groupId]) || null;
    esiTypeCache.set(typeId, { name, iconSlug: slug });
    if (nameEl && !localName && nameEl.isConnected) nameEl.textContent = name;
    if (iconEl && !localIcon && slug && iconEl.isConnected) iconEl.src = iconSrc(slug);
  } catch {
    // network error — let the next call retry instead of caching "Type X" forever
  }
}

function typeNameFor(typeId) {
  if (typeId == null) return 'Unknown';
  return (window.TYPE_NAMES && window.TYPE_NAMES[typeId]) || ('Type ' + typeId);
}

const KIND_LABEL = {
  ship: 'Ship',
  structure: 'Structure',
  tower: 'Tower',
  deployable: 'Deployable'
};

// metaGroupID → badge filename (populated by build_types.py into window.TYPE_META)
function techBadge(typeId) {
  return (window.TYPE_META && typeId != null && window.TYPE_META[typeId]) || null;
}

const KILL_KINDS_KEY = 'anoikis-kill-kinds';
const KILL_TAGS_KEY = 'anoikis-kill-tags';
// SHUTTLE_GROUP_ID is declared earlier in the file alongside the intel
// filter state. Both filters share the same constant.
const activeKinds = new Set(JSON.parse(localStorage.getItem(KILL_KINDS_KEY)) || ['ship', 'structure']);
// Migration: the Ships chip was removed from the killfeed filter UI on
// 2026-04-26 (real ships always show now). Existing users whose saved
// activeKinds lacked 'ship' (because they had toggled it off before the
// chip removal) had no way to re-enable it — every ship kill stayed
// hidden. Force-add 'ship' once and persist; flag prevents re-running.
if (!activeKinds.has('ship') && !localStorage.getItem('anoikis-kill-kinds-ship-restored')) {
  activeKinds.add('ship');
  localStorage.setItem(KILL_KINDS_KEY, JSON.stringify([...activeKinds]));
  localStorage.setItem('anoikis-kill-kinds-ship-restored', '1');
}
const activeTags = new Set(JSON.parse(localStorage.getItem(KILL_TAGS_KEY)) || ['npc', 'shuttle']);
// Migration: existing users have an older saved tag set without 'shuttle'.
// Default the shuttle chip to ON for them too, so behavior matches the new
// chip's default state. Only adds; never removes user-toggled-off settings.
if (!activeTags.has('shuttle') && !localStorage.getItem('anoikis-kill-tags-shuttle-migrated')) {
  activeTags.add('shuttle');
  localStorage.setItem(KILL_TAGS_KEY, JSON.stringify([...activeTags]));
  localStorage.setItem('anoikis-kill-tags-shuttle-migrated', '1');
}
function isKillVisible(kind, isNpc, isDelayed, typeId) {
  if (!activeKinds.has(kind)) return false;
  if (isNpc && !activeTags.has('npc')) return false;
  if (isDelayed && !activeTags.has('delayed')) return false;
  // Shuttle filter (only ships in groupID 31 — racial + faction shuttles).
  // Falls through to true if TYPE_GROUPS isn't available (defensive — keep
  // ships visible rather than silently hide them on data-load failure).
  if (typeId && window.TYPE_GROUPS && window.TYPE_GROUPS[typeId] === SHUTTLE_GROUP_ID
      && !activeTags.has('shuttle')) {
    return false;
  }
  return true;
}
let locateHover = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const nameCache = new Map();
const nameInFlight = new Map();

function resolveEntityName(kind, id) {
  if (!id) return Promise.resolve(null);
  const key = kind + ':' + id;
  if (nameCache.has(key)) return Promise.resolve(nameCache.get(key));
  if (nameInFlight.has(key)) return nameInFlight.get(key);
  const path = kind === 'char' ? 'characters'
    : kind === 'alli' ? 'alliances'
    : 'corporations';
  const p = fetch(`https://esi.evetech.net/latest/${path}/${id}/`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const name = j && j.name ? j.name : null;
      nameCache.set(key, name);
      nameInFlight.delete(key);
      return name;
    })
    .catch(() => {
      nameInFlight.delete(key);
      return null;
    });
  nameInFlight.set(key, p);
  return p;
}

function buildKillElement({ star, killId, typeId, kind, characterId, corporationId, value, ts, hasImplants, isNpc, isDelayed }) {
  if (isDelayed === undefined) {
    isDelayed = ts ? (Date.now() - ts * 1000 > DELAYED_KILL_MS) : false;
  }
  const name = typeNameFor(typeId); // synchronous best-effort; ESI fills in below if unknown
  const img = typeId != null
    ? `https://images.evetech.net/types/${typeId}/render?size=64`
    : '';
  const iconSlug = iconSlugFor(typeId);
  const iconUrl  = iconSrc(iconSlug); // may be '' when unknown; resolveType fills src later
  const zkbHref = killId ? `https://zkillboard.com/kill/${killId}/` : null;
  const kindKey = kind || 'ship';

  const hasChar = characterId != null;
  const hasCorp = corporationId != null;
  const starDisplayName  = displayName(star);
  const starDisplayClass = displayClass(star);
  const ownerLoading = hasChar || hasCorp;
  const ownerInitial = ownerLoading
    ? (hasChar ? 'Loading pilot…' : 'Loading corporation…')
    : 'Unknown';

  const el = document.createElement('div');
  el.className = 'kill' + (isDelayed ? ' kill--delayed' : '');
  el.dataset.kind = kindKey;
  // Stash typeId so the Shuttles chip filter can re-evaluate visibility on
  // toggle without reaching back into the kill object. Read by isKillVisible
  // from applyKillFilters and renderHistoryPage.
  if (typeId) el.dataset.typeid = String(typeId);
  if (isNpc) el.dataset.npc = '1';
  if (isDelayed) el.dataset.delayed = '1';
  if (!isKillVisible(kindKey, !!isNpc, !!isDelayed, typeId)) el.style.display = 'none';

  el.innerHTML = `
    <button class="kill-btn kill-btn--locate locate-btn" data-tip="Locate ${escapeHtml(starDisplayName)}" aria-label="Locate ${escapeHtml(starDisplayName)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path>
      </svg>
    </button>
    <div class="kill-header">
      <div class="kill-sys">${escapeHtml(starDisplayName)} · <span class="kill-sys-class">${escapeHtml(starDisplayClass)}</span></div>
      <div class="kill-time-col">
        ${isDelayed ? `<span class="kill-delayed-badge" data-tip="Kill published by zKillboard after a delay — not live activity">DELAYED</span>` : ''}
        <span class="kill-age" data-ts="${ts || ''}">${formatAge(ts)}</span>
      </div>
    </div>
    <div class="kill-main">
      <div class="kill-body">
        <div class="kill-img-wrap">
          <div class="kill-img" style="background-image: url('${img}')"></div>
          <img class="kill-icon" src="${iconUrl}" alt="" aria-hidden="true" />
          ${techBadge(typeId) ? `<img src="./img/graphic/${techBadge(typeId)}.png" class="kill-tech-badge" alt="" aria-hidden="true" />` : ''}
          ${hasImplants ? `<span class="implant-badge" data-tip="Pod had implants" aria-label="Pod had implants"><img src="./img/graphic/implant.png" class="implant-img" alt="" aria-hidden="true" /></span>` : ''}
        </div>
        <div class="kill-info">
          <div class="kill-ship">
          <span class="kill-ship-name">${escapeHtml(name)}</span>
          <span class="kill-ship-extra">
            <span class="kill-ship-sep">·</span>
            <span class="kill-value">${formatIsk(value)} ISK</span>
            ${hasImplants ? `<span class="implant-badge" data-tip="Pod had implants" aria-label="Pod had implants"><img src="./img/graphic/implant.png" class="implant-img" alt="" aria-hidden="true" /></span>` : ''}
          </span>
        </div>
          <div class="kill-pilot${ownerLoading ? ' loading' : ''}">${ownerInitial}</div>
          <div class="kill-corp${hasCorp ? ' loading' : ''}">${hasCorp ? 'Loading corporation…' : ''}</div>
          <div class="kill-isk"><span class="kill-value">${formatIsk(value)} ISK</span></div>
        </div>
      </div>
      <div class="kill-footer"></div>
    </div>
    ${zkbHref ? `
    <a class="kill-btn kill-btn--zkb zkb-link" href="${zkbHref}" target="_blank" rel="noopener noreferrer" data-tip="Open on zKillboard" aria-label="Open on zKillboard">
      <img src="./img/graphic/zkb.svg" class="zkb-img" alt="" aria-hidden="true" />
    </a>` : ''}
  `;
  const zkbEl = el.querySelector('.zkb-link');
  if (zkbEl) zkbEl.addEventListener('click', (ev) => ev.stopPropagation());
  const locateBtn = el.querySelector('.locate-btn');
  locateBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    locateStar(star);
    if (isTouchDevice) {
      document.getElementById('panel-right').classList.add('panel--hidden');
      document.getElementById('mnav-killfeed')?.classList.remove('active');
    }
  });
  if (!isTouchDevice) {
    locateBtn.addEventListener('mouseenter', () => { locateHover = { el: locateBtn, star }; });
    locateBtn.addEventListener('mouseleave', () => { locateHover = null; });
  }

  if (killId != null) {
    el.dataset.killId = String(killId);
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.kill-btn')) return;
      if (isTouchDevice) openInlineFinalBlow(el, killId);
      else openKillPopup(el, killId);
    });
    if (!isTouchDevice) el.addEventListener('mouseleave', () => closeKillPopup());
  }

  if (hasChar) {
    const pilotEl = el.querySelector('.kill-pilot');
    resolveEntityName('char', characterId).then((n) => {
      if (!pilotEl.isConnected) return;
      pilotEl.classList.remove('loading');
      pilotEl.textContent = n || 'Unknown pilot';
    });
  } else if (hasCorp) {
    // No character (e.g. structure kill) — show corp name on the pilot row
    // and leave the corp row empty to avoid duplicating the same string.
    const pilotEl = el.querySelector('.kill-pilot');
    resolveEntityName('corp', corporationId).then((n) => {
      if (!pilotEl.isConnected) return;
      pilotEl.classList.remove('loading');
      pilotEl.textContent = n || 'Unknown corporation';
    });
  }

  if (hasChar && hasCorp) {
    const corpEl = el.querySelector('.kill-corp');
    resolveEntityName('corp', corporationId).then((n) => {
      if (!corpEl.isConnected) return;
      corpEl.classList.remove('loading');
      corpEl.textContent = n || 'Unknown corporation';
    });
  } else if (!hasChar && hasCorp) {
    // Corp already on pilot row — clear the corp row so we don't show a spinner.
    const corpEl = el.querySelector('.kill-corp');
    corpEl.classList.remove('loading');
    corpEl.textContent = '';
  }

  // If either the name or the icon was a fallback placeholder, ask the
  // unified resolver to fill whatever is missing via ESI.
  const nameKnown = !!window.TYPE_NAMES?.[typeId];
  const iconKnown = !!iconSlugFor(typeId);
  if (!nameKnown || !iconKnown) {
    resolveType(typeId, el.querySelector('.kill-ship-name'), el.querySelector('.kill-icon'));
  }

  return el;
}

function spawnLiveKill(params) {
  // History-only kills (>16h delayed by zKB) skip the live feed entirely:
  // no map animation, no DOM row, no kill counter bump. They still ride the
  // history buffer + intel cache via the WS handler upstream.
  if (params.isHistoryOnly) return;
  // Map animation fires regardless of focus mode. Focus only filters which
  // kills appear in the visible list — the map stays global.
  if (params.animated) triggerKillAnim(params.star, !!params.isDelayed, params.kind, params.typeId);
  // Focused mode owns its own rendering pipeline (prependFocusKill from the
  // WS handler). The global live list is hidden, so don't write to it.
  if (focusedSystemId != null) return;
  const el = buildKillElement(params);
  killList.insertBefore(el, killList.firstChild);
  while (killList.children.length > MAX_KILLS) killList.removeChild(killList.lastChild);
  updateKillCount();
}

function stampKill(kill) {
  if (kill._delayedStamped) return;
  kill._delayedStamped = true;
  if (!kill.ts) {
    kill._isDelayed = false;
    kill._isHistoryOnly = false;
    return;
  }
  // Prefer the backend's receivedAt (the true "zKB published it late" signal,
  // independent of when the browser loaded). Fall back to now() only if the
  // backend hasn't been updated yet — during the rollout window, the old
  // behavior is still better than nothing.
  const ref = kill.receivedAt ? kill.receivedAt * 1000 : Date.now();
  const ageMs = ref - kill.ts * 1000;
  kill._isDelayed     = ageMs > DELAYED_KILL_MS;
  kill._isHistoryOnly = ageMs > HISTORY_ONLY_DELAY_MS;
}

function killToParams(kill, star) {
  return {
    star,
    killId: kill.id,
    typeId: kill.shipTypeId,
    kind: kill.kind,
    characterId: kill.characterId,
    corporationId: kill.corporationId,
    value: kill.value,
    ts: kill.ts,
    hasImplants: !!kill.hasImplants,
    isNpc: !!kill.isNpc,
    isDelayed: kill._isDelayed,
    isHistoryOnly: !!kill._isHistoryOnly,
  };
}

function updateKillCount() {
  // Count hidden rows from the currently-visible list. Three states:
  //   - Focused mode: focused kills render into #kill-history-list.
  //   - Global history mode: same #kill-history-list element.
  //   - Global live mode: #kill-list.
  const container = (focusedSystemId != null || killViewMode === 'history')
    ? document.getElementById('kill-history-list')
    : killList;
  let hidden = 0;
  if (container) {
    for (const el of container.children) {
      if (el.style.display === 'none') hidden++;
    }
  }
  killCountEl.textContent = hidden > 0 ? hidden + ' hidden' : '';
}

function handleBackendKill(kill, animated) {
  const star = starById.get(kill.systemId);
  if (!star) return;
  spawnLiveKill({ ...killToParams(kill, star), animated });
  if (animated) flashRestoreRight();
}

function applyKillFilters() {
  const lists = [killList, document.getElementById('kill-history-list')];
  for (const list of lists) {
    if (!list) continue;
    for (const el of list.children) {
      el.style.display = isKillVisible(el.dataset.kind, el.dataset.npc === '1', el.dataset.delayed === '1', Number(el.dataset.typeid) || null) ? '' : 'none';
    }
  }
  updateKillCount();
}

// --- Kill history ------------------------------------------------
const historyListEl = document.getElementById('kill-history-list');
const historyContainerEl = document.getElementById('kill-history');
const historyBannerEl = document.getElementById('kill-history-banner');
const historyPageLabelEl = document.getElementById('kill-history-page');
const historyPrevBtn = document.getElementById('kill-history-prev');
const historyNextBtn = document.getElementById('kill-history-next');
const historyToggleBtn = document.getElementById('kill-history-toggle');

function pushToBuffer(kill, star) {
  killBuffer.unshift({ kill, star });
  while (killBuffer.length > HISTORY_BUFFER_SIZE) killBuffer.pop();
}

function renderHistoryPage() {
  // Focused mode uses its own paginated renderer (renderFocusPage), backed
  // by /intel — not the cluster-wide buffer. Early-return so this function
  // doesn't accidentally clobber the focused list when called from a stale
  // path (e.g., bound button handler that didn't get focus-aware logic).
  if (focusedSystemId != null) return;
  // History = every kill in the buffer that's not currently shown in the live
  // list. The live list holds the newest MAX_KILLS items that are NOT
  // history-only (>16h delayed kills are routed straight here regardless of
  // position in the buffer).
  // Within history, sort by killmail timestamp descending — this undoes any
  // out-of-order insertion caused by zKB catching up on delayed kills in bulk.
  const eligible = killBuffer;
  let liveCount = 0;
  const historyItems = [];
  for (const item of eligible) {
    if (item.kill._isHistoryOnly) {
      historyItems.push(item);
      continue;
    }
    if (liveCount < MAX_KILLS) {
      liveCount++;
      continue;
    }
    historyItems.push(item);
  }
  historyItems.sort((a, b) => (b.kill.ts || 0) - (a.kill.ts || 0));
  const totalPages = Math.max(1, Math.ceil(historyItems.length / HISTORY_PAGE_SIZE));
  if (historyPage >= totalPages) historyPage = totalPages - 1;
  if (historyPage < 0) historyPage = 0;
  const start = historyPage * HISTORY_PAGE_SIZE;
  const end = Math.min(start + HISTORY_PAGE_SIZE, historyItems.length);
  historyListEl.innerHTML = '';
  for (let i = start; i < end; i++) {
    const { kill, star } = historyItems[i];
    const el = buildKillElement(killToParams(kill, star));
    if (!isKillVisible(el.dataset.kind, el.dataset.npc === '1', el.dataset.delayed === '1', Number(el.dataset.typeid) || null)) el.style.display = 'none';
    historyListEl.appendChild(el);
  }
  historyPageLabelEl.textContent = `Page ${historyPage + 1} / ${totalPages}`;
  historyPrevBtn.disabled = historyPage === 0;
  historyNextBtn.disabled = historyPage >= totalPages - 1;
  updateKillCount();
}

function updateHistoryBanner() {
  if (killViewMode === 'history' && unseenLiveKills > 0) {
    historyBannerEl.style.display = '';
    historyBannerEl.textContent = `${unseenLiveKills} new kill${unseenLiveKills !== 1 ? 's' : ''} — click to return to Live`;
  } else {
    historyBannerEl.style.display = 'none';
  }
}

// ─── Focused killfeed (system-scoped, intel-backed, paginated) ──────────
//
// Fundamentally different rendering path from the global killfeed:
//   - Source: /intel/{systemId} filtered to last 24h (not the cluster-wide buffer).
//   - Single paginated list, no live/history toggle.
//   - Renders into the existing #kill-history container (banner + list + nav)
//     while #kill-list is hidden. Header label uses the existing focus prefix.
//   - Live WS kills for the focused system prepend to focusKills as they arrive.
//   - Banner shows "N new kill — go to page 1" when on page 2+ and a matching
//     kill arrives. Banner click jumps to page 1 instead of the global "back to live".

// Toggle the Delayed chip's visual state for focused mode. Focused mode
// shows all 24h regardless of delayed state, so the chip is:
//   - dimmed + click-blocked (.disabled), AND
//   - forced visually ON (.on), since focused mode is effectively
//     "delayed kills are included" regardless of the chip's saved value.
// On exit, restore the saved on/off state from activeTags. Other chips
// (kind/NPC/shuttle) stay active in both modes.
let delayedChipPreFocusOn = null;
function setFocusedChipDisabledState(disabled) {
  const chip = document.querySelector('#kill-filters .kind-chip[data-tag="delayed"]');
  if (!chip) return;
  if (disabled) {
    // Remember the chip's visual on/off state so we can restore on exit.
    delayedChipPreFocusOn = chip.classList.contains('on');
    chip.classList.add('disabled');
    chip.classList.add('on');  // force-on while focused (all kills shown)
  } else {
    chip.classList.remove('disabled');
    // Restore the actual on/off state from activeTags.
    const trulyOn = activeTags.has('delayed');
    chip.classList.toggle('on', trulyOn);
    delayedChipPreFocusOn = null;
  }
}

function enterFocusMode(systemId) {
  // Reset state for the new focus.
  focusKills = [];
  focusPage = 0;
  focusUnseenCount = 0;
  focusPendingWsKills = [];
  focusFetching = true;
  const myToken = ++focusFetchToken;
  // Dim and disable the Delayed chip — focused mode shows everything in
  // the last 24h regardless, so the chip can't filter anything. Other
  // chips stay active (kind/NPC/shuttle still meaningfully filter).
  setFocusedChipDisabledState(true);

  // Swap visible elements: hide the live list, show the history container
  // (which has the banner + paginated list + prev/next controls). DON'T
  // toggle history-mode CSS — focused mode keeps the normal header colors.
  killList.style.display = 'none';
  historyContainerEl.style.display = 'flex';
  // Hide the history toggle button — focused mode has no separate history view.
  if (historyToggleBtn) historyToggleBtn.style.display = 'none';
  // Empty the visible list while we fetch.
  historyListEl.innerHTML = '<div class="kill-history-loading">Loading…</div>';
  historyBannerEl.style.display = 'none';
  historyPageLabelEl.textContent = '';
  historyPrevBtn.disabled = true;
  historyNextBtn.disabled = true;

  fetchSystemKills(systemId).then((kills) => {
    // Stale fetch guard — user may have switched focus or exited.
    if (myToken !== focusFetchToken) return;
    if (focusedSystemId !== systemId) return;
    focusFetching = false;
    const cutoff = Math.floor((Date.now() - FOCUS_WINDOW_MS) / 1000);
    // /intel kills come newest-first already. Filter to 24h and sort to be safe.
    focusKills = (kills || [])
      .filter(k => k && k.ts && k.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts);
    // Drain any WS kills that arrived during the fetch. Dedupe by id.
    for (const wsKill of focusPendingWsKills) {
      if (focusKills.some(k => k.id === wsKill.id)) continue;
      if (wsKill.ts && wsKill.ts >= cutoff) focusKills.unshift(wsKill);
    }
    focusPendingWsKills = [];
    focusKills.sort((a, b) => b.ts - a.ts);
    renderFocusPage();
  }).catch((err) => {
    if (myToken !== focusFetchToken) return;
    focusFetching = false;
    historyListEl.innerHTML = '<div class="kill-history-empty">Couldn\'t load recent kills.</div>';
    console.warn('[focus] fetch failed:', err?.message || err);
  });
}

function exitFocusMode() {
  focusKills = [];
  focusPage = 0;
  focusUnseenCount = 0;
  focusPendingWsKills = [];
  focusFetching = false;
  focusFetchToken++;  // invalidate any in-flight fetch
  // Restore the Delayed chip's normal interactive state.
  setFocusedChipDisabledState(false);
  // Restore global UI: show live list, hide history container, restore the toggle.
  killList.style.display = '';
  historyContainerEl.style.display = 'none';
  if (historyToggleBtn) historyToggleBtn.style.display = '';
  historyBannerEl.style.display = 'none';
  historyBannerEl.textContent = '';
  // Reset killViewMode to 'live' (focus exits always land in live mode).
  killViewMode = 'live';
  panelRightEl.classList.remove('history-mode');
  // Rebuild the live list from the buffer — focus may have masked WS kills
  // that arrived for other systems. The buffer has them; rebuild from it.
  rebuildKillListFromBuffer();
  unseenLiveKills = 0;
  updateHistoryBanner();
  updateKillCount();
}

// Render the current page of focusKills into the history list element. Also
// updates the page label, prev/next disabled state, and banner.
function renderFocusPage() {
  const total = focusKills.length;
  if (total === 0) {
    const star = starById.get(focusedSystemId);
    const name = star ? displayName(star) : 'this system';
    historyListEl.innerHTML = `<div class="kill-history-empty">${escapeHtml(name)} has been quiet for 24 hours.</div>`;
    historyPageLabelEl.textContent = '';
    historyPrevBtn.disabled = true;
    historyNextBtn.disabled = true;
    historyBannerEl.style.display = 'none';
    updateKillCount();
    return;
  }
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  if (focusPage >= totalPages) focusPage = totalPages - 1;
  if (focusPage < 0) focusPage = 0;
  const start = focusPage * HISTORY_PAGE_SIZE;
  const end = Math.min(start + HISTORY_PAGE_SIZE, total);
  historyListEl.innerHTML = '';
  for (let i = start; i < end; i++) {
    const kill = focusKills[i];
    const star = starById.get(kill.systemId);
    if (!star) continue;
    // Focused mode never shows DELAYED — neither the orange badge nor the
    // 65% row opacity dim. Every kill renders at full opacity regardless of
    // its receivedAt-ts gap. The per-row "Xh ago" timestamp is the only age
    // indicator users need in this view.
    const params = killToParams(kill, star);
    params.isDelayed = false;
    const el = buildKillElement(params);
    // Visibility filter respects all chips EXCEPT delayed (we just forced
    // isDelayed=false, so passing false here is consistent with the rendered state).
    if (!isKillVisible(el.dataset.kind, el.dataset.npc === '1', false, Number(el.dataset.typeid) || null)) {
      el.style.display = 'none';
    }
    historyListEl.appendChild(el);
  }
  historyPageLabelEl.textContent = `Page ${focusPage + 1} / ${totalPages}`;
  historyPrevBtn.disabled = focusPage === 0;
  historyNextBtn.disabled = focusPage >= totalPages - 1;
  // Banner: only visible when user is on page 2+ AND we've accumulated unseen
  // matching kills since they last viewed page 1.
  if (focusPage > 0 && focusUnseenCount > 0) {
    historyBannerEl.style.display = '';
    historyBannerEl.textContent = `${focusUnseenCount} new kill${focusUnseenCount !== 1 ? 's' : ''} — click to return to page 1`;
  } else {
    historyBannerEl.style.display = 'none';
    // If user navigated to page 1, clear the unseen counter.
    if (focusPage === 0) focusUnseenCount = 0;
  }
  updateKillCount();
}

// Called by the WS live-kill handler when a kill arrives for the focused
// system. Either prepends to focusKills directly (post-fetch) or queues
// it (during initial fetch). If user is on page 1, re-render. Otherwise
// bump the new-kill counter and update the banner.
function prependFocusKill(kill) {
  if (focusFetching) {
    focusPendingWsKills.push(kill);
    return;
  }
  // Dedupe (in case the same kill came through both initial fetch and WS).
  if (focusKills.some(k => k.id === kill.id)) return;
  // Filter to 24h window.
  const cutoff = Math.floor((Date.now() - FOCUS_WINDOW_MS) / 1000);
  if (!kill.ts || kill.ts < cutoff) return;
  focusKills.unshift(kill);
  if (focusPage === 0) {
    renderFocusPage();
  } else {
    focusUnseenCount++;
    renderFocusPage();  // updates banner
  }
}

const killHeaderLabelEl = document.getElementById('kill-header-label');
const panelRightEl = document.getElementById('panel-right');

function setKillView(mode) {
  // Focused mode has no separate live/history views — single paginated list.
  // The history toggle button is hidden while focused, but guard here too.
  if (focusedSystemId != null) return;
  killViewMode = mode;
  if (mode === 'history') {
    killList.style.display = 'none';
    historyContainerEl.style.display = 'flex';
    historyToggleBtn.classList.add('on');
    panelRightEl.classList.add('history-mode');
    historyPage = 0;
    renderHistoryPage();
  } else {
    killList.style.display = '';
    historyContainerEl.style.display = 'none';
    historyToggleBtn.classList.remove('on');
    panelRightEl.classList.remove('history-mode');
    // Rebuild the live list from the buffer — kills that arrived while
    // history was open aren't in the DOM yet. Respects focus filter.
    rebuildKillListFromBuffer();
    unseenLiveKills = 0;
    updateKillCount();
  }
  // Header label depends on view mode AND focus state — both branches share
  // this single source of truth.
  updateKillHeaderLabel();
  updateHistoryBanner();
}

historyToggleBtn.addEventListener('click', () => {
  setKillView(killViewMode === 'live' ? 'history' : 'live');
});
historyBannerEl.addEventListener('click', () => {
  // In focused mode the banner says "click to return to page 1" — jump there
  // and clear the unseen counter. In global history mode it says "click to
  // return to Live" — restore the live view.
  if (focusedSystemId != null) {
    focusPage = 0;
    focusUnseenCount = 0;
    renderFocusPage();
  } else {
    setKillView('live');
  }
});
historyPrevBtn.addEventListener('click', () => {
  if (focusedSystemId != null) {
    if (focusPage > 0) { focusPage--; renderFocusPage(); }
  } else {
    if (historyPage > 0) { historyPage--; renderHistoryPage(); }
  }
});
historyNextBtn.addEventListener('click', () => {
  if (focusedSystemId != null) {
    const totalPages = Math.max(1, Math.ceil(focusKills.length / HISTORY_PAGE_SIZE));
    if (focusPage < totalPages - 1) { focusPage++; renderFocusPage(); }
  } else {
    const totalPages = Math.max(1, Math.ceil(killBuffer.length / HISTORY_PAGE_SIZE));
    if (historyPage < totalPages - 1) { historyPage++; renderHistoryPage(); }
  }
});
document.querySelectorAll('#kill-filters .kind-chip').forEach((chip) => {
  const kind = chip.dataset.kind;
  const tag  = chip.dataset.tag;
  if (kind) chip.classList.toggle('on', activeKinds.has(kind));
  if (tag) chip.classList.toggle('on', activeTags.has(tag));
  chip.addEventListener('click', () => {
    if (kind) {
      if (activeKinds.has(kind)) activeKinds.delete(kind);
      else activeKinds.add(kind);
      localStorage.setItem(KILL_KINDS_KEY, JSON.stringify([...activeKinds]));
    } else if (tag) {
      if (activeTags.has(tag)) activeTags.delete(tag);
      else activeTags.add(tag);
      localStorage.setItem(KILL_TAGS_KEY, JSON.stringify([...activeTags]));
    }
    chip.classList.toggle('on');
    applyKillFilters();
  });
});

setInterval(() => {
  const hist = document.getElementById('kill-history-list');
  const ages = [
    ...killList.querySelectorAll('.kill-age'),
    ...(hist ? hist.querySelectorAll('.kill-age') : []),
  ];
  for (const el of ages) {
    const ts = Number(el.dataset.ts) || 0;
    el.textContent = formatAge(ts);
  }
}, 10000);

// --- Kill footer filter toggle -----------------------------------
document.getElementById('kill-footer-toggle').addEventListener('click', () => {
  document.getElementById('kill-footer').classList.toggle('open');
});

// --- Intel footer filter toggle + chips --------------------------
document.getElementById('intel-footer-toggle').addEventListener('click', () => {
  document.getElementById('intel-footer').classList.toggle('open');
});
document.querySelectorAll('#intel-filters .kind-chip').forEach((chip) => {
  const kind = chip.dataset.kind;
  const tag  = chip.dataset.tag;
  if (kind)             chip.classList.toggle('on', intelFilterKinds.has(kind));
  if (tag === 'npc')    chip.classList.toggle('on', intelFilterNpc);
  if (tag === 'shuttle') chip.classList.toggle('on', intelFilterShuttle);
  chip.addEventListener('click', () => {
    if (kind) {
      if (intelFilterKinds.has(kind)) intelFilterKinds.delete(kind);
      else intelFilterKinds.add(kind);
      localStorage.setItem(INTEL_KINDS_KEY, JSON.stringify([...intelFilterKinds]));
    } else if (tag === 'npc') {
      intelFilterNpc = !intelFilterNpc;
      localStorage.setItem(INTEL_NPC_KEY, intelFilterNpc ? '1' : '0');
    } else if (tag === 'shuttle') {
      intelFilterShuttle = !intelFilterShuttle;
      localStorage.setItem(INTEL_SHUTTLE_KEY, intelFilterShuttle ? '1' : '0');
    }
    chip.classList.toggle('on');
    renderIntelAll();
  });
});

// --- Kill list compact-view toggle (persisted) -------------------
const COMPACT_KEY = 'anoikis-kill-compact';
function applyKillCompactState(on) {
  killList.classList.toggle('kill-list--compact', on);
  const hist = document.getElementById('kill-history-list');
  if (hist) hist.classList.toggle('kill-list--compact', on);
  document.getElementById('kill-compact-toggle').classList.toggle('on', on);
}
applyKillCompactState(localStorage.getItem(COMPACT_KEY) === '1');
document.getElementById('kill-compact-toggle').addEventListener('click', () => {
  const on = !killList.classList.contains('kill-list--compact');
  applyKillCompactState(on);
  localStorage.setItem(COMPACT_KEY, on ? '1' : '0');
});

// --- Kill detail popup (final-blow attacker) --------------------
const killPopup      = document.getElementById('kill-popup');
const kpImg          = killPopup.querySelector('.kp-img');
const kpShip         = killPopup.querySelector('.kp-ship');
const kpPilot        = killPopup.querySelector('.kp-pilot');
const kpCorp         = killPopup.querySelector('.kp-corp');
const kpLabel        = killPopup.querySelector('.kp-label');
const kpGang         = killPopup.querySelector('.kp-gang');
let kpOpenKillId     = null;
let kpToken          = 0;

// killId → Promise<{ shipTypeId, characterId, corporationId, isNpc }>
const finalBlowCache = new Map();

async function fetchFinalBlow(killId) {
  if (finalBlowCache.has(killId)) return finalBlowCache.get(killId);
  const p = (async () => {
    const zres = await fetch(`https://zkillboard.com/api/killID/${killId}/`);
    if (!zres.ok) throw new Error('zkb fetch failed');
    const zarr = await zres.json();
    const hash = zarr?.[0]?.zkb?.hash;
    if (!hash) throw new Error('no hash');
    const kres = await fetch(`https://esi.evetech.net/latest/killmails/${killId}/${hash}/`);
    if (!kres.ok) throw new Error('esi killmail failed');
    const km = await kres.json();
    const fb = km.attackers?.find((a) => a.final_blow) || km.attackers?.[0];
    if (!fb) throw new Error('no final blow');
    return {
      shipTypeId:    fb.ship_type_id ?? null,
      characterId:   fb.character_id ?? null,
      corporationId: fb.corporation_id ?? null,
      isNpc:         !fb.character_id,
      attackerCount: Array.isArray(km.attackers) ? km.attackers.length : null,
    };
  })();
  finalBlowCache.set(killId, p);
  p.catch(() => finalBlowCache.delete(killId));
  return p;
}

function positionKillPopup(rowEl) {
  const rowRect = rowEl.getBoundingClientRect();
  let top = rowRect.top;
  const popupH = killPopup.offsetHeight || 100;
  if (top + popupH > window.innerHeight - 10) top = window.innerHeight - popupH - 10;
  if (top < 10) top = 10;
  killPopup.style.top = top + 'px';
}

function closeKillPopup() {
  killPopup.classList.remove('open');
  kpOpenKillId = null;
}

function renderKillPopupBody(fb, token) {
  if (typeof fb.attackerCount === 'number' && fb.attackerCount > 0) {
    kpGang.textContent = fb.attackerCount === 1
      ? 'SOLO'
      : `+${fb.attackerCount - 1} other${fb.attackerCount - 1 === 1 ? '' : 's'}`;
  } else {
    kpGang.textContent = '';
  }
  if (fb.shipTypeId != null) {
    kpImg.style.backgroundImage = `url('https://images.evetech.net/types/${fb.shipTypeId}/render?size=64')`;
    const localName = window.TYPE_NAMES?.[fb.shipTypeId];
    if (localName) {
      kpShip.textContent = localName;
    } else {
      kpShip.textContent = 'Type ' + fb.shipTypeId;
      resolveType(fb.shipTypeId, kpShip, null);
    }
  } else {
    kpShip.textContent = 'Unknown ship';
  }
  // Label rule:
  //  - Has character_id  → Final blow (pilot + corp render normally).
  //  - No character_id but has corporation_id → Final blow (e.g. Astrahus
  //    structure final-blowing a ship). Pilot line is 'o7', corp shows.
  //  - Neither character nor corp → NPC KILL (true rat kill — Sansha etc.).
  // The zKB-derived `isNpc` flag is too coarse on its own: it's true for both
  // structure final-blows AND rat final-blows. Using the attacker shape is
  // accurate. The intel kill card already handles this correctly.
  if (fb.characterId) {
    kpLabel.textContent = 'Final blow';
    kpPilot.textContent = 'Loading…';
    resolveEntityName('char', fb.characterId).then((name) => {
      if (token !== kpToken) return;
      kpPilot.textContent = name || 'Unknown pilot';
    });
  } else if (fb.corporationId) {
    kpLabel.textContent = 'Final blow';
    kpPilot.textContent = 'o7';
  } else {
    kpLabel.textContent = 'NPC KILL';
    kpPilot.textContent = 'o7';
  }
  if (fb.corporationId) {
    kpCorp.textContent = 'Loading…';
    resolveEntityName('corp', fb.corporationId).then((name) => {
      if (token !== kpToken) return;
      kpCorp.textContent = name || '';
    });
  } else {
    kpCorp.textContent = '';
  }
}

async function openKillPopup(rowEl, killId) {
  if (kpOpenKillId === killId) return;
  kpOpenKillId = killId;
  const token = ++kpToken;
  kpImg.style.backgroundImage = '';
  kpShip.textContent  = 'Loading…';
  kpPilot.textContent = '';
  kpCorp.textContent  = '';
  kpLabel.textContent = 'Final blow';
  kpGang.textContent  = '';
  killPopup.classList.toggle('compact', killList.classList.contains('kill-list--compact'));
  killPopup.classList.add('open');
  positionKillPopup(rowEl);

  // Fast path — backend now includes final-blow fields in the WS payload.
  const entry = killBuffer.find((e) => e.kill.id === killId);
  const raw = entry?.kill;
  if (raw && raw.fbShipTypeId != null) {
    renderKillPopupBody({
      shipTypeId:    raw.fbShipTypeId,
      characterId:   raw.fbCharacterId,
      corporationId: raw.fbCorporationId,
      isNpc:         !raw.fbCharacterId,
      attackerCount: typeof raw.attackerCount === 'number' ? raw.attackerCount : null,
    }, token);
    positionKillPopup(rowEl);
    return;
  }

  // Fallback — older tabs / kills from before the backend deploy.
  try {
    const fb = await fetchFinalBlow(killId);
    if (token !== kpToken) return;
    renderKillPopupBody(fb, token);
    positionKillPopup(rowEl);
  } catch {
    if (token !== kpToken) return;
    kpShip.textContent  = 'Failed to load';
    kpPilot.textContent = '';
    kpCorp.textContent  = '';
  }
}

// --- Inline final blow (mobile / touch) --------------------------
let inlineFbEl = null;

function closeInlineFinalBlow() {
  if (inlineFbEl) { inlineFbEl.remove(); inlineFbEl = null; }
}

function renderInlineFb(fb, imgEl, shipEl, pilotEl, corpEl, labelEl, guardEl, gangEl) {
  if (gangEl) {
    if (typeof fb.attackerCount === 'number' && fb.attackerCount > 0) {
      gangEl.textContent = fb.attackerCount === 1
        ? 'SOLO'
        : `+${fb.attackerCount - 1} other${fb.attackerCount - 1 === 1 ? '' : 's'}`;
    } else {
      gangEl.textContent = '';
    }
  }
  if (fb.shipTypeId != null) {
    imgEl.style.backgroundImage = `url('https://images.evetech.net/types/${fb.shipTypeId}/render?size=64')`;
    const localName = window.TYPE_NAMES?.[fb.shipTypeId];
    if (localName) shipEl.textContent = localName;
    else { shipEl.textContent = 'Type ' + fb.shipTypeId; resolveType(fb.shipTypeId, shipEl, null); }
  } else { shipEl.textContent = 'Unknown ship'; }
  // Same label rule as the desktop popup — see renderKillPopupBody for why.
  // character → Final blow + name + corp.
  // no character but corporation → Final blow + 'o7' + corp (e.g. Astrahus).
  // neither → NPC KILL + 'o7' (true rat).
  if (fb.characterId) {
    labelEl.textContent = 'Final blow';
    pilotEl.textContent = 'Loading…';
    resolveEntityName('char', fb.characterId).then((n) => {
      if (inlineFbEl !== guardEl) return;
      pilotEl.textContent = n || 'Unknown pilot';
    });
  } else if (fb.corporationId) {
    labelEl.textContent = 'Final blow';
    pilotEl.textContent = 'o7';
  } else {
    labelEl.textContent = 'NPC KILL';
    pilotEl.textContent = 'o7';
  }
  if (fb.corporationId) {
    corpEl.textContent = 'Loading…';
    resolveEntityName('corp', fb.corporationId).then((n) => {
      if (inlineFbEl !== guardEl) return;
      corpEl.textContent = n || '';
    });
  } else { corpEl.textContent = ''; }
}

async function openInlineFinalBlow(rowEl, killId) {
  const container = rowEl.querySelector('.kill-main');
  if (inlineFbEl && inlineFbEl.parentElement === container) {
    closeInlineFinalBlow(); return;
  }
  closeInlineFinalBlow();
  const fb = document.createElement('div');
  fb.className = 'kill-fb-inline';
  fb.innerHTML = `<div class="kp-img"></div><div class="kp-info"><div class="kp-hdr"><div class="kp-label">Final blow</div><div class="kp-gang"></div></div><div class="kp-ship">Loading…</div><div class="kp-pilot"></div><div class="kp-corp"></div></div>`;
  container.appendChild(fb);
  inlineFbEl = fb;
  fb.addEventListener('click', (ev) => ev.stopPropagation());

  const imgEl = fb.querySelector('.kp-img');
  const shipEl = fb.querySelector('.kp-ship');
  const pilotEl = fb.querySelector('.kp-pilot');
  const corpEl = fb.querySelector('.kp-corp');
  const labelEl = fb.querySelector('.kp-label');
  const gangEl = fb.querySelector('.kp-gang');

  const entry = killBuffer.find((e) => e.kill.id === killId);
  const raw = entry?.kill;
  if (raw && raw.fbShipTypeId != null) {
    renderInlineFb({
      shipTypeId:    raw.fbShipTypeId,
      characterId:   raw.fbCharacterId,
      corporationId: raw.fbCorporationId,
      isNpc:         !raw.fbCharacterId,
      attackerCount: typeof raw.attackerCount === 'number' ? raw.attackerCount : null,
    }, imgEl, shipEl, pilotEl, corpEl, labelEl, fb, gangEl);
    return;
  }
  try {
    const data = await fetchFinalBlow(killId);
    if (inlineFbEl !== fb) return;
    renderInlineFb(data, imgEl, shipEl, pilotEl, corpEl, labelEl, fb, gangEl);
  } catch {
    if (inlineFbEl !== fb) return;
    shipEl.textContent = 'Failed to load';
  }
}

// --- Live backend WS ---------------------------------------------
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
const WS_URL = window.ANOIKIS_WS_URL || (IS_LOCAL ? 'ws://localhost:8080/ws' : 'wss://ws.anoikis.info/ws');

function connectKillFeed() {
  let backoff = 1000;
  let reconnectTimer = null;
  function schedule() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
  function open() {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      schedule();
      return;
    }
    ws.addEventListener('open', () => { backoff = 1000; });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot' && Array.isArray(msg.kills)) {
        for (const k of msg.kills) stampKill(k);
        // Fill buffer newest-first from the full ring (up to HISTORY_BUFFER_SIZE).
        killBuffer.length = 0;
        for (let i = msg.kills.length - 1; i >= 0 && killBuffer.length < HISTORY_BUFFER_SIZE; i--) {
          const k = msg.kills[i];
          const star = starById.get(k.systemId);
          if (star) killBuffer.push({ kill: k, star });
        }
        // Render the most recent MAX_KILLS non-history-only kills to the live
        // list. Filter first so history-only kills don't take live slots only
        // to be dropped by spawnLiveKill — that would leave the live list
        // shorter than MAX_KILLS even when there's plenty of fresh activity.
        // Skip the live-list render entirely while focused — focused mode
        // owns its own rendering pipeline (renderFocusPage from /intel).
        if (focusedSystemId == null) {
          killList.innerHTML = '';
          const recent = msg.kills.filter(k => !k._isHistoryOnly).slice(-MAX_KILLS);
          for (const k of recent) handleBackendKill(k, false);
          if (killViewMode === 'history') renderHistoryPage();
        }
      } else if (msg.type === 'kill' && msg.kill) {
        stampKill(msg.kill);
        const star = starById.get(msg.kill.systemId);
        if (star) pushToBuffer(msg.kill, star);
        // Map animation always fires regardless of focus state.
        if (focusedSystemId != null) {
          if (msg.kill.systemId === focusedSystemId) {
            // Kill is for the focused system — feed it into the focused list.
            // prependFocusKill handles the page-1 render or banner increment,
            // and queues the kill if /intel is still being fetched.
            prependFocusKill(msg.kill);
            if (star && !msg.kill._isHistoryOnly) {
              triggerKillAnim(star, !!msg.kill._isDelayed, msg.kill.kind, msg.kill.shipTypeId);
              flashRestoreRight();
            }
          } else if (star && !msg.kill._isHistoryOnly) {
            // Kill is for a different system — pulse the map but skip the
            // focused list. Buffer push above keeps it for global history if
            // user later exits focus.
            triggerKillAnim(star, !!msg.kill._isDelayed, msg.kill.kind, msg.kill.shipTypeId);
          }
        } else if (killViewMode === 'live') {
          // handleBackendKill -> spawnLiveKill self-gates on isHistoryOnly,
          // so this is a no-op for >16h kills.
          handleBackendKill(msg.kill, true);
          // History-only kill arriving while user is in live mode: re-render
          // history if they happen to scroll to it later. No-op now since
          // we're not in history view, but if they switch they'll see it.
        } else {
          // History view. Animate + flash + banner only for kills that would
          // actually be visible in live view (i.e. not history-only). For
          // history-only kills we just re-render the page so they appear at
          // their chronological position.
          if (!msg.kill._isHistoryOnly) {
            if (star) triggerKillAnim(star, !!msg.kill._isDelayed, msg.kill.kind, msg.kill.shipTypeId);
            unseenLiveKills++;
            updateHistoryBanner();
            flashRestoreRight();
          } else {
            renderHistoryPage();
          }
        }
        // (Thera connection handlers are in the else-if chain below.)
        // Live-inject into the intel cache so re-opening a recently-viewed
        // system shows kills that arrived after its last fetch — closes the
        // race where a kill broadcasts on the live feed a moment after the
        // panel cached its /intel response and the 15-min TTL would otherwise
        // serve a stale list. While the panel is OPEN for this same system,
        // intelCurrentKills is the same array reference as the cache entry's
        // kills, so we push once and re-render; while closed, we just push.
        {
          const k = msg.kill;
          const isOpenForThisSystem = intelOpen && intelCurrentKills && intelCurrentStar
            && k.systemId === intelCurrentStar.id;
          const cached = intelKillCache.get(k.systemId);
          const cacheArr = (cached && !cached.pending) ? cached.kills : null;
          // Same array when intel is open for this system (loadIntel assigns
          // intelCurrentKills = cached.kills by reference). Pick one target.
          const target = isOpenForThisSystem ? intelCurrentKills : cacheArr;
          if (target) {
            // Synthesize the final-blow attacker so the Recent tab can render
            // the FB side of an engagement card without waiting for a reload.
            const synthAttackers = k.fbShipTypeId != null ? [{
              final_blow: true,
              ship_type_id: k.fbShipTypeId,
              character_id: k.fbCharacterId,
              corporation_id: k.fbCorporationId,
            }] : [];
            target.push({
              // Flat WS-shape fields: required by focus-mode rendering
              // (renderFocusPage → killToParams) and by the intel cache
              // dedupe-by-id lookup.
              id: k.id,
              systemId: k.systemId,
              ts: k.ts,
              shipTypeId: k.shipTypeId,
              characterId: k.characterId,
              corporationId: k.corporationId,
              value: k.value,
              receivedAt: k.receivedAt,
              fbShipTypeId: k.fbShipTypeId,
              fbCharacterId: k.fbCharacterId,
              fbCorporationId: k.fbCorporationId,
              attackerCount: k.attackerCount,
              _isDelayed: k._isDelayed,
              _isHistoryOnly: k._isHistoryOnly,
              // Intel-shape fields: used by the intel panel's aggregators
              // and the Recent tab's engagement cards.
              killmail_time: new Date(k.ts * 1000).toISOString(),
              kind: k.kind,
              isNpc: k.isNpc,
              hasImplants: !!k.hasImplants,
              _zkbValue: k.value,
              _attackerCount: typeof k.attackerCount === 'number' ? k.attackerCount : null,
              victim: {
                character_id: k.characterId,
                corporation_id: k.corporationId,
                alliance_id: null,
                ship_type_id: k.shipTypeId,
              },
              attackers: synthAttackers,
            });
          }
          if (isOpenForThisSystem) {
            // Cheap sections — re-render every live kill (no throttle):
            const short = intelAggregateShort(intelCurrentKills, intelRangeShort);
            renderHmShort(short.counts, intelCurrentRgb, intelRangeShort);
            renderLiveness();
            if (intelView === 'recent') renderIntelRecent();
            if (intelView === 'scatter') {
              // Mark the new kill so its dot pulses larger then settles.
              // Triggers the rAF loop that drives the size animation.
              markFreshKill(k.id);
              renderScatter();
            }
            updateFilteredCount();
            // Heavy sections — re-aggregate over 30-60d data, batched
            // through a 3-second trailing throttle so bursts of kills
            // don't thrash the DOM. See scheduleHeavyRender().
            scheduleHeavyRender();
          }
        }
      } else if (
        (msg.type === 'thera-snapshot' || msg.type === 'thera')
        && Array.isArray(msg.connections)
      ) {
        theraConnections = msg.connections;
        renderTheraConnectionList();
      }
    });
    ws.addEventListener('close', schedule);
    ws.addEventListener('error', () => { /* close fires right after */ });
  }
  open();
}
connectKillFeed();

// --- Copy-link button (next to J-code in system info panel) -----
{
  const btn = document.getElementById('si-copy-link');
  btn.addEventListener('click', async () => {
    if (!selected) return;
    const base = location.protocol === 'file:'
      ? 'https://anoikis.info/'
      : `${location.origin}${location.pathname}`;
    const url = `${base}?sys=${selected.name.replace(/ /g, '_')}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    const panel = document.getElementById('system-info');
    btn.classList.add('copied');
    panel.classList.add('si-copied');
    setTimeout(() => {
      btn.classList.remove('copied');
      panel.classList.remove('si-copied');
    }, 1200);
  });
}

// --- URL deep-link: ?sys=J121856 flies to the system on load ----
{
  const raw = new URLSearchParams(location.search).get('sys');
  if (raw) {
    const name = raw.replace(/_/g, ' ');
    const s = stars.find((st) => st.name.toLowerCase() === name.toLowerCase());
    if (s) {
      initialUrlSys = s.name.toUpperCase();
      selectStar(s, true);
    } else {
      clearUrlSysParam();
    }
  }
}

// --- Info modal --------------------------------------------------
{
  const backdrop = document.getElementById('info-backdrop');
  const tabAbout = document.getElementById('info-tab-about');
  const tabLegal = document.getElementById('info-tab-legal');
  const bodyAbout = document.getElementById('info-body-about');
  const bodyLegal = document.getElementById('info-body-legal');

  const statusDot = document.querySelector('.info-status-dot');

  // Mirrors status.html's computeBadge — three states sharing one source of
  // truth. Green = nominal, yellow = degraded (poller or partial), red =
  // backend unreachable or poller down. Dot only refreshes on modal open.
  function checkBackendStatus() {
    if (!statusDot) return;
    statusDot.className = 'info-status-dot';
    fetch(intelApiBase() + '/health', { signal: AbortSignal.timeout(5000) })
      .then(r => r.json())
      .then(h => {
        if (!h.ok) { statusDot.classList.add('yellow'); return; }
        const pollAge = h.lastPollAt ? Date.now() - h.lastPollAt : Infinity;
        if (pollAge > 60_000) { statusDot.classList.add('red');    return; }
        if (pollAge > 30_000) { statusDot.classList.add('yellow'); return; }
        const zk = h.zkill || '';
        if (zk.startsWith('error:'))       { statusDot.classList.add('yellow'); return; }
        const es = h.evescout || '';
        if (es.startsWith('error:'))       { statusDot.classList.add('yellow'); return; }
        statusDot.classList.add('green');
      })
      .catch(() => { statusDot.classList.add('red'); });
  }

  document.getElementById('info-btn').addEventListener('click', () => {
    backdrop.classList.add('open');
    checkBackendStatus();
  });
  document.getElementById('info-close').addEventListener('click', () => {
    backdrop.classList.remove('open');
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.classList.remove('open');
  });
  // Mobile: tapping any of the four bottom-nav icons closes the info modal
  // before its own handler runs. Delegated on the .mobile-nav container so
  // future buttons added there inherit this behavior automatically.
  document.querySelector('.mobile-nav')?.addEventListener('click', () => {
    backdrop.classList.remove('open');
  });

  tabAbout.addEventListener('click', () => {
    tabAbout.classList.add('on'); tabLegal.classList.remove('on');
    bodyAbout.style.display = ''; bodyLegal.style.display = 'none';
  });
  tabLegal.addEventListener('click', () => {
    tabLegal.classList.add('on'); tabAbout.classList.remove('on');
    bodyLegal.style.display = ''; bodyAbout.style.display = 'none';
  });
}

// --- Go ----------------------------------------------------------
requestAnimationFrame(draw);
