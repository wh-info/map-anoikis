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

function applyPalette(name) {
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
  statics: [],
  twinklePhase: Math.random() * Math.PI * 2,
  twinkleSpeed: 0.55 + Math.random() * 0.9,
  flareUntil: 0
}));
document.getElementById('star-count').textContent = stars.length + ' systems';
// systemID -> star, used by the live kill feed to resolve incoming IDs.
const starById = new Map(stars.map((s) => [s.id, s]));

// Named Drifter systems — custom display names and subclasses
const DRIFTER_INFO = {
  'J055520': { displayName: 'Sentinel MZ',       subclass: 'C14' },
  'J110145': { displayName: 'Liberated Barbican', subclass: 'C15' },
  'J164710': { displayName: 'Sanctified Vidette', subclass: 'C16' },
  'J200727': { displayName: 'Conflux Eyrie',      subclass: 'C17' },
  'J174618': { displayName: 'Azdaja Redoubt',     subclass: 'C18' },
};
function drifterDisplay(star) { return DRIFTER_INFO[star.name] ?? null; }

const CLASS_OVERRIDES = { 'Thera': 'C12' };
function displayClass(star) {
  const dd = drifterDisplay(star);
  if (dd) return dd.subclass;
  return CLASS_OVERRIDES[star.name] ?? star.whClass;
}
function displayName(star) {
  return drifterDisplay(star)?.displayName ?? star.name;
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
    const spr = spriteCache[s.whClass];
    const color = CLASS_COLORS[s.whClass];

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
    const color = CLASS_COLORS[a.star.whClass];
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
    const starColor = CLASS_COLORS[locateHover.star.whClass] ?? [0, 200, 200];
    const grad = ctx.createLinearGradient(bx, by, sp.x, sp.y);
    grad.addColorStop(0, 'rgba(0,200,200,0.45)');
    grad.addColorStop(1, rgba(starColor, 0.45));
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 7]);
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
}

function selectStar(s, focus) {
  selected = s;
  for (const el of Object.values(cornerEls)) el.classList.add('corner--active');
  siEl.classList.remove('empty');
  const dd = drifterDisplay(s);
  document.getElementById('si-name').textContent = displayName(s);
  document.getElementById('si-jcode-row').style.display = dd ? '' : 'none';
  if (dd) document.getElementById('si-jcode').textContent = s.name;
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
    if (s.name.toLowerCase().includes(q) || dn.includes(q) || s.regionName.toLowerCase().includes(q)) {
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
function setPalette(name) {
  applyPalette(name);
  paletteEmberBtn.classList.toggle('on',   name === 'ember');
  paletteAnoikisBtn.classList.toggle('on', name === 'anoikis');
  paletteWhtypeBtn.classList.toggle('on',  name === 'whtype');
  paletteGhostBtn.classList.toggle('on',   name === 'ghost');
}
paletteEmberBtn.addEventListener('click',   () => setPalette('ember'));
paletteAnoikisBtn.addEventListener('click', () => setPalette('anoikis'));
paletteWhtypeBtn.addEventListener('click',  () => setPalette('whtype'));
paletteGhostBtn.addEventListener('click',   () => setPalette('ghost'));

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
document.getElementById('restore-right').addEventListener('click', () => {
  document.getElementById('panel-right').classList.remove('panel--hidden');
  document.getElementById('restore-right').classList.remove('visible');
});

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
    <button class="kill-btn kill-btn--locate locate-btn" title="Locate ${escapeHtml(starDisplayName)}" aria-label="Locate ${escapeHtml(starDisplayName)}">
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
      <div class="kill-sys">${escapeHtml(starDisplayName)} · ${escapeHtml(starDisplayClass)}</div>
      <div class="kill-meta">
        ${hasImplants ? `<span class="implant-badge" title="Pod had implants" aria-label="Pod had implants"><img src="./img/graphic/implant.png" class="implant-img" alt="" aria-hidden="true" /></span>` : ''}
        <span class="kill-value">${formatIsk(value)} ISK</span>
        <span class="kill-age" data-ts="${ts || ''}">· ${formatAge(ts)}</span>
      </div>
    </div>
    ${zkbHref ? `
    <a class="kill-btn kill-btn--zkb zkb-link" href="${zkbHref}" target="_blank" rel="noopener noreferrer" title="Open on zKillboard" aria-label="Open on zKillboard">
      <img src="./img/graphic/zkb.svg" class="zkb-img" alt="" aria-hidden="true" />
    </a>` : ''}
  `;
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
