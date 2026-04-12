// map.anoikis.info — main script
// Canvas 2D map of Anoikis (wormhole) space with live zKillboard kill feed.
// Data globals loaded before this script: window.ANOIKIS_SYSTEMS, window.TYPE_NAMES, window.TYPE_KINDS.

// --- Constants ---------------------------------------------------
const MIN_SCALE = 0.56;
const MAX_SCALE = 35;
const FLARE_MS = 1100;
const RING_MS  = 2000;

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
let currentPalette = 'ghost';

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
  planets: s.planets || [],
  statics: [],
  twinklePhase: Math.random() * Math.PI * 2,
  twinkleSpeed: 0.55 + Math.random() * 0.9,
  flareUntil: 0
}));
document.getElementById('star-count').textContent = stars.length + ' systems';
// systemID -> star, used by the live kill feed to resolve incoming IDs.
const starById = new Map(stars.map((s) => [s.id, s]));

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

function computeResetTarget() {
  const padding = 50;
  const cw = window.innerWidth, ch = window.innerHeight;
  const mapW = starBounds.maxX - starBounds.minX;
  const mapH = starBounds.maxY - starBounds.minY;
  const scale = clamp(
    Math.min((cw - padding * 2) / mapW, (ch - padding * 2) / mapH),
    MIN_SCALE, 1.5
  );
  return {
    scale,
    offsetX: cw / 2 - ((starBounds.minX + starBounds.maxX) / 2) * scale,
    offsetY: ch / 2 - ((starBounds.minY + starBounds.maxY) / 2) * scale
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

let showLabels = false;

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
  6: [255,228,110], 3802: [255,228,110], 45030: [255,228,110], 45041: [255,228,110], 45047: [255,170,60],
  // K Orange
  7: [255,152,52], 45031: [255,152,52], 45032: [255,152,52],
  3798: [255,162,62], 3800: [255,142,48], 45037: [255,162,62], 45039: [255,142,48], 45040: [255,142,48],
  // K5 Red Giant
  8: [255,72,22], 45033: [255,72,22],
  // B0 Blue
  9: [112,182,255], 45034: [112,182,255], 45046: [112,182,255],
  // F0 White
  10: [255,255,250], 45035: [255,250,218],
  // O1 Bright Blue
  3796: [72,142,255],
  // G5 Pink
  3797: [244,178,226], 3799: [238,170,222], 45036: [255,168,188], 45038: [255,162,182],
  // A0 Blue Small
  3801: [152,192,255], 34331: [200,188,248],
  // B5 White Dwarf
  3803: [192,218,255], 45042: [192,218,255],
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

    const moonCount = Math.min(p.moons || 0, 6);
    for (let m = 0; m < moonCount; m++) {
      const mBase  = (m / moonCount) * Math.PI * 2;
      const mAngle = orreryRotate ? mBase + t * omega * 6 : mBase;
      const mDist  = pR + 5 + m * 2.5;
      oc.fillStyle = 'rgba(160,160,160,0.65)';
      oc.beginPath();
      oc.arc(px + Math.cos(mAngle) * mDist, py + Math.sin(mAngle) * mDist, 1.5, 0, Math.PI * 2);
      oc.fill();
    }

    orreryHits.push({ x: px, y: py, hitR: pR + 5, typeId: p.typeId, ci: p.ci || 0, moons: p.moons || 0 });
  }

  // List-row hover trace: dashed line from the hovered row's image to the matching hit.
  if (orreryListHover) {
    const hit = orreryListHover.isSun
      ? orreryHits.find(h => h.isSun)
      : orreryHits.find(h => !h.isSun && h.ci === orreryListHover.ci);
    if (hit) {
      const canvRect = orreryCanvas.getBoundingClientRect();
      const imgRect  = orreryListHover.imgEl.getBoundingClientRect();
      const bx = imgRect.left + imgRect.width  / 2 - canvRect.left;
      const by = imgRect.top  + imgRect.height / 2 - canvRect.top;
      const endColor = orreryListHover.isSun
        ? `rgba(${(SUN_COLORS[orreryListHover.typeId] || [255,220,100]).join(',')},0.55)`
        : `rgba(${planetRGB(orreryListHover.typeId).join(',')},0.55)`;
      const grad = oc.createLinearGradient(bx, by, hit.x, hit.y);
      grad.addColorStop(0, 'rgba(0,200,200,0.85)');
      grad.addColorStop(1, endColor.replace(/[\d.]+\)$/, '0.85)'));
      oc.strokeStyle = grad;
      oc.lineWidth = 1.5;
      oc.setLineDash([5, 5]);
      oc.beginPath();
      oc.moveTo(bx, by);
      oc.lineTo(hit.x, hit.y);
      oc.stroke();
      oc.setLineDash([]);
    }
  }

  oc.restore();
}

