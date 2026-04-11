// Anoikis Live Map — main script
// Vanilla JS + Canvas 2D. Data loaded via window.ANOIKIS_SYSTEMS (anoikis-systems.js)
// and window.TYPE_NAMES / window.TYPE_KINDS (type-kinds.js) before this script runs.

// --- Constants ---------------------------------------------------
const MIN_SCALE = 0.18;
const MAX_SCALE = 30;
const FLARE_MS = 1100;
const RING_MS  = 2000;

// WH class palette
const CLASS_COLORS = {
  C1: [122,209,255], C2: [106,208,199], C3: [134,224,138], C4: [216,216,106],
  C5: [255,173,106], C6: [255,109,109], Thera: [201,139,255],
  C13: [154,166,194], Drifter: [255,79,163]
};

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
    duration: 520,
    from: { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY },
    to
  };
}
resetView();

let showLabels = true;

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
    const eased = 1 - Math.pow(1 - t, 3);
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
      ctx.fillText(s.name, p.x, p.y + labelOffset);
    }
  }

  if (selected) {
    const p = worldToScreen(selected.x, selected.y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(143,211,255,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(143,211,255,0.35)';
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
      ctx.strokeStyle = `rgba(120, 232, 255, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.rect(p.x - base, p.y - base, base * 2, base * 2);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(120, 232, 255, ${alpha * 0.9})`;
      ctx.lineWidth = 1.4;
      const arm = base + 10;
      const gap = base * 0.55;
      ctx.beginPath();
      ctx.moveTo(p.x - arm, p.y); ctx.lineTo(p.x - gap, p.y);
      ctx.moveTo(p.x + gap, p.y); ctx.lineTo(p.x + arm, p.y);
      ctx.moveTo(p.x, p.y - arm); ctx.lineTo(p.x, p.y - gap);
      ctx.moveTo(p.x, p.y + gap); ctx.lineTo(p.x, p.y + arm);
      ctx.stroke();

      ctx.fillStyle = `rgba(120, 232, 255, ${alpha * 0.75})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
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
    ttName.textContent = s.name;
    ttClass.textContent = s.whClass + ' · ' + s.regionName;
    tooltip.style.left = (sx + 14) + 'px';
    tooltip.style.top = (sy + 14) + 'px';
    tooltip.classList.add('visible');
    canvas.style.cursor = 'pointer';
  } else {
    tooltip.classList.remove('visible');
    canvas.style.cursor = dragging ? 'grabbing' : 'grab';
  }
}

// --- Selection + system info ------------------------------------
let selected = null;
let searchMarker = null;
const siEl = document.getElementById('system-info');
function selectStar(s, focus) {
  selected = s;
  siEl.classList.remove('empty');
  document.getElementById('si-name').textContent = s.name;
  document.getElementById('si-region').textContent = s.regionName + ' · ' + s.constellation;
  document.getElementById('si-class').textContent = s.whClass;
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
  const q = searchEl.value.trim().toLowerCase();
  searchResults.innerHTML = '';
  if (q.length < 2) return;
  const matches = [];
  for (const s of stars) {
    if (s.name.toLowerCase().includes(q) || s.regionName.toLowerCase().includes(q)) {
      matches.push(s);
      if (matches.length >= 20) break;
    }
  }
  for (const s of matches) {
    const item = document.createElement('div');
    item.className = 'sr-item';
    item.innerHTML = `<span class="sr-name">${s.name}</span><span class="sr-class">${s.whClass}</span>`;
    item.addEventListener('click', () => {
      selectStar(s, true);
      searchEl.value = '';
      searchResults.innerHTML = '';
    });
    searchResults.appendChild(item);
  }
});

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
  e.currentTarget.classList.toggle('off', !showLabels);
});

// --- Kill feed ---------------------------------------------------
const killList = document.getElementById('kill-list');
const killCountEl = document.getElementById('kill-count');
const MAX_KILLS = 40;

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

const activeKinds = new Set(['ship', 'structure', 'tower', 'fighter', 'deployable']);

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
  const name = typeNameFor(typeId);
  const img = typeId != null
    ? `https://images.evetech.net/types/${typeId}/render?size=128`
    : '';
  const zkbHref = killId ? `https://zkillboard.com/kill/${killId}/` : null;
  const kindKey = kind || 'ship';
  const kindLabel = KIND_LABEL[kindKey] || 'Kill';

  const hasChar = characterId != null;
  const hasCorp = corporationId != null;
  const ownerLoading = hasChar || hasCorp;
  const ownerInitial = ownerLoading
    ? (hasChar ? 'Loading pilot…' : 'Loading corporation…')
    : 'Unknown';

  const el = document.createElement('div');
  el.className = 'kill';
  el.dataset.kind = kindKey;
  if (!activeKinds.has(kindKey)) el.style.display = 'none';

  el.innerHTML = `
    <div class="kill-img" style="background-image: url('${img}')"></div>
    <div class="kill-body">
      <div class="kill-ship">
        ${escapeHtml(name)}
        <span class="kind-pill ${kindKey}">${kindLabel}</span>
      </div>
      <div class="kill-pilot${ownerLoading ? ' loading' : ''}">${ownerInitial}</div>
      <div class="kill-sys">${escapeHtml(star.name)} · ${escapeHtml(star.whClass)}</div>
      <div class="kill-meta">
        <span class="kill-value">${formatIsk(value)} ISK</span>
        <span class="kill-age" data-ts="${ts || ''}">· ${formatAge(ts)}</span>
        <span class="kill-actions">
          ${hasImplants ? `
            <span class="implant-badge" title="Pod had implants" aria-label="Pod had implants">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.5 4.5a5 5 0 0 1 7.07 7.07l-6.01 6.01a5 5 0 0 1-7.07-7.07z"></path>
                <path d="M7.5 7.5l9 9"></path>
              </svg>
            </span>` : ''}
          ${zkbHref ? `
            <a class="kill-btn zkb-link" href="${zkbHref}" target="_blank" rel="noopener noreferrer" title="Open on zKillboard" aria-label="Open on zKillboard">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 4h6v6"></path>
                <path d="M20 4L10 14"></path>
                <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"></path>
              </svg>
            </a>` : ''}
          <button class="kill-btn locate-btn" title="Locate ${escapeHtml(star.name)}" aria-label="Locate ${escapeHtml(star.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="12" cy="12" r="4"></circle>
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path>
            </svg>
          </button>
        </span>
      </div>
    </div>
  `;
  const zkbEl = el.querySelector('.zkb-link');
  if (zkbEl) zkbEl.addEventListener('click', (ev) => ev.stopPropagation());
  el.querySelector('.locate-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    locateStar(star);
  });

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