function updateOrreryHeader(star) {
  document.getElementById('orrery-title').textContent = displayName(star) + ' · ' + displayClass(star);
  document.getElementById('orrery-planet-count').textContent = star.planets.length + ' planet' + (star.planets.length !== 1 ? 's' : '');
}

function buildOrreryList(star) {
  const el = document.getElementById('orrery-list');
  el.innerHTML = '';

  function attachRowHover(row, hoverData) {
    const img = row.querySelector('.olist-img');
    row.addEventListener('mouseenter', () => { orreryListHover = { imgEl: img, ...hoverData }; });
    row.addEventListener('mouseleave', () => { orreryListHover = null; });
  }

  // Sun row.
  if (star.sunTypeId) {
    const row = document.createElement('div');
    row.className = 'olist-row';
    row.innerHTML =
      `<img class="olist-img" src="https://images.evetech.net/types/${star.sunTypeId}/icon?size=64" alt="" loading="lazy">` +
      `<div><div class="olist-name">${escapeHtml(star.name)} Star</div>` +
      `<div class="olist-sub">${escapeHtml((SUN_NAMES[star.sunTypeId] || 'Sun').replace(/\s*\(.*\)$/, ''))}</div></div>`;
    el.appendChild(row);
    attachRowHover(row, { isSun: true });
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

function openOrrery(star) {
  if (intelOpen) closeIntel();
  orreryOpen = true;
  orreryPanel.classList.add('open');
  updateOrreryHeader(star);
  buildOrreryList(star);
  document.getElementById('si-system-view').classList.add('active');
}

function closeOrrery() {
  orreryOpen      = false;
  orreryListHover = null;
  orreryPanel.classList.remove('open');
  orreryTip.textContent = '';
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

function buildHmCell(count, max, rgb, tipText) {
  const cell = document.createElement('div');
  cell.className = 'intel-hm-cell';
  cell.style.background = heatColor(count, max, rgb);
  cell.dataset.tip = tipText;
  return cell;
}

function utcToLocalHour(utcH) {
  const offsetMin = new Date().getTimezoneOffset();
  return ((utcH - offsetMin / 60) % 24 + 24) % 24;
}

function buildBarCell(count, max, rgb, tipText) {
  const col = document.createElement('div');
  col.style.cssText = 'flex:1;display:flex;align-items:flex-end;min-width:0;';
  col.dataset.tip = tipText;
  const bar = document.createElement('div');
  const h = max > 0 ? Math.max(count > 0 ? 8 : 0, Math.round((count / max) * 100)) : 0;
  const alpha = count > 0 ? 0.45 + 0.55 * (count / max) : 0;
  bar.style.cssText =
    `width:100%;height:${h}%;` +
    `background:${count > 0 ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(2)})` : 'rgba(13,31,31,1)'};` +
    `border-radius:2px 2px 0 0;transition:opacity 0.1s;`;
  col.appendChild(bar);
  return col;
}

function renderHm24(hourly24, rgb) {
  const grid   = document.getElementById('intel-hm24');
  const labels = document.getElementById('intel-hm24-labels');
  grid.innerHTML = labels.innerHTML = '';
  grid.style.alignItems = 'flex-end';
  const max = Math.max(...hourly24, 1);
  const total24 = hourly24.reduce((s, v) => s + v, 0);
  document.getElementById('intel-count-24h').textContent =
    `${total24} kill${total24 !== 1 ? 's' : ''}`;
  const now = new Date();
  const curH = now.getUTCHours();
  for (let i = 0; i < 24; i++) {
    const h    = (curH - 23 + i + 24) % 24;
    const hStr = String(h).padStart(2, '0');
    const locH = String(Math.floor(utcToLocalHour(h))).padStart(2, '0');
    const c    = hourly24[i];
    grid.appendChild(buildBarCell(c, max, rgb,
      `EVE Time  ${hStr}:00\nLocal     ${locH}:00\n${c} kill${c !== 1 ? 's' : ''}`));
    const lbl = document.createElement('div');
    lbl.className = 'intel-hlabel';
    lbl.textContent = (h % 6 === 0) ? hStr : '';
    labels.appendChild(lbl);
  }
}

function renderMarginals(matrix60, rgb) {
  // Compute marginals from the 60-day matrix.
  const hourTotals = new Array(24).fill(0);
  const dowTotals  = new Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const c = matrix60[d][h];
      hourTotals[h] += c;
      dowTotals[d]  += c;
    }
  }
  const hourMax = Math.max(...hourTotals, 1);
  const dowMax  = Math.max(...dowTotals, 1);

  // Inject container after the 60×24 wrap if not present.
  let box = document.getElementById('intel-marginals');
  if (!box) {
    box = document.createElement('div');
    box.id = 'intel-marginals';
    box.style.cssText = 'margin-top:10px;';
    const wrap = document.querySelector('.intel-hm60-wrap');
    wrap.parentNode.insertBefore(box, wrap.nextSibling);
  }
  box.innerHTML = '';

  // --- Hour-of-day bar chart (aligned under the 60×24 grid) ---
  const hourLabel = document.createElement('div');
  hourLabel.className = 'intel-section-label';
  hourLabel.style.marginTop = '8px';
  hourLabel.innerHTML = '<span>By Hour of Day</span>';
  box.appendChild(hourLabel);

  const hourWrap = document.createElement('div');
  hourWrap.style.cssText = 'display:flex;gap:4px;align-items:flex-start;';
  const hourSpacer = document.createElement('div');
  hourSpacer.style.cssText = 'width:26px;flex-shrink:0;'; // match .intel-dlabel width
  hourWrap.appendChild(hourSpacer);

  const hourBars = document.createElement('div');
  hourBars.style.cssText = 'flex:1;display:flex;gap:2px;height:36px;align-items:flex-end;min-width:0;';
  for (let h = 0; h < 24; h++) {
    const hStr = String(h).padStart(2, '0');
    const locH = String(Math.floor(utcToLocalHour(h))).padStart(2, '0');
    hourBars.appendChild(buildBarCell(hourTotals[h], hourMax, rgb,
      `EVE Time  ${hStr}:00\nLocal     ${locH}:00\n${hourTotals[h]} kill${hourTotals[h] !== 1 ? 's' : ''} (60d)`));
  }
  hourWrap.appendChild(hourBars);
  box.appendChild(hourWrap);

  // --- Day-of-week horizontal bar chart ---
  const dowLabel = document.createElement('div');
  dowLabel.className = 'intel-section-label';
  dowLabel.innerHTML = '<span>By Day of Week</span>';
  box.appendChild(dowLabel);

  const dowBox = document.createElement('div');
  dowBox.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
  for (const dow of DAY_ORDER) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;height:14px;';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'width:26px;font-size:9px;color:var(--dim);text-align:right;';
    lbl.textContent = DAY_LABELS[dow];
    row.appendChild(lbl);
    const track = document.createElement('div');
    track.style.cssText = 'flex:1;height:100%;background:rgba(13,31,31,1);border-radius:2px;overflow:hidden;';
    const bar = document.createElement('div');
    const w = Math.round((dowTotals[dow] / dowMax) * 100);
    const alpha = 0.45 + 0.55 * (dowTotals[dow] / dowMax);
    bar.style.cssText =
      `width:${w}%;height:100%;` +
      `background:rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(2)});`;
    track.appendChild(bar);
    row.appendChild(track);
    const cnt = document.createElement('div');
    cnt.style.cssText = 'width:30px;font-size:9px;color:var(--muted);text-align:right;';
    cnt.textContent = dowTotals[dow];
    row.appendChild(cnt);
    row.dataset.tip = `${DAY_LABELS[dow]} — ${dowTotals[dow]} kill${dowTotals[dow] !== 1 ? 's' : ''} (60d)`;
    dowBox.appendChild(row);
  }
  box.appendChild(dowBox);
}

function renderHm60(matrix60, rgb) {
  const grid   = document.getElementById('intel-hm60');
  const labels = document.getElementById('intel-hm60-labels');
  const dlbls  = document.getElementById('intel-dlabels');
  grid.innerHTML = labels.innerHTML = dlbls.innerHTML = '';
  const flatMax = Math.max(...matrix60.flat(), 1);
  for (const dow of DAY_ORDER) {
    const dlbl = document.createElement('div');
    dlbl.className = 'intel-dlabel';
    dlbl.textContent = DAY_LABELS[dow];
    dlbls.appendChild(dlbl);
    const row = document.createElement('div');
    row.className = 'intel-hm60-row';
    for (let hr = 0; hr < 24; hr++) {
      const c    = matrix60[dow][hr];
      const hStr = String(hr).padStart(2, '0');
      const locH = String(Math.floor(utcToLocalHour(hr))).padStart(2, '0');
      row.appendChild(buildHmCell(c, flatMax, rgb,
        `EVE Time  ${hStr}:00\nLocal     ${locH}:00\n${DAY_LABELS[dow]} — ${c} kill${c !== 1 ? 's' : ''}`));
    }
    grid.appendChild(row);
  }
  for (let hr = 0; hr < 24; hr++) {
    const lbl = document.createElement('div');
    lbl.className = 'intel-hlabel';
    lbl.textContent = (hr % 6 === 0) ? String(hr).padStart(2, '0') : '';
    labels.appendChild(lbl);
  }
}

function renderEntityList(containerId, items, kind) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  if (!items.length) {
    el.innerHTML = '<div class="intel-empty">None</div>';
    return;
  }
  for (const item of items) {
    const row  = document.createElement('div');
    row.className = 'intel-entity-row';
    const link = document.createElement('a');
    link.href      = `https://zkillboard.com/${kind}/${item.id}/`;
    link.target    = '_blank';
    link.rel       = 'noopener';
    link.className = 'intel-entity-link';
    link.textContent = item.name;
    const cnt  = document.createElement('span');
    cnt.className  = 'intel-entity-count';
    cnt.textContent = item.count;
    row.appendChild(link);
    row.appendChild(cnt);
    el.appendChild(row);
  }
}

function renderIntel(star, data) {
  document.getElementById('intel-loading').style.display = 'none';
  document.getElementById('intel-body').style.display    = '';
  document.getElementById('intel-count-60d').textContent =
    `${data.killCount} kill${data.killCount !== 1 ? 's' : ''}`;
  const rgb = starColor(star);
  renderHm24(data.hourly24, rgb);
  renderHm60(data.matrix60, rgb);
  renderMarginals(data.matrix60, rgb);
  renderEntityList('intel-corps',     data.corps,     'corporation');
  renderEntityList('intel-alliances', data.alliances, 'alliance');
}

async function loadIntel(star) {
  const base = (location.hostname === 'localhost' ||
                location.hostname === '127.0.0.1' ||
                location.protocol === 'file:')
    ? 'http://localhost:8080'
    : 'https://ws.anoikis.info';
  try {
    const res = await fetch(`${base}/intel/${star.id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderIntel(star, data);
  } catch {
    const el = document.getElementById('intel-loading');
    el.textContent = 'Failed to load. Try again later.';
  }
}

function openIntel(star) {
  if (orreryOpen) closeOrrery();
  intelOpen = true;
  intelPanel.classList.add('open');
  document.getElementById('intel-title').textContent =
    displayName(star) + ' · ' + displayClass(star);
  document.getElementById('intel-subtitle').textContent = '';
  document.getElementById('intel-loading').style.display = '';
  document.getElementById('intel-body').style.display    = 'none';
  document.getElementById('intel-count-24h').textContent = '';
  document.getElementById('intel-count-60d').textContent = '';
  document.getElementById('si-intel').classList.add('active');
  loadIntel(star);
}

function closeIntel() {
  intelOpen = false;
  intelPanel.classList.remove('open');
  document.getElementById('si-intel').classList.remove('active');
}

document.getElementById('close-intel').addEventListener('click', closeIntel);

document.getElementById('si-intel').addEventListener('click', () => {
  if (!selected) return;
  if (intelOpen) closeIntel();
  else openIntel(selected);
});

// --- Kill animations --------------------------------------------
const activeAnims = [];
function triggerKillAnim(star) {
  const now = performance.now();
  star.flareUntil = now + FLARE_MS;
  activeAnims.push({ star, t0: now, dur: RING_MS });
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

    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = clamp(0.16 + intensity * 0.24 * glowFactor, 0.10, 0.56 + flare * 0.35);
    ctx.drawImage(spr, p.x - size / 2, p.y - size / 2, size, size);

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
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'lighter';

  ctx.globalCompositeOperation = 'lighter';
  for (let i = activeAnims.length - 1; i >= 0; i--) {
    const a = activeAnims[i];
    const t = (now - a.t0) / a.dur;
    if (t >= 1) { activeAnims.splice(i, 1); continue; }
    const p = worldToScreen(a.star.x, a.star.y);
    if (p.x < -200 || p.x > cw + 200 || p.y < -200 || p.y > ch + 200) continue;
    const zoomK = clamp(camera.scale, 0.5, 1.8);
    const radius = (10 + t * 70) * zoomK;
    const alpha = Math.pow(1 - t, 1.6);
    const color = starColor(a.star);
    ctx.strokeStyle = rgba(color, 0.70 * alpha);
    ctx.lineWidth = 1.7 + alpha * 1.3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (showLabels && camera.scale > 2.4) {
    ctx.globalCompositeOperation = 'source-over';
    const labelAlpha = Math.min(1, (camera.scale - 2.4) / 1.5);
    const labelSize = 11 + clamp((camera.scale - 2.4) / 3.6, 0, 1) * 4;
    const labelOffset = 6 + labelSize * 0.25;
    ctx.font = labelSize.toFixed(1) + 'px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(232,239,255,${labelAlpha * 0.85})`;
    for (const s of stars) {
      if (s.x < topLeft.x || s.x > botRight.x) continue;
      if (s.y < topLeft.y || s.y > botRight.y) continue;
      const p = worldToScreen(s.x, s.y);
      ctx.fillText(drifterDisplay(s)?.displayName ?? s.name, p.x, p.y + labelOffset);
    }
  }

  if (locateHover) {
    const rect = locateHover.el.getBoundingClientRect();
    const bx = rect.left + rect.width / 2;
    const by = rect.top + rect.height / 2;
    const sp = worldToScreen(locateHover.star.x, locateHover.star.y);
    const traceColor = starColor(locateHover.star);
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

  if (selected) {
    const p = worldToScreen(selected.x, selected.y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(0,200,200,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,200,200,0.35)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
    ctx.stroke();
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
  const hit = pickStar(e.clientX, e.clientY);
  if (hit) selectStar(hit, true);
  else deselectStar();
});

canvas.addEventListener('dblclick', (e) => {
  if (pickStar(e.clientX, e.clientY)) return;
  animatedResetView();
});

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
function handleHover(sx, sy) {
  if (dragging) { tooltip.classList.remove('visible'); return; }
  const s = pickStar(sx, sy);
  if (s) {
    ttName.textContent = displayName(s);
    ttClass.textContent = displayClass(s) + ' · ' + s.regionName;
    tooltip.style.left = (sx + 14) + 'px';
    tooltip.style.top = (sy + 14) + 'px';
    tooltip.classList.add('visible');
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.classList.remove('visible');
    canvas.style.cursor = dragging ? 'grabbing' : 'grab';
  }
}

// --- Custom tooltip (replaces browser title= tooltips) ----------
const customTip = document.getElementById('custom-tip');
let customTipTarget = null;

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  customTipTarget = el;
  customTip.textContent = el.dataset.tip;
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
function deselectStar() {
  selected = null;
  siEl.classList.add('empty');
  for (const el of Object.values(cornerEls)) el.classList.remove('corner--active');
  closeOrrery();
  closeIntel();
}

function selectStar(s, focus) {
  selected = s;
  for (const el of Object.values(cornerEls)) el.classList.add('corner--active');
  siEl.classList.remove('empty');
  const dd = drifterDisplay(s);
  document.getElementById('si-name').textContent = displayName(s);
  document.getElementById('si-jcode-row').style.display = dd ? '' : 'none';
  if (dd) document.getElementById('si-jcode').textContent = dd.jcode;
  document.getElementById('si-class').textContent = displayClass(s);
  document.getElementById('si-region').textContent = s.regionName;
  document.getElementById('si-const').textContent = s.constellation;
  document.getElementById('si-effect').textContent = s.effect || 'None';
  const stEl = document.getElementById('si-statics');
  stEl.innerHTML = '';
  for (const st of s.statics) {
    const chip = document.createElement('span');
    chip.className = 'static-chip';
    chip.textContent = st;
    stEl.appendChild(chip);
  }
  if (focus) {
    flyTo(s.x, s.y, 10, 520);
    searchMarker = { star: s, start: performance.now(), duration: 2600 };
  }
  // If orrery or intel was open for a previous system, refresh for the new one.
  if (orreryOpen) {
    updateOrreryHeader(s);
    buildOrreryList(s);
  }
  if (intelOpen) openIntel(s);
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

searchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = searchResults.querySelector('.sr-item');
  if (first) first.click();
});

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

// --- Zoom controls ----------------------------------------------
function updateZoomLabel() {
  document.getElementById('zoom-val').textContent = camera.scale.toFixed(2) + 'x';
}
updateZoomLabel();
function buttonZoom(factor) {
  const cw = window.innerWidth, ch = window.innerHeight;
  const cx = cw / 2, cy = ch / 2;
  const before = screenToWorld(cx, cy);
  camera.scale = clamp(camera.scale * factor, MIN_SCALE, MAX_SCALE);
  camera.offsetX = cx - before.x * camera.scale;
  camera.offsetY = cy - before.y * camera.scale;
  camera.focusAnim = null;
  updateZoomLabel();
}
document.getElementById('zoom-in').addEventListener('click', () => buttonZoom(1.25));
document.getElementById('zoom-out').addEventListener('click', () => buttonZoom(0.8));
document.getElementById('reset-view').addEventListener('click', animatedResetView);
document.getElementById('toggle-labels').addEventListener('click', (e) => {
  showLabels = !showLabels;
  const btn = e.currentTarget;
  btn.classList.toggle('off', !showLabels);
  btn.textContent = showLabels ? 'On' : 'Off';
});

const paletteEmberBtn   = document.getElementById('palette-ember');
const paletteAnoikisBtn = document.getElementById('palette-anoikis');
const paletteWhtypeBtn  = document.getElementById('palette-whtype');
const paletteGhostBtn   = document.getElementById('palette-ghost');
const paletteEveBtn     = document.getElementById('palette-eve');
function setPalette(name) {
  applyPalette(name);
  paletteEmberBtn.classList.toggle('on',   name === 'ember');
  paletteAnoikisBtn.classList.toggle('on', name === 'anoikis');
  paletteWhtypeBtn.classList.toggle('on',  name === 'whtype');
  paletteGhostBtn.classList.toggle('on',   name === 'ghost');
  paletteEveBtn.classList.toggle('on',     name === 'eve');
}
paletteEmberBtn.addEventListener('click',   () => setPalette('ember'));
paletteAnoikisBtn.addEventListener('click', () => setPalette('anoikis'));
paletteWhtypeBtn.addEventListener('click',  () => setPalette('whtype'));
paletteGhostBtn.addEventListener('click',   () => setPalette('ghost'));
paletteEveBtn.addEventListener('click',     () => setPalette('eve'));

// --- Panel visibility toggles ------------------------------------
document.getElementById('hide-left').addEventListener('click', () => {
  document.getElementById('panel-left').classList.add('panel--hidden');
  document.getElementById('restore-left').classList.add('visible');
});
document.getElementById('restore-left').addEventListener('click', () => {
  document.getElementById('panel-left').classList.remove('panel--hidden');
  document.getElementById('restore-left').classList.remove('visible');
});
document.getElementById('hide-right').addEventListener('click', () => {
  document.getElementById('panel-right').classList.add('panel--hidden');
  document.getElementById('restore-right').classList.add('visible');
});
const restoreRightBtn = document.getElementById('restore-right');
restoreRightBtn.addEventListener('click', () => {
  document.getElementById('panel-right').classList.remove('panel--hidden');
  restoreRightBtn.classList.remove('visible');
  restoreRightBtn.classList.remove('kill-flash');
});

function flashRestoreRight() {
  if (!document.getElementById('panel-right').classList.contains('panel--hidden')) return;
  restoreRightBtn.classList.remove('kill-flash');
  void restoreRightBtn.offsetWidth; // force reflow to restart animation
  restoreRightBtn.classList.add('kill-flash');
}

// --- Settings panel toggle ---------------------------------------
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('open');
});
document.addEventListener('click', () => settingsPanel.classList.remove('open'));
settingsPanel.addEventListener('click', (e) => e.stopPropagation());

// --- Kill feed ---------------------------------------------------
const killList = document.getElementById('kill-list');
const killCountEl = document.getElementById('kill-count');
const MAX_KILLS = 50;

function formatIsk(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
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

// ESI cache for type names not in the local SDE table (e.g. new ships on patch day).
const esiTypeNameCache = new Map();

async function resolveTypeName(typeId, nameEl) {
  if (typeId == null) { nameEl.textContent = 'Unknown'; return; }
  const local = window.TYPE_NAMES && window.TYPE_NAMES[typeId];
  if (local) { nameEl.textContent = local; return; }
  if (esiTypeNameCache.has(typeId)) { nameEl.textContent = esiTypeNameCache.get(typeId); return; }
  nameEl.textContent = 'Type ' + typeId; // placeholder while fetching
  try {
    const res = await fetch(`https://esi.evetech.net/latest/universe/types/${typeId}/`);
    const data = res.ok ? await res.json() : null;
    const name = data?.name || ('Type ' + typeId);
    esiTypeNameCache.set(typeId, name);
    if (nameEl.isConnected) nameEl.textContent = name;
  } catch {
    esiTypeNameCache.set(typeId, 'Type ' + typeId);
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
  fighter: 'Fighter',
  deployable: 'Deployable'
};

// metaGroupID → badge filename (populated by build_types.py into window.TYPE_META)
function techBadge(typeId) {
  return (window.TYPE_META && typeId != null && window.TYPE_META[typeId]) || null;
}

const activeKinds = new Set(['ship', 'structure']);
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
  const path = kind === 'char' ? 'characters' : 'corporations';
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

function spawnKill({ star, killId, typeId, kind, characterId, corporationId, value, ts, hasImplants, animated }) {
  if (animated) triggerKillAnim(star);
  const name = typeNameFor(typeId); // synchronous best-effort; ESI fills in below if unknown
  const img = typeId != null
    ? `https://images.evetech.net/types/${typeId}/render?size=64`
    : '';
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
  el.className = 'kill';
  el.dataset.kind = kindKey;
  if (!activeKinds.has(kindKey)) el.style.display = 'none';

  el.innerHTML = `
    <button class="kill-btn kill-btn--locate locate-btn" data-tip="Locate ${escapeHtml(starDisplayName)}" aria-label="Locate ${escapeHtml(starDisplayName)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="4"></circle>
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path>
      </svg>
    </button>
    <div class="kill-left">
      <div class="kill-img-wrap">
        <div class="kill-img" style="background-image: url('${img}')"></div>
        ${techBadge(typeId) ? `<img src="./img/graphic/${techBadge(typeId)}.png" class="kill-tech-badge" alt="" aria-hidden="true" />` : ''}
      </div>
    </div>
    <div class="kill-body">
      <div class="kill-ship">
        <span class="kill-ship-name">${escapeHtml(name)}</span>
      </div>
      <div class="kill-pilot${ownerLoading ? ' loading' : ''}">${ownerInitial}</div>
      <div class="kill-sys">${escapeHtml(starDisplayName)} · <span class="kill-sys-class">${escapeHtml(starDisplayClass)}</span></div>
      <div class="kill-meta">
        ${hasImplants ? `<span class="implant-badge" data-tip="Pod had implants" aria-label="Pod had implants"><img src="./img/graphic/implant.png" class="implant-img" alt="" aria-hidden="true" /></span>` : ''}
        <span class="kill-value">${formatIsk(value)} ISK</span>
        <span class="kill-age" data-ts="${ts || ''}">· ${formatAge(ts)}</span>
      </div>
    </div>
    ${zkbHref ? `
    <a class="kill-btn kill-btn--zkb zkb-link" href="${zkbHref}" target="_blank" rel="noopener noreferrer" data-tip="Open on zKillboard" aria-label="Open on zKillboard">
      <img src="./img/graphic/zkb.svg" class="zkb-img" alt="" aria-hidden="true" />
    </a>` : ''}
  `;
  const ageEl = el.querySelector('.kill-age');
  if (ts) {
    const timeTip = formatKillTimeTip(ts);
    ageEl.addEventListener('mouseenter', (e) => {
      customTip.textContent = timeTip;
      customTip.style.left = (e.clientX + 14) + 'px';
      customTip.style.top  = (e.clientY + 14) + 'px';
      customTip.style.display = 'block';
    });
    ageEl.addEventListener('mousemove', (e) => {
      const x = e.clientX + 14;
      const y = e.clientY + 14;
      customTip.style.left = (x + customTip.offsetWidth  > window.innerWidth  ? e.clientX - customTip.offsetWidth  - 6 : x) + 'px';
      customTip.style.top  = (y + customTip.offsetHeight > window.innerHeight ? e.clientY - customTip.offsetHeight - 6 : y) + 'px';
    });
    ageEl.addEventListener('mouseleave', () => {
      customTip.style.display = 'none';
      customTipTarget = null;
    });
  }
  const zkbEl = el.querySelector('.zkb-link');
  if (zkbEl) zkbEl.addEventListener('click', (ev) => ev.stopPropagation());
  const locateBtn = el.querySelector('.locate-btn');
  locateBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    locateStar(star);
  });
  locateBtn.addEventListener('mouseenter', () => { locateHover = { el: locateBtn, star }; });
  locateBtn.addEventListener('mouseleave', () => { locateHover = null; });

  if (ownerLoading) {
    const pilotEl = el.querySelector('.kill-pilot');
    const [entityKind, entityId] = hasChar
      ? ['char', characterId]
      : ['corp', corporationId];
    resolveEntityName(entityKind, entityId).then((n) => {
      if (!pilotEl.isConnected) return;
      pilotEl.classList.remove('loading');
      pilotEl.textContent = n || (hasChar ? 'Unknown pilot' : 'Unknown corporation');
    });
  }

  killList.insertBefore(el, killList.firstChild);
  while (killList.children.length > MAX_KILLS) killList.removeChild(killList.lastChild);
  updateKillCount();

  // If the name was a fallback placeholder, try ESI now that the element is in the DOM.
  if (!window.TYPE_NAMES?.[typeId]) {
    resolveTypeName(typeId, el.querySelector('.kill-ship-name'));
  }
}

function updateKillCount() {
  let visible = 0;
  for (const el of killList.children) {
    if (el.style.display !== 'none') visible++;
  }
  killCountEl.textContent = visible + ' shown';
}

function handleBackendKill(kill, animated) {
  const star = starById.get(kill.systemId);
  if (!star) return;
  spawnKill({
    star,
    killId: kill.id,
    typeId: kill.shipTypeId,
    kind: kill.kind,
    characterId: kill.characterId,
    corporationId: kill.corporationId,
    value: kill.value,
    ts: kill.ts,
    hasImplants: !!kill.hasImplants,
    animated
  });
  if (animated) flashRestoreRight();
}

document.querySelectorAll('#kill-filters .kind-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const kind = chip.dataset.kind;
    if (activeKinds.has(kind)) {
      activeKinds.delete(kind);
      chip.classList.remove('on');
    } else {
      activeKinds.add(kind);
      chip.classList.add('on');
    }
    for (const el of killList.children) {
      el.style.display = activeKinds.has(el.dataset.kind) ? '' : 'none';
    }
    updateKillCount();
  });
});

setInterval(() => {
  for (const el of killList.querySelectorAll('.kill-age')) {
    const ts = Number(el.dataset.ts) || 0;
    el.textContent = '· ' + formatAge(ts);
  }
}, 10000);

// --- Kill footer filter toggle -----------------------------------
document.getElementById('kill-footer-toggle').addEventListener('click', () => {
  document.getElementById('kill-footer').classList.toggle('open');
});

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
        const recent = msg.kills.slice(-MAX_KILLS);
        for (const k of recent) handleBackendKill(k, false);
      } else if (msg.type === 'kill' && msg.kill) {
        handleBackendKill(msg.kill, true);
      }
    });
    ws.addEventListener('close', schedule);
    ws.addEventListener('error', () => { /* close fires right after */ });
  }
  open();
}
connectKillFeed();

// --- Go ----------------------------------------------------------
requestAnimationFrame(draw);
