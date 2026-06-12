// ============================================================================
//  雪月花 — Sakura Snow Globe
//  A cel-shaded looping screensaver: a katana rests in a cherry grove inside
//  a snow globe while the seasons turn. Summer → Autumn → Winter → Spring.
//
//  Trees carry foliage as textured cluster cards. Clusters bloom and rot out
//  through an animated alpha-cutoff (each painted tuft has its own alpha level,
//  so raising the threshold removes tufts one by one), while particle systems
//  rain the petals and leaves the clusters shed.
// ============================================================================

import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const CONFIG = {
  seasonSeconds : 96,     // length of one season (4 day/night cycles each)
  orbitSeconds  : 95,     // camera revolution period
  orbitRadius   : 8.8,
  orbitHeight   : 2.0,
  lookAtHeight  : 1.3,
  groundRadius  : 13.0,
  treeCount     : 8,
  petalCount    : 1400,
  leafCount     : 340,
  snowCount     : 900,
  rainCount     : 420,
  fireflyCount  : 40,
  moteCount     : 64,
  sparkleCount  : 90,
  maxPixelRatio : 2,
};

// Seeded RNG so the grove is identical every run
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260611);
const rand = (lo, hi) => lo + rng() * (hi - lo);
// second stream for later-added features, so the grove layout stays put
const rng2 = mulberry32(424242);
const rand2 = (lo, hi) => lo + rng2() * (hi - lo);
const DAY_SECONDS = CONFIG.seasonSeconds / 4;
const hash01 = (n) => {
  const s = Math.sin(n * 127.1 + 13.7) * 43758.5453;
  return s - Math.floor(s);
};

// Time speed: -100 → real time (1 day = 24 h), +100 → 1 day = 1 s, log scale.
// The default (+40) gives roughly the original pacing (~30 s per day).
let timeSpeed = 40;
const dayLengthSeconds = (s) => Math.pow(10, Math.log10(86400) * (100 - s) / 200);

// ----------------------------------------------------------------------------
// Error overlay (helps debugging in a screensaver context)
// ----------------------------------------------------------------------------
const errBox = document.getElementById('err');
window.addEventListener('error', (e) => {
  errBox.style.display = 'block';
  errBox.textContent += `${e.message}\n  at ${e.filename}:${e.lineno}\n`;
});

// ----------------------------------------------------------------------------
// Renderer / scene / camera
// ----------------------------------------------------------------------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

// Watchdog: if the WebGL context is lost and never restored (driver reset,
// GPU process crash), reload — the scene is fully procedural from a fixed
// seed, so a reload rebuilds it identically.
let ctxLostAt = 0;
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ctxLostAt = performance.now(); });
canvas.addEventListener('webglcontextrestored', () => { ctxLostAt = 0; });
setInterval(() => {
  if (ctxLostAt && performance.now() - ctxLostAt > 12000) location.reload();
}, 4000);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fb4c8, 0.013);

const camera = new THREE.PerspectiveCamera(47, window.innerWidth / window.innerHeight, 0.1, 200);

// Render resolution — fixed internal buffer, stretched to the window with hard
// pixels (R cycles HD / FHD / Native). Width follows the window's aspect.
const RES_MODES = [
  { name: '360p', h: 360 },
  { name: '540p', h: 540 },
  { name: '720p', h: 720 },
  { name: '1080p', h: 1080 },
  { name: 'Native', h: 0 },
];
let resMode = 3;   // default 1080p — fast and chunky; R cycles, manual only
let lastWinW = 0, lastWinH = 0;
function applyResolution() {
  lastWinW = window.innerWidth;
  lastWinH = window.innerHeight;
  const m = RES_MODES[resMode];
  if (m.h === 0) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.maxPixelRatio));
    renderer.setSize(lastWinW, lastWinH);
    canvas.style.imageRendering = 'auto';
  } else {
    const h = Math.min(m.h, lastWinH || m.h);
    const w = Math.max(2, Math.round(h * (lastWinW / Math.max(1, lastWinH))));
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);            // CSS keeps it stretched full-window
    canvas.style.imageRendering = 'pixelated';
  }
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  camera.aspect = lastWinW / Math.max(1, lastWinH);
  camera.updateProjectionMatrix();
}
applyResolution();

// ----------------------------------------------------------------------------
// Terrain height field — shared by everything that sits on the ground
// ----------------------------------------------------------------------------
function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  let h = 0.16 * Math.sin(x * 0.35 + 1.3) * Math.cos(z * 0.42 + 0.7)
        + 0.10 * Math.sin(x * 0.85 + z * 0.65 + 2.1)
        + 0.05 * Math.sin(x * 1.9 - z * 1.4);
  h += 0.42 * Math.exp(-(r * r) / (2.1 * 2.1));   // gentle mound under the sword
  h -= 0.22 * THREE.MathUtils.smoothstep(r, 9.0, 13.0); // settle toward the glass
  return h;
}
const GH0 = groundHeight(0, 0);

// ----------------------------------------------------------------------------
// Toon shading helpers
// ----------------------------------------------------------------------------
function makeGradientMap(steps) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    data[i] = Math.round(THREE.MathUtils.lerp(110, 255, i / (steps - 1)));
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const toonRamp = makeGradientMap(4);
const toonRampSoft = makeGradientMap(3);

function toonMat(color, opts = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonRamp, ...opts });
}

// Inverted-hull outlines — the Borderlands ink line
function outlineMaterial(thickness, color = 0x16120f) {
  return new THREE.ShaderMaterial({
    uniforms: { uT: { value: thickness }, uC: { value: new THREE.Color(color) } },
    vertexShader: `
      uniform float uT;
      void main() {
        vec3 p = position + normal * uT;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uC;
      void main() { gl_FragColor = vec4(uC, 1.0); }`,
    side: THREE.BackSide,
  });
}

function hullGeometry(srcGeo) {
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', srcGeo.getAttribute('position').clone());
  if (srcGeo.index) g.setIndex(srcGeo.index.clone());
  g = mergeVertices(g, 1e-4);
  g.computeVertexNormals();
  return g;
}

function addOutline(mesh, thickness) {
  const hull = new THREE.Mesh(hullGeometry(mesh.geometry), outlineMaterial(thickness));
  hull.castShadow = false;
  hull.receiveShadow = false;
  mesh.add(hull);
  return hull;
}

// Deterministic per-vertex jitter (coincident verts move identically)
function jitterGeometry(geo, amount) {
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const s = Math.sin(v.x * 91.7 + v.y * 47.3 + v.z * 73.1);
    const t = Math.sin(v.x * 53.1 - v.y * 81.9 + v.z * 31.7);
    const u = Math.sin(v.x * 37.9 + v.y * 23.3 - v.z * 67.3);
    pos.setXYZ(i, v.x + s * amount, v.y + t * amount, v.z + u * amount);
  }
  geo.computeVertexNormals();
  return geo;
}

// Re-scale each ring of a unit-radius TubeGeometry → tapered, gnarled limbs
function taperTube(geo, radialSegments, radiusFn) {
  const pos = geo.getAttribute('position');
  const ringSize = radialSegments + 1;
  const rings = pos.count / ringSize;
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let r = 0; r < rings; r++) {
    c.set(0, 0, 0);
    // skip the duplicated seam vertex (j = radialSegments) or the centroid drifts
    for (let j = 0; j < radialSegments; j++) c.add(v.fromBufferAttribute(pos, r * ringSize + j));
    c.divideScalar(radialSegments);
    const k = radiusFn(r / (rings - 1));
    for (let j = 0; j < ringSize; j++) {
      const i = r * ringSize + j;
      v.fromBufferAttribute(pos, i).sub(c).multiplyScalar(k).add(c);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// Ramps on the circular season axis t ∈ [0,4)
function sm01(p) {
  p = THREE.MathUtils.clamp(p, 0, 1);
  return p * p * (3 - 2 * p);
}

// Cumulative daylight along the season axis — growth happens in the sun and
// crawls at night (floor 0.12). Used to gate bud/leaf growth to daytime.
const DAYCUM_N = 2048;
const dayCumTable = new Float32Array(DAYCUM_N + 1);
{
  let acc = 0;
  for (let i = 0; i < DAYCUM_N; i++) {
    const t = (i / DAYCUM_N) * 4;
    const el = Math.sin(((t * 4) % 1) * Math.PI * 2);
    const w = 0.12 + 0.88 * sm01((el + 0.12) / 0.3);
    dayCumTable[i] = acc;
    acc += w * (4 / DAYCUM_N);
  }
  dayCumTable[DAYCUM_N] = acc;
}
function dayCum(t) {            // t ∈ [0, 8) — handles one unwrap past the year boundary
  const total = dayCumTable[DAYCUM_N];
  const extra = t >= 4 ? total : 0;
  const f = ((t % 4) / 4) * DAYCUM_N;
  const i = Math.floor(f);
  return extra + THREE.MathUtils.lerp(dayCumTable[i], dayCumTable[Math.min(i + 1, DAYCUM_N)], f - i);
}
const growthRamp = (t, a, b) => sm01((dayCum(t) - dayCum(a)) / (dayCum(b) - dayCum(a)));
const ramp01 = (t, a, b) => sm01((t - a) / (b - a));
// A window on the season circle: 0 before a, rises a→b, holds, falls c→d, 0 after.
// d may exceed 4 (window crossing the year boundary) — unwrap t once for the whole window.
function windowRamp(t, a, b, c, d) {
  let tt = t;
  if (d > 4 && tt < d - 4) tt += 4;
  return sm01((tt - a) / (b - a)) * (1 - sm01((tt - c) / (d - c)));
}

// Breeze that flows through all foliage cards (Shamanic-Princess cluster flow):
// two wave octaves plus a directional lean that follows gusts and the wind
const swayTime = { value: 0 };
const swayPush = { value: new THREE.Vector2() };
const swayStrengths = [];
function addSway(mat, strength) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = swayTime;
    sh.uniforms.uPush = swayPush;
    const s = { value: strength };
    swayStrengths.push(s);
    sh.uniforms.uSway = s;
    sh.vertexShader = ('uniform float uTime; uniform float uSway; uniform vec2 uPush;\n' + sh.vertexShader).replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec3 swp = (modelMatrix * vec4(transformed, 1.0)).xyz;
      float sph = swp.x * 0.8 + swp.z * 1.1 + uTime;
      // pinned at the card's branch root (uv .5/.414): roots stay welded to the
      // bough while the tips whip — cards flex instead of sliding off the tree
      float rootW = clamp(length(uv - vec2(0.5, 0.414)) * 2.2, 0.0, 1.0);
      vec3 swv = vec3(sin(sph), sin(sph * 0.83 + 1.7) * 0.6, cos(sph * 0.91)) * uSway;
      swv += vec3(sin(sph * 2.63 + 1.3), sin(sph * 2.21 + 0.6) * 0.5, cos(sph * 2.4 + 2.1)) * uSway * 0.5;
      swv.xz += uPush * (0.6 + 0.4 * sin(sph * 0.7));
      transformed += swv * rootW;`,
    );
  };
}

// ----------------------------------------------------------------------------
// Season palettes
// ----------------------------------------------------------------------------
const C = (hex) => new THREE.Color(hex);
const SEASONS = [
  { // 0 — Summer 夏
    name: 'Summer', kanji: '夏',
    canopy: [C('#3fae5c'), C('#4cb868'), C('#359e54'), C('#5cbf6e')],
    ground: C('#5fa75b'), trunk: C('#b3a89e'),
    skyTop: C('#2f6fc4'), skyBottom: C('#cfeefb'),
    cloud: C('#ffffff'), cloudAmt: 0.8, sun: C('#fff6da'), stars: 0,
    key: C('#fff2d8'), keyIntensity: 3.2, keyPos: new THREE.Vector3(6, 11, 4),
    hemiSky: C('#bfe3ff'), hemiGround: C('#7fae6e'), hemiIntensity: 0.85,
    fog: C('#a8cfe0'), dome: C('#bfe8ff'),
    bokeh: C('#fff3c0'), rock: C('#8e959d'),
  },
  { // 1 — Autumn 秋
    name: 'Autumn', kanji: '秋',
    canopy: [C('#e8742c'), C('#d94f30'), C('#f0a832'), C('#c43d2e')],
    ground: C('#b08a52'), trunk: C('#a3958a'),
    skyTop: C('#5872a8'), skyBottom: C('#ecc994'),
    cloud: C('#f2e3cf'), cloudAmt: 0.65, sun: C('#ffc97e'), stars: 0,
    key: C('#ffd9a0'), keyIntensity: 2.7, keyPos: new THREE.Vector3(9, 5.5, 6),
    hemiSky: C('#e8c39a'), hemiGround: C('#8a6a4a'), hemiIntensity: 0.75,
    fog: C('#c8a584'), dome: C('#ffd9b0'),
    bokeh: C('#ffc98a'), rock: C('#90878a'),
  },
  { // 2 — Winter 冬
    name: 'Winter', kanji: '冬',
    canopy: [C('#7a6354'), C('#7a6354'), C('#7a6354'), C('#7a6354')],
    ground: C('#e9eff7'), trunk: C('#b8b5bd'),
    skyTop: C('#39608c'), skyBottom: C('#c9dbeb'),
    cloud: C('#dde8f2'), cloudAmt: 0.45, sun: C('#eef4ff'), stars: 1,
    key: C('#cfe2ff'), keyIntensity: 2.3, keyPos: new THREE.Vector3(7, 4.5, 9),
    hemiSky: C('#a8c4e0'), hemiGround: C('#dde8f0'), hemiIntensity: 0.8,
    fog: C('#aebfd4'), dome: C('#dceaff'),
    bokeh: C('#cfe0ff'), rock: C('#dfe7f0'),
  },
  { // 3 — Spring 春
    name: 'Spring', kanji: '春',
    canopy: [C('#f5a8c0'), C('#f7bcd0'), C('#ef93b4'), C('#fbc9da')],
    ground: C('#6fae62'), trunk: C('#ad9f94'),
    skyTop: C('#5e9bd8'), skyBottom: C('#fcdfe9'),
    cloud: C('#fff0f5'), cloudAmt: 0.75, sun: C('#ffe9f0'), stars: 0,
    key: C('#fff0f4'), keyIntensity: 2.9, keyPos: new THREE.Vector3(4, 9, -6),
    hemiSky: C('#dcecff'), hemiGround: C('#90b878'), hemiIntensity: 0.85,
    fog: C('#cdbfd0'), dome: C('#ffe4ee'),
    bokeh: C('#ffd9e6'), rock: C('#8e959d'),
  },
];
const SUMMER_LEAF = [C('#3fae5c'), C('#4cb868'), C('#359e54'), C('#5cbf6e')];
const BLOSSOM_PINK = [C('#f7afc6'), C('#fbc4d6'), C('#f49cba'), C('#fdd2e0')];
const BUD_GREEN = C('#9dc06f');
const SACRED_PINK = C('#e89ab8');
const GROVE_PINK = C('#f2a7c2');
const CARPET_BROWN = C('#7d614a');
const CARPET_SPRING_C = C('#e87fa8');
const CARPET_FALL_C = C('#b85a20');

// night & twilight palette (shared across seasons)
const NIGHT_TOP = C('#0a1322');
const NIGHT_BOTTOM = C('#1c2b42');
const NIGHT_CLOUD = C('#34425e');
const NIGHT_FOG = C('#141e2e');
const NIGHT_HEMI_SKY = C('#33466a');
const NIGHT_HEMI_GROUND = C('#1b2433');
const MOON_LIGHT = C('#aebfdf');
const DUSK_C = C('#ff9a5c');
const RAIN_CLOUD = C('#8a93a3');

const weights = [0, 0, 0, 0];
function computeWeights(seasonT) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    let d = Math.abs(seasonT - (i + 0.5));
    d = Math.min(d, 4 - d);
    const w = 1 - THREE.MathUtils.smoothstep(d, 0.32, 0.68);
    weights[i] = w;
    sum += w;
  }
  for (let i = 0; i < 4; i++) weights[i] /= sum;
  return weights;
}
function blendColor(out, key, idx = -1) {
  out.setRGB(0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const c = idx >= 0 ? SEASONS[i][key][idx] : SEASONS[i][key];
    out.r += c.r * weights[i];
    out.g += c.g * weights[i];
    out.b += c.b * weights[i];
  }
  return out;
}
function blendScalar(key) {
  let v = 0;
  for (let i = 0; i < 4; i++) v += SEASONS[i][key] * weights[i];
  return v;
}

// Foliage lifecycle on the circular season axis (centres: su .5, fa 1.5, wi 2.5, sp 3.5)
// Blossoms bloom on bare branches in spring, storm off at the spring→summer turn;
// leaves flush in early summer, turn in autumn, and strip going into winter.
// Blossoms bud through spring daylight (growth pauses at night) and shed over
// EXACTLY one day at the spring→summer turn. Returns [coverage, growthProgress];
// growthProgress drives the green-bud → pink tint.
function blossomState(t) {
  let tt = t;
  if (tt < 0.15) tt += 4;                       // unwrap the shedding window
  const up = growthRamp(tt, 3.15, 3.55);
  const down = sm01((tt - 3.9) / 0.25);         // one full day = 0.25 season units
  return [up * (1 - down), up];
}
const blossomCoverage = (t) => blossomState(t)[0];
// leaves flush WHILE the blossoms shed (3.95→4.45) — no bare gap between them
const leafCoverage = (t) => {
  const u = t < 3.0 ? t + 4 : t;
  return growthRamp(u, 3.95, 4.45) * (1 - ramp01(t, 1.55, 2.15));
};
const leafTurn        = (t) => ramp01(t, 1.05, 1.5);                       // green→autumn
const petalStorm      = (t) => windowRamp(t, 3.9, 3.975, 4.075, 4.15);     // the one-day storm
const leafFall        = (t) => windowRamp(t, 1.5, 1.75, 1.95, 2.3);
const springCarpet    = (t) => windowRamp(t, 3.95, 4.2, 4.3, 4.62);
const fallCarpet      = (t) => windowRamp(t, 1.6, 2.0, 2.15, 2.5);

// ----------------------------------------------------------------------------
// Canvas texture helpers
// ----------------------------------------------------------------------------
function canvasTex(size, draw, { wrap = true } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (wrap) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function softCircleTexture(size, inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.45)') {
  return canvasTex(size, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.4, mid);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }, { wrap: false });
}
const softDot = softCircleTexture(64);
const softGlow = softCircleTexture(128, 'rgba(255,235,200,1)', 'rgba(255,225,180,0.4)');

// draw a blob and its 8 wrap copies so the texture tiles
function splat(g, size, x, y, fn) {
  for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) fn(x + ox * size, y + oy * size);
}

// Tileable multi-octave value noise (perlin-style) — the cloud field
function valueNoiseTexture(size, octaves, baseFreq) {
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = baseFreq << o;
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    grids.push({ n, g });
  }
  const data = new Uint8Array(size * size * 4);
  const fade = (x) => x * x * (3 - 2 * x);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 1, norm = 0;
      for (const { n, g } of grids) {
        const fx = (x / size) * n, fy = (y / size) * n;
        const xi = Math.floor(fx), yi = Math.floor(fy);
        const x0 = xi % n, y0 = yi % n, x1 = (xi + 1) % n, y1 = (yi + 1) % n;
        const sx = fade(fx - xi), sy = fade(fy - yi);
        const top = g[y0 * n + x0] + (g[y0 * n + x1] - g[y0 * n + x0]) * sx;
        const bot = g[y1 * n + x0] + (g[y1 * n + x1] - g[y1 * n + x0]) * sx;
        v += (top + (bot - top) * sy) * amp;
        norm += amp;
        amp *= 0.55;
      }
      const lum = Math.round((v / norm) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = lum;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
const cloudTex = valueNoiseTexture(256, 5, 4);

// Ground: mossy perlin mottle + speckles
const groundTex = canvasTex(512, (g, s) => {
  g.fillStyle = '#b9b9b9';
  g.fillRect(0, 0, s, s);
  for (const [radius, count, alpha] of [[56, 34, 0.10], [30, 90, 0.11], [16, 220, 0.12], [7, 480, 0.12]]) {
    for (let i = 0; i < count; i++) {
      const x = rng() * s, y = rng() * s, r = radius * rand(0.6, 1.4);
      const lum = Math.round(rand(120, 255));
      splat(g, s, x, y, (px, py) => {
        const grad = g.createRadialGradient(px, py, 0, px, py, r);
        grad.addColorStop(0, `rgba(${lum},${lum},${lum},${alpha})`);
        grad.addColorStop(1, `rgba(${lum},${lum},${lum},0)`);
        g.fillStyle = grad;
        g.fillRect(px - r, py - r, r * 2, r * 2);
      });
    }
  }
  for (let i = 0; i < 900; i++) {   // grass / grit speckle
    const x = rng() * s, y = rng() * s;
    const lum = rng() < 0.5 ? Math.round(rand(95, 140)) : Math.round(rand(215, 255));
    g.fillStyle = `rgba(${lum},${lum},${lum},${rand(0.18, 0.4)})`;
    splat(g, s, x, y, (px, py) => g.fillRect(px, py, rand(1, 2.6), rand(1, 2.6)));
  }
});

// Cherry bark: grey-brown mottle, dark furrows along the limb, pale lenticel dashes around it
const barkTex = canvasTex(256, (g, s) => {
  g.fillStyle = '#6e6058';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 160; i++) {       // mottle
    const x = rng() * s, y = rng() * s, r = rand(8, 30);
    const lum = Math.round(rand(74, 132));
    splat(g, s, x, y, (px, py) => {
      const grad = g.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, `rgba(${lum},${Math.round(lum * 0.9)},${Math.round(lum * 0.82)},0.22)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {        // furrows run along the limb (x axis = length)
    const y = rng() * s, x = rng() * s, len = rand(40, 130);
    g.strokeStyle = `rgba(28,22,18,${rand(0.25, 0.5)})`;
    g.lineWidth = rand(1.5, 4);
    splat(g, s, x, y, (px, py) => {
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + len / 2, py + rand(-9, 9), px + len, py + rand(-5, 5));
      g.stroke();
    });
  }
  for (let i = 0; i < 34; i++) {        // lenticels run around it (y axis)
    const y = rng() * s, x = rng() * s, len = rand(6, 16);
    g.strokeStyle = `rgba(214,196,176,${rand(0.4, 0.75)})`;
    g.lineWidth = rand(2, 3.5);
    splat(g, s, x, y, (px, py) => {
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + rand(-2, 2), py + len);
      g.stroke();
    });
  }
});

// Foliage cluster card — leaf tufts over a twig skeleton. Grayscale (tinted by
// material colour); each tuft gets one of a few quantised alpha levels so the
// animated alpha cutoff erodes the cluster tuft by tuft. Twigs are full-alpha,
// so buds and leaves visibly grow on wood instead of floating, and the twigs
// are the last thing to vanish. The ink rim is baked into the gradient COLOUR
// (not a higher-alpha stroke), so eroding tufts never leave hollow outlines.
const ALPHA_LEVELS = [0.4, 0.55, 0.7, 0.85, 1.0];
function drawTwigs(g, s) {
  const cx = s / 2, cy = s / 2;
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(72,55,42,1)';
  for (let b = 0; b < 6; b++) {
    const ang = (b / 6) * Math.PI * 2 + rng() * 0.9;
    const len = s * rand(0.26, 0.42);
    const ex = cx + Math.cos(ang) * len, ey = cy + Math.sin(ang) * len * 0.85;
    const mx = cx + Math.cos(ang + rand(-0.25, 0.25)) * len * 0.5;
    const my = cy + Math.sin(ang + rand(-0.25, 0.25)) * len * 0.5 * 0.85;
    g.lineWidth = rand(2.6, 3.6);
    g.beginPath();
    g.moveTo(cx, cy);
    g.quadraticCurveTo(mx, my, ex, ey);
    g.stroke();
    for (let t = 0; t < 2; t++) {   // side twigs
      const f = rand(0.45, 0.85);
      const px = cx + (ex - cx) * f, py = cy + (ey - cy) * f;
      const sa = ang + rand(0.5, 1.1) * (t ? 1 : -1);
      g.lineWidth = rand(1.4, 2.1);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(sa) * len * 0.32, py + Math.sin(sa) * len * 0.32);
      g.stroke();
    }
  }
}
const leafCardTex = canvasTex(256, (g, s) => {
  g.clearRect(0, 0, s, s);
  drawTwigs(g, s);
  const cx = s / 2, cy = s / 2;
  for (let i = 0; i < 150; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * s * 0.45;
    const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad * 0.85;
    const a = ALPHA_LEVELS[Math.floor(rng() * ALPHA_LEVELS.length)];
    const rx = rand(10, 16), ry = rand(5.5, 8.5), rot = rng() * Math.PI;
    const lum = Math.round(rand(185, 255));
    const lo = Math.round(lum * 0.88);
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, `rgba(${lum},${lum},${lum},${a})`);
    grad.addColorStop(0.6, `rgba(${lo},${lo},${lo},${Math.max(0.05, a - 0.12)})`);
    grad.addColorStop(0.85, `rgba(58,62,40,${Math.max(0.04, a - 0.2)})`);
    grad.addColorStop(1, `rgba(38,42,26,${Math.max(0.02, a - 0.32)})`);
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}, { wrap: false });

// Blossom card — rosette tufts of five-petal froth on the same twig skeleton.
// Each rosette emerges as its centre bud dot first, then petals fade in; petal
// rims darken toward deep pink in colour (no stroke → no hollow outlines).
const blossomCardTex = canvasTex(256, (g, s) => {
  g.clearRect(0, 0, s, s);
  drawTwigs(g, s);
  const cx = s / 2, cy = s / 2;
  for (let i = 0; i < 100; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * s * 0.42;
    const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad * 0.88;
    const a = ALPHA_LEVELS[Math.floor(rng() * ALPHA_LEVELS.length)];
    const R = rand(7, 11);
    const lum = Math.round(rand(225, 255));
    const pr = R * 0.42;
    const pa0 = rng();
    for (let p = 0; p < 5; p++) {
      const pa = (p / 5) * Math.PI * 2 + pa0;
      const px = x + Math.cos(pa) * R * 0.55, py = y + Math.sin(pa) * R * 0.55;
      const grad = g.createRadialGradient(px, py, 0, px, py, pr);
      grad.addColorStop(0, `rgba(${lum},${Math.round(lum * 0.94)},${Math.round(lum * 0.96)},${Math.max(0.06, a - 0.18)})`);
      grad.addColorStop(0.7, `rgba(${lum},${Math.round(lum * 0.9)},${Math.round(lum * 0.93)},${Math.max(0.05, a - 0.24)})`);
      grad.addColorStop(1, `rgba(150,68,94,${Math.max(0.03, a - 0.34)})`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(px, py, pr, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = `rgba(190,120,60,${a})`;
    g.beginPath();
    g.arc(x, y, R * 0.2, 0, Math.PI * 2);
    g.fill();
  }
}, { wrap: false });

// Twig card — a recursive branch lattice that is ALWAYS on the tree (the bare
// structure foliage hangs from), plus a matching white rime/snow overlay that
// fades in over winter. Drawn together so the snow sits exactly on the twigs.
function makeTwigTextures() {
  const mk = () => { const cv = document.createElement('canvas'); cv.width = cv.height = 256; return cv; };
  const cv1 = mk(), cv2 = mk();
  const g1 = cv1.getContext('2d'), g2 = cv2.getContext('2d');
  g1.lineCap = g2.lineCap = 'round';
  const UP = -Math.PI / 2;   // canvas-up ≈ world-up (cards keep a rough upright)
  const angTo = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const stroke = (x0, y0, x1, y1, w, alpha) => {
    g1.strokeStyle = `rgba(70,54,42,${alpha})`;
    g1.lineWidth = w;
    g1.beginPath(); g1.moveTo(x0, y0); g1.lineTo(x1, y1); g1.stroke();
    g2.strokeStyle = `rgba(255,255,255,${Math.min(0.95, alpha + 0.05)})`;
    g2.lineWidth = Math.max(1, w * 0.7);
    g2.beginPath(); g2.moveTo(x0, y0 - w * 0.55); g2.lineTo(x1, y1 - w * 0.55); g2.stroke();
  };
  // depth 0: medium scaffold limbs · 1: secondaries · 2: fine twigs.
  // Each branch inherits a varied alpha (children thinner than parents), so the
  // cutoff floor keeps winter airy and varied, and rising foliage cover hides
  // the weakest branches first. The rime strokes share each twig's alpha so
  // snow can never float on a culled branch.
  const branch = (x, y, ang, len, w, depth, pAlpha) => {
    const segs = depth === 0 ? 4 : 3;
    const aa = depth === 0 ? rand2(0.5, 1.0) : Math.max(0.2, pAlpha * rand2(0.7, 0.92));
    let px = x, py = y, a = ang;
    for (let k = 0; k < segs; k++) {
      a += rand2(-0.18, 0.18) + angTo(a, UP) * 0.1;
      const nx = px + Math.cos(a) * (len / segs);
      const ny = py + Math.sin(a) * (len / segs);
      // end inside the card instead of being cropped flat at its edge
      if ((nx - 128) * (nx - 128) + (ny - 128) * (ny - 128) > 116 * 116) break;
      stroke(px, py, nx, ny, Math.max(1, w * (1 - k / (segs + 1))), aa);
      if (depth < 2 && k >= 1 && rng2() < 0.75) {
        const side = rng2() < 0.5 ? 1 : -1;
        branch(nx, ny, a + side * rand2(0.45, 0.85), len * rand2(0.5, 0.65), w * 0.55, depth + 1, aa);
      }
      px = nx; py = ny;
    }
    if (depth < 2 && rng2() < 0.85) branch(px, py, a + rand2(-0.3, 0.3), len * 0.4, w * 0.45, depth + 1, aa);
  };
  for (let b = 0; b < 5; b++) {
    branch(128, 150, UP + rand2(-2.2, 2.2), rand2(70, 104), rand2(4.2, 5.8), 0, 1);
  }
  // a knot at the root so the lattice reads as growing out of the bough tip
  g1.fillStyle = 'rgba(70,54,42,1)';
  g1.beginPath();
  g1.arc(128, 150, 5.5, 0, Math.PI * 2);
  g1.fill();
  const t1 = new THREE.CanvasTexture(cv1);
  const t2 = new THREE.CanvasTexture(cv2);
  t1.colorSpace = t2.colorSpace = THREE.SRGBColorSpace;
  return [t1, t2];
}
const [twigCardTex, twigSnowTex] = makeTwigTextures();
// Twigs share the leaf cards' exact geometry (so they anchor perfectly) and
// are pushed slightly deeper in depth instead — foliage always wins overlaps.
const twigMat = new THREE.MeshToonMaterial({
  map: twigCardTex, gradientMap: toonRamp, alphaTest: 0.26, side: THREE.DoubleSide, color: 0x6e6058,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const twigSnowMat = new THREE.MeshToonMaterial({
  map: twigSnowTex, gradientMap: toonRampSoft, alphaTest: 0.26, transparent: true, opacity: 0,
  side: THREE.DoubleSide, color: 0xf4f8fc, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
addSway(twigMat, 0.05);
addSway(twigSnowMat, 0.05);
const twigDepthMat = new THREE.MeshDepthMaterial({
  depthPacking: THREE.RGBADepthPacking, map: twigCardTex, alphaTest: 0.26,
});

// God-ray beam: soft-edged shaft fading along its length
const beamTex = canvasTex(128, (g, s) => {
  const hg = g.createLinearGradient(0, 0, s, 0);
  hg.addColorStop(0, 'rgba(255,255,255,0)');
  hg.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.fillRect(0, 0, s, s);
  const vg = g.createLinearGradient(0, 0, 0, s);
  vg.addColorStop(0, 'rgba(255,255,255,1)');
  vg.addColorStop(0.8, 'rgba(255,255,255,0.25)');
  vg.addColorStop(1, 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = vg;
  g.fillRect(0, 0, s, s);
}, { wrap: false });

// Anime gleam: a sharp light line with soft ends, traced along the blade edge
const streakTex = canvasTex(128, (g, s) => {
  const hg = g.createLinearGradient(0, 0, s, 0);
  hg.addColorStop(0, 'rgba(255,255,255,0)');
  hg.addColorStop(0.42, 'rgba(255,255,255,0.12)');
  hg.addColorStop(0.5, 'rgba(255,255,255,0.95)');
  hg.addColorStop(0.58, 'rgba(255,255,255,0.12)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.fillRect(0, 0, s, s);
  const vg = g.createLinearGradient(0, 0, 0, s);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(0.3, 'rgba(255,255,255,1)');
  vg.addColorStop(0.7, 'rgba(255,255,255,1)');
  vg.addColorStop(1, 'rgba(255,255,255,0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = vg;
  g.fillRect(0, 0, s, s);
}, { wrap: false });

// Tsuka (handle) wrap — red silk ito over white samegawa, diamond pattern
const tsukaTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#efe6d2';
  g.fillRect(0, 0, 128, 512);
  g.strokeStyle = '#9c2a28'; g.lineWidth = 30; g.lineCap = 'butt';
  for (let y = -64; y < 576; y += 64) {
    g.beginPath(); g.moveTo(-16, y); g.lineTo(144, y + 64); g.stroke();
    g.beginPath(); g.moveTo(144, y); g.lineTo(-16, y + 64); g.stroke();
  }
  g.strokeStyle = 'rgba(60,12,12,0.55)'; g.lineWidth = 4;
  for (let y = -64; y < 576; y += 64) {
    g.beginPath(); g.moveTo(-16, y + 17); g.lineTo(144, y + 81); g.stroke();
    g.beginPath(); g.moveTo(144, y + 17); g.lineTo(-16, y + 81); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
})();

// ----------------------------------------------------------------------------
// Sky — gradient, two layers of drifting clouds, sun/moon disc, winter stars
// ----------------------------------------------------------------------------
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    uTop: { value: SEASONS[0].skyTop.clone() },
    uBottom: { value: SEASONS[0].skyBottom.clone() },
    uCloudCol: { value: SEASONS[0].cloud.clone() },
    uCloudAmt: { value: 0.8 },
    uSunCol: { value: SEASONS[0].sun.clone() },
    uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3) },
    uMoonDir: { value: new THREE.Vector3(-0.5, -0.8, -0.3) },
    uMoonCol: { value: C('#e9eef7') },
    uMoonVis: { value: 0 },
    uDusk: { value: 0 },
    uStar: { value: 0 },
    uOvercast: { value: 0 },
    uStorm: { value: 0 },
    uFlash: { value: 0 },
    uTime: { value: 0 },
    uCloudTex: { value: cloudTex },
  },
  vertexShader: `
    varying vec3 vW;
    void main() {
      vW = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uTop, uBottom, uCloudCol, uSunCol, uSunDir, uMoonDir, uMoonCol;
    uniform float uCloudAmt, uStar, uTime, uMoonVis, uDusk, uOvercast, uStorm, uFlash;
    uniform sampler2D uCloudTex;
    varying vec3 vW;
    void main() {
      vec3 dir = normalize(vW);
      float h = dir.y;
      vec3 col = mix(uBottom, uTop, smoothstep(-0.06, 0.5, h));

      // overcast flattens the gradient toward cool grey
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(luma) * vec3(0.82, 0.88, 1.0) * 0.62, uOvercast * 0.75);

      // sun — swells warm and wide at dawn/dusk, hides behind the overcast
      float sd = max(dot(dir, normalize(uSunDir)), 0.0);
      col += uSunCol * (pow(sd, mix(420.0, 170.0, uDusk)) * 1.3 + pow(sd, 9.0) * (0.22 + 0.45 * uDusk))
             * (1.0 - uOvercast * 0.85);

      // the moon — big, full, opposite the sun, with cratered mottling
      float md = dot(dir, normalize(uMoonDir));
      float moonDisc = smoothstep(0.9990, 0.9994, md);
      float crater = texture2D(uCloudTex, vec2(atan(dir.x, dir.z), dir.y) * 5.0).r;
      vec3 moonSurf = uMoonCol * (0.78 + 0.3 * crater);
      col = mix(col, moonSurf, moonDisc * uMoonVis * (1.0 - uOvercast * 0.75));
      col += uMoonCol * pow(max(md, 0.0), 30.0) * 0.24 * uMoonVis * (1.0 - uOvercast * 0.75);

      // EQ-style clouds: two flat scrolling layers overhead, compressing to the horizon
      vec2 puv = dir.xz / max(h, 0.05);
      vec2 uv1 = puv * 0.09 + vec2(uTime * 0.0042, uTime * 0.0015);
      vec2 uv2 = puv * 0.17 + vec2(-uTime * 0.0031, uTime * 0.0055) + 0.37;
      float c1 = texture2D(uCloudTex, uv1).r;
      float c2 = texture2D(uCloudTex, uv2).r;
      float field = c1 * 0.64 + c2 * 0.46;
      float skyH = smoothstep(0.03, 0.17, h);
      float cl = smoothstep(0.51, 0.7, field) * skyH * uCloudAmt;
      vec3 cloudShade = uCloudCol * mix(0.68, 1.22, smoothstep(0.52, 0.95, c2));
      col = mix(col, cloudShade, min(cl * 1.15, 1.0));

      // storm deck — a dense, low, fast layer that only exists in rain,
      // lit from within by the lightning
      float s1 = texture2D(uCloudTex, puv * 0.13 + vec2(uTime * 0.009, uTime * 0.0034)).r;
      float s2 = texture2D(uCloudTex, puv * 0.24 + vec2(-uTime * 0.006, uTime * 0.011) + 0.61).r;
      float sf = s1 * 0.6 + s2 * 0.5;
      float storm = smoothstep(0.28, 0.6, sf) * skyH * uStorm;
      vec3 stormCol = uCloudCol * mix(0.26, 0.52, smoothstep(0.3, 0.9, s2));
      stormCol += vec3(0.78, 0.82, 0.98) * uFlash * (0.45 + 0.9 * smoothstep(0.45, 0.95, sf));
      col = mix(col, stormCol, min(storm * 1.25, 1.0));
      col += vec3(0.68, 0.73, 0.9) * uFlash * 0.3;   // general glare

      // winter starfield
      if (uStar > 0.01 && h > 0.12) {
        vec2 sp = dir.xz / (h + 0.3);
        vec2 cell = floor(sp * 36.0);
        float rnd = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
        vec2 fp = fract(sp * 36.0) - 0.5;
        float star = smoothstep(0.1, 0.02, length(fp)) * step(0.982, rnd);
        col += vec3(star * uStar * (1.0 - cl) * (0.55 + 0.45 * sin(uTime * 1.7 + rnd * 41.0)));
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
  side: THREE.BackSide,
  depthWrite: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(70, 48, 24), skyMat);
sky.renderOrder = -2;
scene.add(sky);

// (the garden is rimmed by a stone fence — built after the rock material below)

// ----------------------------------------------------------------------------
// Ground — heightfield ring with planar-mapped noise texture
// ----------------------------------------------------------------------------
const groundGeo = new THREE.RingGeometry(0.01, CONFIG.groundRadius, 96, 28);
groundGeo.rotateX(-Math.PI / 2);
{
  const pos = groundGeo.getAttribute('position');
  const uv = groundGeo.getAttribute('uv');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, groundHeight(x, z));
    uv.setXY(i, x * 0.22, z * 0.22);          // world-planar mapping, ~4.5 m per tile
    const r = Math.hypot(x, z);
    let v = 1 - 0.07 * (0.5 + 0.5 * Math.sin(x * 1.7 + 0.4) * Math.sin(z * 1.9 + 2.0));
    v -= 0.06 * THREE.MathUtils.smoothstep(r, 2.0, 0.4);
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
  }
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.computeVertexNormals();
}
const groundMat = toonMat('#5fa75b', { vertexColors: true, map: groundTex });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

// ----------------------------------------------------------------------------
// Rocks, stone circle, snow drifts
// ----------------------------------------------------------------------------
const rockMat = toonMat('#8e959d', { map: groundTex });
const rockGeos = [];
const dummy = new THREE.Object3D();
function scatterRock(x, z, s, squash = 0.62) {
  const g = jitterGeometry(new THREE.IcosahedronGeometry(1, 1), 0.13);
  dummy.position.set(x, groundHeight(x, z) + s * squash * 0.34, z);
  dummy.rotation.set(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4);
  dummy.scale.set(s, s * squash, s * rand(0.8, 1.1));
  dummy.updateMatrix();
  g.applyMatrix4(dummy.matrix);
  rockGeos.push(g);
}
for (let i = 0; i < 9; i++) {
  const a = rng() * Math.PI * 2;
  const r = rand(2.6, 11.0);
  scatterRock(Math.cos(a) * r, Math.sin(a) * r, rand(0.28, 0.7));
}
for (let i = 0; i < 5; i++) {
  const a = rng() * Math.PI * 2;
  const r = rand(0.32, 0.62);
  scatterRock(Math.cos(a) * r, Math.sin(a) * r, rand(0.1, 0.2), 0.7);
}
const rocks = new THREE.Mesh(mergeGeometries(rockGeos), rockMat);
rocks.castShadow = true;
rocks.receiveShadow = true;
scene.add(rocks);
addOutline(rocks, 0.02);

// Stone fence around the garden — rough blocks sunk well below the terrain so
// the wall meets the ground with no gaps, with a taller post every few bays
const fenceGeos = [];
{
  const FENCE_R = 12.6;
  const segCount = 44;
  for (let i = 0; i < segCount; i++) {
    const a0 = (i / segCount) * Math.PI * 2;
    const x = Math.cos(a0) * FENCE_R, z = Math.sin(a0) * FENCE_R;
    const gh = groundHeight(x, z);
    const isPost = i % 5 === 0;
    const h = isPost ? rand(1.0, 1.1) : rand(0.62, 0.78);
    const g = jitterGeometry(
      new THREE.BoxGeometry(isPost ? 0.55 : 1.98, h, isPost ? 0.55 : rand(0.32, 0.44), 3, 2, 2),
      0.045,
    );
    dummy.position.set(x, gh + h / 2 - 0.32, z);   // bottom buried ~0.32 below grade
    dummy.rotation.set(rand(-0.025, 0.025), -a0 + Math.PI / 2, rand(-0.025, 0.025));
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    g.applyMatrix4(dummy.matrix);
    fenceGeos.push(g);
    if (isPost) {   // cap stone
      const cap = jitterGeometry(new THREE.BoxGeometry(0.68, 0.14, 0.68, 2, 1, 2), 0.03);
      dummy.position.y += h / 2 + 0.06;
      dummy.updateMatrix();
      cap.applyMatrix4(dummy.matrix);
      fenceGeos.push(cap);
    }
  }
}
const fence = new THREE.Mesh(mergeGeometries(fenceGeos), rockMat);
fence.castShadow = true;
fence.receiveShadow = true;
scene.add(fence);
addOutline(fence, 0.022);

const stoneGeos = [];
for (let i = 0; i < 7; i++) {
  const a = (i / 7) * Math.PI * 2 + rand(-0.12, 0.12);
  const r = 1.55 + rand(-0.08, 0.08);
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  const g = new THREE.CylinderGeometry(rand(0.2, 0.3), rand(0.24, 0.34), 0.09, 9);
  dummy.position.set(x, groundHeight(x, z) + 0.03, z);
  dummy.rotation.set(rand(-0.06, 0.06), rng() * Math.PI, rand(-0.06, 0.06));
  dummy.scale.set(1, 1, rand(0.8, 1));
  dummy.updateMatrix();
  g.applyMatrix4(dummy.matrix);
  stoneGeos.push(g);
}
const stones = new THREE.Mesh(mergeGeometries(stoneGeos), rockMat);
stones.castShadow = true;
stones.receiveShadow = true;
scene.add(stones);

// stacked stone cairns — quiet tributes left at the grave
{
  const cairnGeos = [];
  for (const [cx, cz] of [[-1.95, 1.5], [2.2, -1.5]]) {
    let y = groundHeight(cx, cz) - 0.02;
    for (let i = 0; i < 3; i++) {
      const s = 0.15 - i * 0.04;
      const g = jitterGeometry(new THREE.IcosahedronGeometry(s, 1), s * 0.16);
      y += s * 0.62;
      dummy.position.set(cx + rand(-0.012, 0.012), y, cz + rand(-0.012, 0.012));
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(1, 0.68, rand(0.85, 1.05));
      dummy.updateMatrix();
      g.applyMatrix4(dummy.matrix);
      cairnGeos.push(g);
      y += s * 0.52;
    }
  }
  const cairns = new THREE.Mesh(mergeGeometries(cairnGeos), rockMat);
  cairns.castShadow = true;
  cairns.receiveShadow = true;
  scene.add(cairns);
  addOutline(cairns, 0.012);
}

const driftMat = toonMat('#f3f7fb', { gradientMap: toonRampSoft });
const drifts = [];
for (let i = 0; i < 7; i++) {
  const a = rng() * Math.PI * 2;
  const r = rand(2.2, 10.5);
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  const m = new THREE.Mesh(jitterGeometry(new THREE.IcosahedronGeometry(1, 1), 0.1), driftMat);
  m.position.set(x, groundHeight(x, z), z);
  m.userData.base = rand(0.5, 1.2);
  m.scale.setScalar(0.001);
  scene.add(m);
  drifts.push(m);
}

// ----------------------------------------------------------------------------
// Stone lanterns (tōrō)
// ----------------------------------------------------------------------------
const lanternLights = [];
const lanternGlows = [];
const lanternPoints = [];   // world position of each firebox, for the moths
const snowCaps = [];
const capMat = new THREE.MeshToonMaterial({
  color: 0xf3f7fb, gradientMap: toonRampSoft, transparent: true, opacity: 0,
});
function buildLantern(x, z, s) {
  const grp = new THREE.Group();
  const stone = toonMat('#878d94', { map: groundTex });
  const roofM = toonMat('#6e747c');
  const parts = [
    [new THREE.CylinderGeometry(0.34, 0.4, 0.14, 6), stone, 0.07],
    [new THREE.CylinderGeometry(0.1, 0.13, 0.5, 6), stone, 0.39],
    [new THREE.CylinderGeometry(0.26, 0.18, 0.1, 6), stone, 0.69],
    [new THREE.BoxGeometry(0.3, 0.28, 0.3), stone, 0.88],
    [new THREE.ConeGeometry(0.42, 0.24, 4), roofM, 1.13],
    [new THREE.SphereGeometry(0.06, 8, 6), stone, 1.3],
  ];
  for (const [g, m, y] of parts) {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.y = y;
    if (g.type === 'ConeGeometry') mesh.rotation.y = Math.PI / 4;
    mesh.castShadow = true;
    grp.add(mesh);
    addOutline(mesh, 0.018);
  }
  const paneM = new THREE.MeshBasicMaterial({ color: 0xffd27f });
  for (let i = 0; i < 4; i++) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.16), paneM);
    const a = (i / 4) * Math.PI * 2;
    pane.position.set(Math.sin(a) * 0.153, 0.88, Math.cos(a) * 0.153);
    pane.rotation.y = a;
    grp.add(pane);
  }
  const light = new THREE.PointLight(0xffb45f, 0, 9, 1.7);
  light.position.y = 0.88;
  grp.add(light);
  lanternLights.push(light);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softGlow, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0,
  }));
  glow.position.y = 0.88;
  glow.scale.setScalar(1.5);
  grp.add(glow);
  lanternGlows.push(glow.material);

  // snow hugging the roof — same silhouette, slightly inflated, fades in/out
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.445, 0.255, 4), capMat);
  cap.position.y = 1.137;
  cap.rotation.y = Math.PI / 4;
  cap.visible = false;
  grp.add(cap);
  snowCaps.push(cap);

  grp.position.set(x, groundHeight(x, z) - 0.02, z);
  grp.scale.setScalar(s);
  scene.add(grp);
  lanternPoints.push(new THREE.Vector3(x, groundHeight(x, z) - 0.02 + 0.88 * s, z));
}
buildLantern(3.4, -2.3, 1.0);
buildLantern(-4.8, 3.9, 0.82);

// lantern moths — drawn to the glow on mild nights (they sit out the winter
// and shelter from the rain)
const mothMat = new THREE.MeshBasicMaterial({
  color: 0x57493a, side: THREE.DoubleSide, transparent: true, opacity: 0,
});
const moths = [];
{
  const wingL = new THREE.PlaneGeometry(0.044, 0.026).translate(-0.022, 0, 0);
  const wingR = new THREE.PlaneGeometry(0.044, 0.026).translate(0.022, 0, 0);
  for (let i = 0; i < lanternPoints.length * 3; i++) {
    const grp = new THREE.Group();
    const wl = new THREE.Mesh(wingL, mothMat);
    const wr = new THREE.Mesh(wingR, mothMat);
    grp.add(wl, wr);
    grp.visible = false;
    scene.add(grp);
    moths.push({
      grp, wl, wr,
      center: lanternPoints[i % lanternPoints.length],
      r: rand2(0.13, 0.3),
      sp: rand2(1.6, 2.7) * (rng2() < 0.5 ? 1 : -1),
      wob: rand2(2.5, 4),
      ph: rng2() * 7,
      flap: rand2(20, 28),
    });
  }
}

// ----------------------------------------------------------------------------
// Incense bowl — an offering beside the sword. The bowl is always there; the
// sticks appear on autumn's second day and burn down across that day & night.
// ----------------------------------------------------------------------------
const incense = new THREE.Group();
{
  const ix = 1.0, iz = 0.62;
  incense.position.set(ix, groundHeight(ix, iz), iz);
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.05, 9), rockMat);
  slab.position.y = 0.02;
  slab.castShadow = true;
  incense.add(slab);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.05, 0.08, 14), toonMat('#3d4450'));
  bowl.position.y = 0.085;
  bowl.castShadow = true;
  incense.add(bowl);
  addOutline(bowl, 0.008);
  const sand = new THREE.Mesh(new THREE.CircleGeometry(0.068, 12), toonMat('#cfc3a4'));
  sand.rotation.x = -Math.PI / 2;
  sand.position.y = 0.126;
  incense.add(sand);
  scene.add(incense);
}
const STICK_H = 0.24;
const stickGroup = new THREE.Group();
stickGroup.position.y = 0.125;
stickGroup.visible = false;
incense.add(stickGroup);
const stickMat = toonMat('#7a4f33');
const sticks = [];
for (let i = 0; i < 3; i++) {
  const geo = new THREE.CylinderGeometry(0.0042, 0.0042, STICK_H, 5).translate(0, STICK_H / 2, 0);
  const m = new THREE.Mesh(geo, stickMat);
  const ta = (i / 3) * Math.PI * 2 + 0.5;
  m.position.set(Math.cos(ta) * 0.013, 0, Math.sin(ta) * 0.013);
  m.rotation.set(Math.cos(ta) * 0.09, 0, Math.sin(ta) * 0.09);
  stickGroup.add(m);
  const ember = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softGlow, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0, color: 0xff8a3c,
  }));
  ember.scale.setScalar(0.045);
  stickGroup.add(ember);
  sticks.push({ stick: m, ember, ph: i * 2.1 });
}

// ----------------------------------------------------------------------------
// A visitor's trail in the snow — footprints in from the grove edge, a kneeling
// depression before the blade, and footprints back out. They appear one winter
// morning and fade as fresh snow fills them, vanishing with the melt.
// ----------------------------------------------------------------------------
const printTex = canvasTex(64, (g, s) => {
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}, { wrap: false });
const printsMat = new THREE.MeshToonMaterial({
  map: printTex, gradientMap: toonRampSoft, color: 0x3a4a5e, vertexColors: true,
  transparent: true, opacity: 0, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
const prints = (() => {
  const geos = [];
  const addPrint = (px, pz, ang, w, h, tone) => {
    const gq = new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2).rotateY(ang + rand2(-0.12, 0.12));
    const cols = new Float32Array(gq.getAttribute('position').count * 3).fill(tone);
    gq.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    gq.translate(px, groundHeight(px, pz) + 0.05, pz);
    geos.push(gq);
  };
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(7.4, 0, -5.4),
    new THREE.Vector3(4.7, 0, -2.7),
    new THREE.Vector3(2.7, 0, -0.7),
    new THREE.Vector3(1.15, 0, 0.3),
  ]);
  const n = Math.floor(path.getLength() / 0.5);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = path.getPoint(t);
    const tan = path.getTangent(t);
    const ang = Math.atan2(tan.x, tan.z);
    const side = i % 2 ? 1 : -1;
    addPrint(p.x - tan.z * side * 0.13, p.z + tan.x * side * 0.13, ang, 0.15, 0.24, 1);
    // the return lane, half a step out of phase
    addPrint(p.x - tan.z * (side * 0.13 + 0.34), p.z + tan.x * (side * 0.13 + 0.34), ang + Math.PI, 0.15, 0.24, 0.85);
  }
  addPrint(0.88, 0.5, 0.45, 0.6, 0.52, 0.75);   // kneeling depression
  addPrint(0.74, 0.34, 0.45, 0.2, 0.17, 1);     // knees
  addPrint(1.0, 0.62, 0.45, 0.2, 0.17, 1);
  const m = new THREE.Mesh(mergeGeometries(geos), printsMat);
  m.visible = false;
  scene.add(m);
  return m;
})();

// smoke — billboarded wisps that ride the wind
const SMOKE_N = 36;
const smokeMat = new THREE.MeshBasicMaterial({
  map: softDot, transparent: true, opacity: 0.28, depthWrite: false, color: 0xb9c2cc,
});
const smoke = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.09, 0.09), smokeMat, SMOKE_N);
smoke.frustumCulled = false;
smoke.visible = false;
const smokeItems = [];
for (let i = 0; i < SMOKE_N; i++) {
  smokeItems.push({ age: 1e9, life: rand(3.5, 5.5), pos: new THREE.Vector3(), vy: rand(0.22, 0.38), phase: rng() * 7 });
}
scene.add(smoke);

// ----------------------------------------------------------------------------
// Cherry trees — gnarled tapered limbs + foliage cluster cards
// ----------------------------------------------------------------------------
const trees = [];
const trunkMat = toonMat('#8b8178', { map: barkTex });

function limb(curve, segs, radialSegs, rBase, rTip, gnarl = 0, flare = 0) {
  const g = new THREE.TubeGeometry(curve, segs, 1, radialSegs);
  return taperTube(g, radialSegs, (t) => {
    let r = THREE.MathUtils.lerp(rBase, rTip, t * t * (3 - 2 * t));
    if (flare > 0) r *= 1 + flare * Math.pow(Math.max(0, (0.14 - t)) / 0.14, 1.6);
    if (gnarl > 0) r *= 1 + gnarl * Math.sin(t * 37 + rBase * 91);
    return r;
  });
}

function buildTree(x, z, treeIdx) {
  const grp = new THREE.Group();
  grp.position.set(x, groundHeight(x, z) - 0.08, z);

  const out = new THREE.Vector3(x, 0, z).normalize();
  const tang = new THREE.Vector3(-out.z, 0, out.x);
  const lean = rand(0.25, 0.55);
  const twist = rand(-0.35, 0.35);
  const height = rand(2.5, 3.1);

  const p = (t, up) => new THREE.Vector3(
    out.x * lean * t + tang.x * twist * t + rand(-0.07, 0.07),
    up,
    out.z * lean * t + tang.z * twist * t + rand(-0.07, 0.07),
  );
  const trunkPts = [new THREE.Vector3(0, -0.15, 0), p(0.45, height * 0.33), p(0.8, height * 0.68), p(1, height)];
  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
  const geos = [limb(trunkCurve, 14, 8, rand(0.24, 0.28), 0.09, 0.06, 1.4)];

  // root flares
  for (let i = 0; i < 3; i++) {
    const ra = rng() * Math.PI * 2;
    const rd = new THREE.Vector3(Math.cos(ra), 0, Math.sin(ra));
    const root = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.22, 0),
      rd.clone().multiplyScalar(0.3).setY(0.04),
      rd.clone().multiplyScalar(0.55).setY(-0.18),
    ]);
    geos.push(limb(root, 5, 6, 0.14, 0.04));
  }

  // main boughs, evenly fanned, drooping at the tips like an old cherry
  const anchors = [];      // [position, clusterSize]
  const boughCount = 5;
  for (let i = 0; i < boughCount; i++) {
    const bt = rand(0.5, 0.95);
    const start = trunkCurve.getPoint(bt);
    const ba = (i / boughCount) * Math.PI * 2 + rand(-0.4, 0.4);
    const dir = new THREE.Vector3(Math.cos(ba), rand(0.5, 0.95), Math.sin(ba)).normalize();
    const len = rand(1.0, 1.55);
    const end = start.clone().addScaledVector(dir, len);
    end.y -= len * 0.16;                                    // droop
    const mid = start.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, 0.16, 0));
    const curve = new THREE.CatmullRomCurve3([start, mid, end]);
    geos.push(limb(curve, 7, 6, 0.085, 0.03, 0.05));
    geos.push(new THREE.SphereGeometry(0.034, 6, 5).translate(end.x, end.y, end.z));
    anchors.push([end, rand(1.15, 1.5)]);

    // twigs off each bough
    for (let k = 0; k < 2; k++) {
      const tt = rand(0.55, 0.9);
      const ts = curve.getPoint(tt);
      const td = new THREE.Vector3(rand(-1, 1), rand(0.3, 0.9), rand(-1, 1)).normalize();
      const tl = rand(0.35, 0.6);
      const te = ts.clone().addScaledVector(td, tl);
      te.y -= tl * 0.1;
      geos.push(limb(new THREE.CatmullRomCurve3([ts, te]), 3, 5, 0.028, 0.011));
      anchors.push([te, rand(0.75, 1.05)]);
    }
  }
  const top = trunkCurve.getPoint(1);
  geos.push(new THREE.SphereGeometry(0.09, 7, 6).translate(top.x, top.y, top.z));
  // crown cards root ON the trunk top, not floating above it
  anchors.push([top.clone().add(new THREE.Vector3(0, 0.08, 0)), rand(1.25, 1.5)]);
  anchors.push([top.clone().add(new THREE.Vector3(rand(-0.3, 0.3), 0.04, rand(-0.3, 0.3))), rand(1.0, 1.3)]);

  const wood = new THREE.Mesh(mergeGeometries(geos), trunkMat);
  wood.castShadow = true;
  grp.add(wood);
  addOutline(wood, 0.02);

  // foliage cluster cards: 3 crossed quads per cluster, spherical normals
  const cardGeos = [];
  const spots = [];
  const vtx = new THREE.Vector3();
  for (const [c, size] of anchors) {
    for (let k = 0; k < 3; k++) {
      const g = new THREE.PlaneGeometry(size, size * 0.82);
      // the twig texture's branch root (u .5, v .414) becomes the pivot, so
      // every card is rooted exactly at the bough tip it hangs from
      g.translate(0, size * 0.82 * 0.086, 0);
      dummy.position.set(c.x + rand(-0.04, 0.04), c.y + rand(-0.04, 0.04), c.z + rand(-0.04, 0.04));
      dummy.rotation.set(rand(-0.45, 0.45), rng() * Math.PI * 2, rand(-0.5, 0.5));
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      g.applyMatrix4(dummy.matrix);
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      for (let vi = 0; vi < pos.count; vi++) {
        vtx.fromBufferAttribute(pos, vi).sub(c).normalize();
        nor.setXYZ(vi, vtx.x, vtx.y, vtx.z);   // rounded-cluster shading
      }
      cardGeos.push(g);
    }
    spots.push({ pos: c.clone().add(grp.position), r: size * 0.5 });
  }
  const cardGeo = mergeGeometries(cardGeos);

  const paletteIdx = treeIdx % 4;
  const leafMat = new THREE.MeshToonMaterial({
    map: leafCardTex, gradientMap: toonRamp, color: SUMMER_LEAF[paletteIdx].clone(),
    alphaTest: 0.5, side: THREE.DoubleSide,
  });
  const blossomMat = new THREE.MeshToonMaterial({
    map: blossomCardTex, gradientMap: toonRamp, color: BLOSSOM_PINK[paletteIdx].clone(),
    alphaTest: 0.5, side: THREE.DoubleSide,
  });
  addSway(leafMat, 0.05);
  addSway(blossomMat, 0.05);

  const leafMesh = new THREE.Mesh(cardGeo, leafMat);
  const blossomMesh = new THREE.Mesh(cardGeo, blossomMat);
  for (const [mesh, tex] of [[leafMesh, leafCardTex], [blossomMesh, blossomCardTex]]) {
    mesh.castShadow = true;
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5,
    });
    grp.add(mesh);
  }

  // the permanent twig lattice — the SAME card geometry as the foliage, so
  // every spray roots exactly at its bough tip (depth bias handles overlap)
  const twigMesh = new THREE.Mesh(cardGeo, twigMat);
  twigMesh.castShadow = true;
  twigMesh.customDepthMaterial = twigDepthMat;
  grp.add(twigMesh);
  const snowTwigMesh = new THREE.Mesh(cardGeo, twigSnowMat);
  grp.add(snowTwigMesh);

  // petal / leaf carpet beneath the tree, conforming to the terrain
  const carpetGeo = new THREE.RingGeometry(0.03, rand(1.4, 1.8), 22, 5);
  carpetGeo.rotateX(-Math.PI / 2);
  {
    const pos = carpetGeo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + x, wz = pos.getZ(i) + z;
      pos.setY(i, groundHeight(wx, wz) - grp.position.y + 0.035);
    }
    carpetGeo.computeVertexNormals();
  }
  const carpetMat = new THREE.MeshToonMaterial({
    color: 0xf5a8c0, gradientMap: toonRamp, transparent: true, opacity: 0,
    map: leafCardTex, alphaTest: 0.28,        // litter dissolves tuft by tuft as it fades
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const carpet = new THREE.Mesh(carpetGeo, carpetMat);
  carpet.receiveShadow = true;
  grp.add(carpet);

  // god-ray shafts — crossed beam cards hanging from the canopy, aimed along
  // the sun/moon direction each frame, visible only when foliage filters light
  const beamMat = new THREE.MeshBasicMaterial({
    map: beamTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0,
  });
  const beamGroup = new THREE.Group();
  const beamCenter = new THREE.Vector3();
  for (const [a] of anchors) beamCenter.add(a);
  beamCenter.divideScalar(anchors.length);
  beamGroup.position.copy(beamCenter);
  for (let k = 0; k < 2; k++) {
    const bg = new THREE.PlaneGeometry(rand(1.0, 1.5), 5.5);
    bg.translate(rand(-0.3, 0.3), -2.45, 0);
    const beam = new THREE.Mesh(bg, beamMat);
    beam.rotation.y = k * Math.PI / 2 + rand(-0.3, 0.3);
    beamGroup.add(beam);
  }
  grp.add(beamGroup);

  scene.add(grp);
  trees.push({
    grp, leafMat, blossomMat, leafMesh, blossomMesh, carpetMat, paletteIdx,
    beamMat, beamGroup,
    phase: rng() * Math.PI * 2,
    tOff: rand(-0.05, 0.05),       // per-tree seasonal stagger
    covB: 0, covL: 0,
    spots,
  });
}

{
  const placed = [];
  let attempts = 0;
  while (placed.length < CONFIG.treeCount && attempts++ < 200) {
    const a = rng() * Math.PI * 2;
    const r = rand(4.3, 5.9);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (placed.some((q) => Math.hypot(q.x - x, q.z - z) < 2.8)) continue;
    placed.push({ x, z });
  }
  placed.forEach((q, i) => buildTree(q.x, q.z, i));
}

// ----------------------------------------------------------------------------
// The katana — mirror-polished steel (equirect env reflection + hot specular)
// ----------------------------------------------------------------------------
const envTex = canvasTex(256, (g, s) => {
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#bcd8f2');
  grad.addColorStop(0.52, '#eef5fb');
  grad.addColorStop(0.6, '#ffffff');
  grad.addColorStop(0.66, '#8aa0b8');
  grad.addColorStop(1, '#3c4a42');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const rg = g.createRadialGradient(s * 0.7, s * 0.28, 0, s * 0.7, s * 0.28, s * 0.22);
  rg.addColorStop(0, 'rgba(255,250,230,1)');
  rg.addColorStop(1, 'rgba(255,250,230,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
}, { wrap: false });
envTex.mapping = THREE.EquirectangularReflectionMapping;
const shineMats = [];   // [material, base reflectivity] — dimmed at night

const sword = new THREE.Group();
{
  const BLADE_LEN = 1.18;

  const shape = new THREE.Shape([
    new THREE.Vector2(0.055, 0),
    new THREE.Vector2(0.018, 0.011),
    new THREE.Vector2(-0.028, 0.0095),
    new THREE.Vector2(-0.042, 0),
    new THREE.Vector2(-0.028, -0.0095),
    new THREE.Vector2(0.018, -0.011),
  ]);
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: BLADE_LEN, steps: 72, bevelEnabled: false });

  const cEdge = C('#f4f7f9'), cHamon = C('#dde5eb'), cSteel = C('#b4bfc9'), cSpine = C('#79828d');
  const pos = bladeGeo.getAttribute('position');
  const colArr = new Float32Array(pos.count * 3);
  const tmpC = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), zz = pos.getZ(i);
    const t = zz / BLADE_LEN;
    const hamonX = 0.014 + 0.009 * Math.sin(t * 26 + 1.7) + 0.004 * Math.sin(t * 61);
    const e = THREE.MathUtils.smoothstep(x, hamonX - 0.004, hamonX + 0.01);
    const sp = THREE.MathUtils.smoothstep(-x, 0.022, 0.04);
    tmpC.copy(cSteel).lerp(cHamon, THREE.MathUtils.smoothstep(x, hamonX - 0.016, hamonX - 0.002));
    tmpC.lerp(cEdge, e);
    tmpC.lerp(cSpine, sp * 0.85);
    colArr[i * 3] = tmpC.r; colArr[i * 3 + 1] = tmpC.g; colArr[i * 3 + 2] = tmpC.b;

    const taper = (0.16 + 0.84 * THREE.MathUtils.smoothstep(t, 0, 0.16)) *
                  (0.9 + 0.1 * THREE.MathUtils.smoothstep(t, 0.2, 0.7));
    const bow = -0.085 * (1 - t) * (1 - t);
    pos.setXYZ(i, x * taper + bow, y * taper, zz);
  }
  bladeGeo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  bladeGeo.computeVertexNormals();
  bladeGeo.rotateX(-Math.PI / 2);

  const blade = new THREE.Mesh(bladeGeo, new THREE.MeshPhongMaterial({
    color: 0xffffff, vertexColors: true,
    specular: 0xffffff, shininess: 140, emissive: 0x10151c,
    envMap: envTex, combine: THREE.MixOperation, reflectivity: 0.62,
  }));
  shineMats.push([blade.material, 0.62]);
  blade.castShadow = true;
  sword.add(blade);
  addOutline(blade, 0.011);

  const brass = new THREE.MeshPhongMaterial({
    color: 0xc9a35a, specular: 0xffe2a0, shininess: 60,
    envMap: envTex, combine: THREE.MixOperation, reflectivity: 0.3,
  });
  shineMats.push([brass, 0.3]);
  const iron = toonMat('#3f3a33');

  const habaki = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.075, 12), brass);
  habaki.scale.set(1.55, 1, 0.62);
  habaki.position.y = BLADE_LEN + 0.012;
  habaki.castShadow = true;
  sword.add(habaki);
  addOutline(habaki, 0.012);

  const tsuba = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.088, 0.02, 24), iron);
  tsuba.position.y = BLADE_LEN + 0.058;
  tsuba.castShadow = true;
  sword.add(tsuba);
  addOutline(tsuba, 0.012);
  const tsubaRim = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.007, 8, 28), brass);
  tsubaRim.rotation.x = Math.PI / 2;
  tsubaRim.position.y = BLADE_LEN + 0.058;
  sword.add(tsubaRim);

  const tsuka = new THREE.Mesh(
    new THREE.CylinderGeometry(0.034, 0.036, 0.44, 16),
    new THREE.MeshToonMaterial({ map: tsukaTex, gradientMap: toonRamp }),
  );
  tsuka.scale.set(1.35, 1, 0.9);
  tsuka.position.y = BLADE_LEN + 0.29;
  tsuka.castShadow = true;
  sword.add(tsuka);
  addOutline(tsuka, 0.012);

  const kashira = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.042, 0.035, 12), iron);
  kashira.scale.set(1.35, 1, 0.9);
  kashira.position.y = BLADE_LEN + 0.525;
  sword.add(kashira);
  addOutline(kashira, 0.012);

  const rope = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.013, 8, 24), toonMat('#cdb472'));
  rope.rotation.x = Math.PI / 2;
  rope.position.y = BLADE_LEN + 0.13;
  sword.add(rope);
  addOutline(rope, 0.008);

  // sageo tassel — a jointed cord that swings in the wind
  const cordMat = toonMat('#7e2a36');
  const tuftMat = toonMat('#9c3242');
  const tasselSegs = [];
  let tParent = new THREE.Group();
  tParent.position.set(0.046, BLADE_LEN + 0.5, 0.012);
  sword.add(tParent);
  for (let i = 0; i < 3; i++) {
    const joint = new THREE.Group();
    if (i > 0) joint.position.y = -0.085;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.088, 6), cordMat);
    seg.position.y = -0.044;
    joint.add(seg);
    tParent.add(joint);
    tasselSegs.push(joint);
    tParent = joint;
  }
  const tHead = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.019, 0.03, 8), brass);
  tHead.position.y = -0.1;
  tParent.add(tHead);
  const tTuft = new THREE.Mesh(new THREE.ConeGeometry(0.021, 0.075, 8), tuftMat);
  tTuft.position.y = -0.148;
  tParent.add(tTuft);
  addOutline(tTuft, 0.006);
  sword.userData.tasselSegs = tasselSegs;

  // anime gleam: a streak that traces the edge + a star at its tip
  const streak = new THREE.Mesh(
    mergeGeometries([
      new THREE.PlaneGeometry(0.11, 0.46),
      new THREE.PlaneGeometry(0.11, 0.46).rotateY(Math.PI / 2),
    ]),
    new THREE.MeshBasicMaterial({
      map: streakTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 0,
    }),
  );
  sword.add(streak);
  sword.userData.streak = streak;
  const glint = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDot, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0,
  }));
  glint.scale.setScalar(0.2);
  sword.add(glint);
  sword.userData.glint = glint;

  sword.position.set(0, GH0 - 0.24, 0);
  sword.rotation.z = 0.13;
  sword.rotation.x = -0.05;
  sword.rotation.y = 0.7;
  sword.scale.setScalar(1.55);
  scene.add(sword);
}

// ----------------------------------------------------------------------------
// Particles
// ----------------------------------------------------------------------------
const wind = new THREE.Vector3();       // gust impulses (decay)
let breezeX = 0, breezeZ = 0;           // ambient wandering breeze
const quatTmp = new THREE.Quaternion();

class DriftingInstances {
  constructor({ count, geometry, material, fall, sway, spin, colors, linger = [5, 6.6], vortex = false }) {
    this.count = count;
    this.lingerA = linger[0];
    this.lingerB = linger[1];
    this.vortex = vortex;
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.items = [];
    for (let i = 0; i < count; i++) {
      this.items.push({
        active: false,
        pos: new THREE.Vector3(),
        rot: new THREE.Euler(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI),
        spin: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(spin * rand(0.5, 1.5)),
        vy: fall * rand(0.7, 1.4),
        swayAmp: sway * rand(0.6, 1.4),
        swayFreq: rand(0.7, 1.6),
        phase: rng() * Math.PI * 2,
        size: rand(0.75, 1.3),
        landT: 0,
      });
      if (colors) this.mesh.setColorAt(i, colors[Math.floor(rng() * colors.length)]);
      this.writeMatrix(i, 0);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    scene.add(this.mesh);
  }
  writeMatrix(i, scale) {
    const it = this.items[i];
    quatTmp.setFromEuler(it.rot);
    dummy.position.copy(it.pos);
    dummy.quaternion.copy(quatTmp);
    dummy.scale.setScalar(Math.max(scale, 1e-4));
    dummy.updateMatrix();
    this.mesh.setMatrixAt(i, dummy.matrix);
  }
  update(dt, t, weight, spawnFn) {
    let active = 0, falling = 0;
    for (const it of this.items) if (it.active) { active++; if (it.landT === 0) falling++; }
    if (active === 0 && weight <= 0.02) {       // off-season: skip sim + upload + draw
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    // target counts AIRBORNE items, so the sky stays full while landed ones
    // blanket the ground (the fixed pool still bounds the total)
    const target = Math.round(this.count * Math.min(1, weight * 1.2) * 0.5);
    let toSpawn = Math.min(Math.max(0, target - falling), Math.ceil(this.count * dt * 0.5) + 1);
    let dirty = false;

    for (let i = 0; i < this.count; i++) {
      const it = this.items[i];
      if (!it.active) {
        if (toSpawn > 0 && weight > 0.02 && spawnFn(i, this)) toSpawn--;
        else continue;
      }
      dirty = true;
      if (it.landT > 0) {
        it.landT += dt;
        const shrink = 1 - THREE.MathUtils.smoothstep(it.landT, this.lingerA, this.lingerB);
        this.writeMatrix(i, it.size * shrink);
        if (it.landT > this.lingerB) { it.active = false; this.writeMatrix(i, 0); }
        continue;
      }
      it.pos.y -= it.vy * dt;
      const sw = Math.sin(t * it.swayFreq + it.phase) * it.swayAmp;
      const cw = Math.cos(t * it.swayFreq * 0.83 + it.phase) * it.swayAmp * 0.8;
      it.pos.x += (sw + wind.x + breezeX) * dt;
      it.pos.z += (cw + wind.z + breezeZ) * dt;
      it.rot.x += it.spin.x * dt;
      it.rot.y += it.spin.y * dt;
      it.rot.z += it.spin.z * dt;
      // during the storm, petals near the blade are drawn into a slow rising
      // spiral — strongest at the axis, releasing out of the top
      if (this.vortex && petalStormW > 0.02) {
        const dx = it.pos.x, dz = it.pos.z;
        const r = Math.hypot(dx, dz);
        if (r > 0.05 && r < 5.5) {
          const near = 1 - r / 5.5;
          const k = petalStormW * near;
          const tang = (1.1 + 2.6 * near) * k * sm01((r - 0.1) / 0.8);
          it.pos.x += (-dz / r) * tang * dt;
          it.pos.z += (dx / r) * tang * dt;
          it.pos.y += (0.5 + 2.1 * near * near) * k * dt;
          it.pos.x -= (dx / r) * 0.25 * k * dt;
          it.pos.z -= (dz / r) * 0.25 * k * dt;
          if (it.pos.y > 7.5) { it.active = false; this.writeMatrix(i, 0); continue; }
        }
      }
      const gh = groundHeight(it.pos.x, it.pos.z);
      if (it.pos.y <= gh + 0.02) {
        it.pos.y = gh + 0.02;
        it.landT = 1e-4;
      }
      this.writeMatrix(i, it.size);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// petal: a small rounded oval, gently cupped
const petalShape = new THREE.Shape();
petalShape.absellipse(0, 0, 0.034, 0.023, 0, Math.PI * 2);
const petalGeo = new THREE.ShapeGeometry(petalShape, 7);
{
  const pos = petalGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setZ(i, 0.012 * (1 - (x / 0.034) ** 2));
  }
  petalGeo.computeVertexNormals();
}
const petals = new DriftingInstances({
  count: CONFIG.petalCount,
  geometry: petalGeo,
  material: new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRampSoft, side: THREE.DoubleSide }),
  fall: 0.42, sway: 0.3, spin: 1.6,
  linger: [7, 10],        // landed petals blanket the ground through the storm
  vortex: true,           // the storm spirals them up around the blade
  colors: [C('#f8b8cc'), C('#fadbe6'), C('#f293b5'), C('#ffd2e0')],
});

const leafShape = new THREE.Shape();
leafShape.moveTo(0, -0.052);
leafShape.quadraticCurveTo(0.047, -0.012, 0, 0.058);
leafShape.quadraticCurveTo(-0.047, -0.012, 0, -0.052);
const leaves = new DriftingInstances({
  count: CONFIG.leafCount,
  geometry: new THREE.ShapeGeometry(leafShape),
  material: new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRampSoft, side: THREE.DoubleSide }),
  fall: 0.6, sway: 0.42, spin: 2.4,
  colors: [C('#e8742c'), C('#d94f30'), C('#f0a832'), C('#c43d2e'), C('#e89a3c')],
});

// drop from a random foliage cluster — only if that tree still carries foliage
const spawnVec = new THREE.Vector3();
let petalStormW = 0;   // set each frame; during the storm petals ride the wind grove-wide
function makeCanopySpawner(coverageKey) {
  return (i, sys) => {
    const tree = trees[Math.floor(rng() * trees.length)];
    if (tree[coverageKey] < 0.06) return false;
    const spot = tree.spots[Math.floor(rng() * tree.spots.length)];
    spawnVec.copy(spot.pos);
    spawnVec.x += rand(-spot.r, spot.r);
    spawnVec.y += rand(-spot.r, spot.r) * 0.6;
    spawnVec.z += rand(-spot.r, spot.r);
    const it = sys.items[i];
    it.active = true;
    it.landT = 0;
    it.pos.copy(spawnVec);
    return true;
  };
}
const spawnPetalCanopy = makeCanopySpawner('covB');
const spawnLeaf = makeCanopySpawner('covL');
const spawnPetal = (i, sys) => {
  if (petalStormW > 0.08 && rng() < 0.55) {    // wind-borne, biased toward the blade
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * (rng() < 0.5 ? 4.5 : 8.5);
    spawnVec.set(Math.cos(a) * r, rand(1.8, 5), Math.sin(a) * r);
    const it = sys.items[i];
    it.active = true;
    it.landT = 0;
    it.pos.copy(spawnVec);
    return true;
  }
  return spawnPetalCanopy(i, sys);
};

// snow — point cloud filling the dome
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CONFIG.snowCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
const snowData = [];
for (let i = 0; i < CONFIG.snowCount; i++) {
  snowData.push({ speed: rand(0.4, 0.95), phase: rng() * Math.PI * 2, amp: rand(0.1, 0.4) });
  const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 12;
  snowGeo.getAttribute('position').setXYZ(i, Math.cos(a) * r, rand(0, 11), Math.sin(a) * r);
}
const snowMat = new THREE.PointsMaterial({
  size: 0.085, map: softDot, transparent: true, depthWrite: false, opacity: 0,
  color: 0xffffff, sizeAttenuation: true,
});
const snow = new THREE.Points(snowGeo, snowMat);
snow.frustumCulled = false;
snow.renderOrder = 2;
scene.add(snow);

// rain — fast streaks (crossed quads so they read from every angle)
const rainGeo = mergeGeometries([
  new THREE.PlaneGeometry(0.014, 0.34),
  new THREE.PlaneGeometry(0.014, 0.34).rotateY(Math.PI / 2),
]);
const rain = {
  mesh: new THREE.InstancedMesh(rainGeo, new THREE.MeshBasicMaterial({
    color: 0xc6dcef, transparent: true, opacity: 0.45, depthWrite: false,
  }), CONFIG.rainCount),
  items: [],
  update(dt, weight) {
    let active = 0;
    for (const it of this.items) if (it.active) active++;
    if (active === 0 && weight <= 0.02) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const target = Math.round(this.count * Math.min(1, weight * 1.15));
    let toSpawn = Math.min(Math.max(0, target - active), Math.ceil(this.count * dt * 2) + 2);
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const it = this.items[i];
      if (!it.active) {
        if (toSpawn > 0 && weight > 0.02) {
          toSpawn--;
          it.active = true;
          const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 12;
          it.pos.set(Math.cos(a) * r, rand(7, 11), Math.sin(a) * r);
        } else continue;
      }
      dirty = true;
      it.pos.y -= it.v * dt;
      it.pos.x += (wind.x + breezeX) * 2.4 * dt;
      it.pos.z += (wind.z + breezeZ) * 2.4 * dt;
      if (it.pos.y < groundHeight(it.pos.x, it.pos.z) + 0.15) {
        if (active > target) it.active = false;
        else it.pos.y = rand(7, 11);
      }
      dummy.position.copy(it.pos);
      // streaks slant with the wind they're falling through
      dummy.rotation.set(
        Math.atan2((wind.z + breezeZ) * 2.4, 10),
        0,
        -Math.atan2((wind.x + breezeX) * 2.4, 10),
      );
      dummy.scale.set(1, it.active ? it.len : 1e-4, 1);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  },
};
rain.count = CONFIG.rainCount;
rain.mesh.frustumCulled = false;
rain.mesh.castShadow = false;
rain.mesh.renderOrder = 2;
for (let i = 0; i < CONFIG.rainCount; i++) {
  rain.items.push({ active: false, pos: new THREE.Vector3(), v: rand(8.5, 13), len: rand(0.8, 1.25) });
  dummy.position.set(0, -100, 0);
  dummy.rotation.set(0, 0, 0);
  dummy.scale.setScalar(1e-4);
  dummy.updateMatrix();
  rain.mesh.setMatrixAt(i, dummy.matrix);
}
scene.add(rain.mesh);

// fireflies — summer evenings
const ffGeo = new THREE.BufferGeometry();
ffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CONFIG.fireflyCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
const ffData = [];
for (let i = 0; i < CONFIG.fireflyCount; i++) {
  const a = rng() * Math.PI * 2, r = rand(2.5, 8.5);
  ffData.push({
    cx: Math.cos(a) * r, cz: Math.sin(a) * r, cy: rand(0.5, 2.4),
    rx: rand(0.4, 1.4), rz: rand(0.4, 1.4), ry: rand(0.15, 0.5),
    fa: rand(0.12, 0.3), fb: rand(0.1, 0.26), fc: rand(0.14, 0.32),
    pa: rng() * 7, pb: rng() * 7, pc: rng() * 7,
  });
}
const ffMat = new THREE.PointsMaterial({
  size: 0.14, map: softDot, transparent: true, depthWrite: false, opacity: 0,
  color: 0xffe9a0, blending: THREE.AdditiveBlending, sizeAttenuation: true,
});
const fireflies = new THREE.Points(ffGeo, ffMat);
fireflies.frustumCulled = false;
fireflies.renderOrder = 2;
scene.add(fireflies);

// dust motes drifting in the light, all year
const moteGeo = new THREE.BufferGeometry();
moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CONFIG.moteCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
const moteData = [];
for (let i = 0; i < CONFIG.moteCount; i++) {
  const a = rng() * Math.PI * 2, r = rand(1.5, 9);
  moteData.push({
    cx: Math.cos(a) * r, cz: Math.sin(a) * r, cy: rand(0.4, 3.2),
    rx: rand(0.3, 1.0), rz: rand(0.3, 1.0), ry: rand(0.1, 0.4),
    fa: rand(0.04, 0.11), fb: rand(0.03, 0.1), fc: rand(0.05, 0.12),
    pa: rng() * 7, pb: rng() * 7, pc: rng() * 7,
  });
}
const moteMat = new THREE.PointsMaterial({
  size: 0.05, map: softDot, transparent: true, depthWrite: false, opacity: 0.12,
  color: 0xfff8e8, blending: THREE.AdditiveBlending, sizeAttenuation: true,
});
const motes = new THREE.Points(moteGeo, moteMat);
motes.frustumCulled = false;
motes.renderOrder = 2;
scene.add(motes);

// diamond dust — tiny glints on the winter snowpack
const sparkGeo = new THREE.BufferGeometry();
{
  const arr = new Float32Array(CONFIG.sparkleCount * 3);
  for (let i = 0; i < CONFIG.sparkleCount; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 11.5;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    arr[i * 3] = x; arr[i * 3 + 1] = groundHeight(x, z) + 0.04; arr[i * 3 + 2] = z;
  }
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
}
const sparkMat = new THREE.PointsMaterial({
  size: 0.055, map: softDot, transparent: true, depthWrite: false, opacity: 0,
  color: 0xeaf6ff, blending: THREE.AdditiveBlending, sizeAttenuation: true,
});
const sparkles = new THREE.Points(sparkGeo, sparkMat);
sparkles.frustumCulled = false;
sparkles.renderOrder = 2;
scene.add(sparkles);

// rain puddles — flat water discs in terrain dips; they reflect the sky via the
// env map and catch a specular sun/moon glint, fill while it rains, dry slowly
const puddleMat = new THREE.MeshPhongMaterial({
  color: 0x46596e, specular: 0xffffff, shininess: 260,
  envMap: envTex, combine: THREE.MixOperation, reflectivity: 0.38,
  transparent: true, opacity: 0,
});
shineMats.push([puddleMat, 0.38]);
const puddles = [];
{
  const cands = [];
  for (let i = 0; i < 90; i++) {
    const a = rng() * Math.PI * 2, r = rand(2.2, 10.2);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = groundHeight(x, z);
    let nb = 0;
    for (let k = 0; k < 6; k++) {
      const aa = (k / 6) * Math.PI * 2;
      nb += groundHeight(x + Math.cos(aa) * 0.9, z + Math.sin(aa) * 0.9);
    }
    cands.push({ x, z, score: nb / 6 - h });   // most below its surroundings wins
  }
  cands.sort((p, q) => q.score - p.score);
  for (let i = 0; i < 7; i++) {
    const c = cands[i];
    const m = new THREE.Mesh(new THREE.CircleGeometry(rand(0.6, 1.2), 22), puddleMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(c.x, groundHeight(c.x, c.z) + 0.02, c.z);
    m.receiveShadow = true;
    m.visible = false;
    scene.add(m);
    puddles.push(m);
  }
}
let puddleW = 0;

// rain rings — expanding ripples that live only on rained-on puddles
const rippleTex = canvasTex(64, (g, s) => {
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.shadowColor = 'rgba(255,255,255,0.8)';
  g.shadowBlur = 3;
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 5, 0, Math.PI * 2);
  g.stroke();
}, { wrap: false });
const ripples = [];
{
  const rg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
      map: rippleTex, transparent: true, opacity: 0, depthWrite: false, color: 0xdfeefa,
    }));
    m.visible = false;
    scene.add(m);
    ripples.push({ mesh: m, phase: rng2(), speed: rand2(0.65, 1.05), cyc: -1, baseR: 1 });
  }
}

// the reward: after the petal storm, a pink blanket across the whole grove —
// tileable petal-litter texture, dissolving tuft by tuft as summer takes it
const petalLitterTex = canvasTex(256, (g, s) => {
  g.clearRect(0, 0, s, s);
  for (let i = 0; i < 1100; i++) {
    const x = rng2() * s, y = rng2() * s;
    const a = ALPHA_LEVELS[Math.floor(rng2() * ALPHA_LEVELS.length)];
    const r = rand2(2.5, 6), rot = rng2() * Math.PI;
    const lum = Math.round(rand2(205, 255));
    splat(g, s, x, y, (px, py) => {
      g.save();
      g.translate(px, py);
      g.rotate(rot);
      g.globalAlpha = a;
      g.fillStyle = `rgb(${lum},${Math.round(lum * 0.92)},${Math.round(lum * 0.95)})`;
      g.beginPath();
      g.ellipse(0, 0, r, r * 0.66, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    });
  }
});
const groveCarpetMat = new THREE.MeshToonMaterial({
  map: petalLitterTex, gradientMap: toonRamp, color: 0xf2a7c2,
  transparent: true, opacity: 0, alphaTest: 0.25, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});
groveCarpetMat.emissive = new THREE.Color(0x3d2531);
const groveCarpet = (() => {
  const geo = new THREE.RingGeometry(0.05, 12.4, 48, 12);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, groundHeight(x, z) + 0.028);
    uv.setXY(i, x * 0.34, z * 0.34);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, groveCarpetMat);
  m.visible = false;
  scene.add(m);
  return m;
})();
const groveCarpetW = (t) => windowRamp(t, 3.98, 4.18, 4.5, 4.9);

// wet-ground sheen — the whole ground darkens and turns specular in the rain,
// so the key light (sun or moon) lays a long glossy streak across the mud
const wetMat = new THREE.MeshPhongMaterial({
  color: 0x0c1016, specular: 0xbcd4e8, shininess: 70,
  envMap: envTex, combine: THREE.MixOperation, reflectivity: 0.3,
  transparent: true, opacity: 0, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
shineMats.push([wetMat, 0.3]);
const wetGround = new THREE.Mesh(groundGeo, wetMat);
wetGround.visible = false;
scene.add(wetGround);

// ----------------------------------------------------------------------------
// The Mogu clock — C swaps the katana for a great construct-clock standing in
// its place: the katana itself becomes the minute hand, a tanto marks the
// hours, a red crystal sweeps the seconds, and a rupee-cut ruby spins above —
// one full turn per second. Dark stone, gold fangs, jade inlay.
// ----------------------------------------------------------------------------
const clockGroup = new THREE.Group();
{
  const ivory = toonMat('#f1e8d4');
  const gold = new THREE.MeshPhongMaterial({ color: 0xc9a35a, specular: 0xffe2a0, shininess: 50 });

  const face = new THREE.Mesh(new THREE.CircleGeometry(1.0, 48), ivory);
  clockGroup.add(face);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.085, 12, 56), gold);
  clockGroup.add(rim);
  addOutline(rim, 0.02);
  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.022, 8, 48), gold);
  innerRing.position.z = 0.012;
  clockGroup.add(innerRing);

  // chunky gold ticks; the cardinals are diamond-set Mogu fangs
  const tickGeos = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const big = i % 3 === 0;
    const g = new THREE.BoxGeometry(big ? 0.16 : 0.06, big ? 0.16 : 0.15, 0.05);
    dummy.position.set(Math.sin(a) * (big ? 1.0 : 0.88), Math.cos(a) * (big ? 1.0 : 0.88), 0.03);
    dummy.rotation.set(0, 0, -a + (big ? Math.PI / 4 : 0));
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    g.applyMatrix4(dummy.matrix);
    tickGeos.push(g);
  }
  const ticks = new THREE.Mesh(mergeGeometries(tickGeos), gold);
  clockGroup.add(ticks);
  addOutline(ticks, 0.012);

  // hands pivot at the centre boss
  const mkPivot = (z) => {
    const p = new THREE.Group();
    p.position.z = z;
    clockGroup.add(p);
    return p;
  };
  const hourPivot = mkPivot(0.05);
  const minutePivot = mkPivot(0.08);
  const secPivot = mkPivot(0.12);

  // minute hand: the katana itself, pommel at the pivot, blade tip at the rim
  const kat = sword.clone();
  kat.position.set(0, 1.73 * 0.52, 0);
  kat.rotation.set(0, 0, Math.PI);
  kat.scale.setScalar(0.52);
  minutePivot.add(kat);
  // hour hand: a tanto — shorter, stockier sibling
  const tanto = sword.clone();
  tanto.position.set(0, 1.73 * 0.3, 0);
  tanto.rotation.set(0, 0, Math.PI);
  tanto.scale.set(0.36, 0.3, 0.36);
  hourPivot.add(tanto);
  // second hand: a sliver of red crystal
  const crys = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.5, 0).scale(0.05, 0.95, 0.05).translate(0, 0.42, 0),
    new THREE.MeshPhongMaterial({ color: 0xd2304a, emissive: 0x5a0c18, specular: 0xffaabb, shininess: 90 }),
  );
  secPivot.add(crys);
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 8).rotateX(Math.PI / 2), gold);
  boss.position.z = 0.14;
  clockGroup.add(boss);

  // the ruby — rupee-cut (hex prism with pyramidal ends), deep translucent red:
  // flat-shaded facets, and the back faces show through for the internal-cut look
  const ruby = new THREE.Mesh(
    mergeGeometries([
      new THREE.CylinderGeometry(0.16, 0.16, 0.2, 6),
      new THREE.ConeGeometry(0.16, 0.22, 6).translate(0, 0.21, 0),
      new THREE.ConeGeometry(0.16, 0.22, 6).rotateX(Math.PI).translate(0, -0.21, 0),
    ]),
    new THREE.MeshPhongMaterial({
      color: 0x6e0512, emissive: 0x52060f, specular: 0x551418, shininess: 60,
      transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
      flatShading: true,
    }),
  );
  ruby.position.y = 1.55;
  clockGroup.add(ruby);

  clockGroup.userData = { hourPivot, minutePivot, secPivot, ruby };
  clockGroup.position.set(0, GH0 + 1.75, 0);
  clockGroup.visible = false;
  scene.add(clockGroup);
}

// ----------------------------------------------------------------------------
// Migrating birds — a far V of flapping silhouettes; south in autumn, back
// north in spring, the odd summer wanderer, almost none in winter
// ----------------------------------------------------------------------------
const birdMat = new THREE.MeshBasicMaterial({
  color: 0x1d2128, side: THREE.DoubleSide, transparent: true, opacity: 0,
});
const flock = new THREE.Group();
const birds = [];
{
  const wingGeoL = new THREE.PlaneGeometry(0.78, 0.22).rotateX(-Math.PI / 2).translate(-0.39, 0, 0);
  const wingGeoR = new THREE.PlaneGeometry(0.78, 0.22).rotateX(-Math.PI / 2).translate(0.39, 0, 0);
  for (let i = 0; i < 9; i++) {
    const b = new THREE.Group();
    const wL = new THREE.Mesh(wingGeoL, birdMat);
    const wR = new THREE.Mesh(wingGeoR, birdMat);
    b.add(wL, wR);
    const row = Math.ceil(i / 2), side = i % 2 ? 1 : -1;
    // the leader flies at the V's apex; the arms trail BEHIND it
    b.position.set(i === 0 ? 0 : side * row * 0.9, rand(-0.2, 0.2), -(i === 0 ? 0 : row) * 1.1);
    flock.add(b);
    birds.push({ wL, wR, ph: rng() * 7 });
  }
}
flock.visible = false;
scene.add(flock);

// ----------------------------------------------------------------------------
// Lights
// ----------------------------------------------------------------------------
const keyLight = new THREE.DirectionalLight(0xfff2d8, 3.2);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = keyLight.shadow.camera.bottom = -10;
keyLight.shadow.camera.right = keyLight.shadow.camera.top = 10;
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 45;
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 0.035;
keyLight.target.position.set(0, 0.8, 0);
scene.add(keyLight, keyLight.target);

const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x7fae6e, 0.85);
scene.add(hemi);

// ----------------------------------------------------------------------------
// UI / input
// ----------------------------------------------------------------------------
const seasonEl = document.getElementById('season');
const kanjiEl = seasonEl.querySelector('.k');
const romajiEl = seasonEl.querySelector('.r');
const hintEl = document.getElementById('hint');
const fadeEl = document.getElementById('fade');
const speedEl = document.getElementById('speed');
let speedTimer = 0;
function showNote(text) {
  speedEl.textContent = text;
  speedEl.style.opacity = '1';
  clearTimeout(speedTimer);
  speedTimer = setTimeout(() => { speedEl.style.opacity = '0'; }, 2600);
}
function adjustSpeed(d) {
  timeSpeed = THREE.MathUtils.clamp(timeSpeed + d, -100, 100);
  showNote(`time ${timeSpeed > 0 ? '+' : ''}${timeSpeed}`);
}

let pitchOffset = 0;
let holdT = -10;            // post-drag hold before the orbit resumes
let zoomOffset = 0;         // mouse-wheel dolly, persistent
let dragging = false, lastPX = 0, lastPY = 0, downX = 0, downY = 0;
let paused = false;
let clockMode = false;
let clockBlend = 0;          // eases the clock in/out and pulls the camera close
let seasonSkipTarget = -1;
let lastSeasonIdx = -1;
let lastOpacityStr = '';
let idleTimer = 0;
let cursorHidden = false;
const gustVec = new THREE.Vector3();   // tap gusts ramp in instead of slamming

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastPX = downX = e.clientX;
  lastPY = downY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
});
let lastMoveT = 0;
window.addEventListener('pointermove', (e) => {
  idleTimer = 0;
  if (cursorHidden) { document.body.style.cursor = ''; cursorHidden = false; }
  if (!dragging) return;
  const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
  lastPX = e.clientX; lastPY = e.clientY;
  camAzimuth -= dx * 0.0035;
  lastMoveT = performance.now();
  pitchOffset = THREE.MathUtils.clamp(pitchOffset + dy * 0.003, -1.0, 2.2);
});
window.addEventListener('pointerup', (e) => {
  if (dragging && Math.abs(e.clientX - downX) < 4 && Math.abs(e.clientY - downY) < 4) {
    // a tap (not a drag) stirs the air — a gust that builds, gently
    const dir = (e.clientX / window.innerWidth) < 0.5 ? 1 : -1;
    gustVec.x += Math.cos(camAzimuth + Math.PI / 2) * dir * 1.6;
    gustVec.z += Math.sin(camAzimuth + Math.PI / 2) * dir * 1.6;
  } else if (dragging) {
    holdT = 3;        // linger exactly where the user left the camera, then resume
  }
  dragging = false;
});
window.addEventListener('wheel', (e) => {
  zoomOffset = THREE.MathUtils.clamp(zoomOffset + e.deltaY * 0.0066, -5.4, 9.5);
}, { passive: true });
window.addEventListener('pointercancel', () => { dragging = false; });
window.addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '4') seasonSkipTarget = (Number(e.key) - 1 + 0.5);
  if (e.key === ' ') {
    paused = !paused;
    showNote(paused ? 'paused' : 'resumed');
    e.preventDefault();
  }
  if (e.key === 'c' || e.key === 'C') {
    clockMode = !clockMode;
    showNote(clockMode ? 'clock — real time, fair skies' : 'clock off');
  }
  if (e.key === '+' || e.key === '=') adjustSpeed(10);
  if (e.key === '-' || e.key === '_') adjustSpeed(-10);
  if (e.key === 'r' || e.key === 'R') {
    resMode = (resMode + 1) % RES_MODES.length;
    applyResolution();
    const m = RES_MODES[resMode];
    showNote(m.h ? `${m.name} ${canvas.width}×${canvas.height}` : 'Native');
  }
});
setTimeout(() => { hintEl.style.opacity = '0'; }, 9000);

// ----------------------------------------------------------------------------
// Animation
// ----------------------------------------------------------------------------
let lastNow = performance.now();
let simT = rand(0, 10);
let sessionT = 0;                                  // real seconds since load
let seasonClock = 0.77 * CONFIG.seasonSeconds;     // mid-summer, sun freshly risen
let camAzimuth = (rand(0, 10) / CONFIG.orbitSeconds) * Math.PI * 2;

const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const tmpVec = new THREE.Vector3();
const sunVec = new THREE.Vector3();
const moonVec = new THREE.Vector3();
const beamDir = new THREE.Vector3();
const DOWN_V = new THREE.Vector3(0, -1, 0);
const lookTarget = new THREE.Vector3(0, GH0 + CONFIG.lookAtHeight, 0);

window.__setSeason = (t) => { seasonClock = t * CONFIG.seasonSeconds; seasonSkipTarget = -1; };
window.__force = {};   // { day: 0..1, precip: 0..1, ff: 0..1 } — testing overrides
window.__dbg = { trees, petals, leaves, flock, prints, printsMat, get simT() { return simT; }, get seasonT() { return (seasonClock / CONFIG.seasonSeconds) % 4; } };

function animate() {
  const now = performance.now();
  const dt = Math.min((now - lastNow) / 1000, 0.05);
  lastNow = now;
  const sdt = paused ? 0 : dt;     // simulation time stops when paused

  // self-heal if a resize event was missed while the tab was hidden
  if (window.innerWidth !== lastWinW || window.innerHeight !== lastWinH) applyResolution();
  simT += sdt;
  sessionT += dt;
  seasonClock += sdt * (DAY_SECONDS / dayLengthSeconds(timeSpeed));


  idleTimer += dt;
  if (idleTimer > 3 && !cursorHidden && !dragging) { document.body.style.cursor = 'none'; cursorHidden = true; }

  let seasonT = (seasonClock / CONFIG.seasonSeconds) % 4;
  if (seasonSkipTarget >= 0) {
    const diff = (seasonSkipTarget - seasonT + 4) % 4;
    if (diff < 0.05) seasonSkipTarget = -1;
    else seasonClock += Math.min(diff, dt * 14) * CONFIG.seasonSeconds;
    seasonT = (seasonClock / CONFIG.seasonSeconds) % 4;
  }
  // clock mode: the scene's date locks to the real calendar
  const clockNow = clockMode ? new Date() : null;
  if (clockNow) {
    const doy = (clockNow - new Date(clockNow.getFullYear(), 0, 0)) / 86400000;
    seasonT = (((doy - 152 + 365) % 365) / 365) * 4;   // summer starts June 1
  }
  computeWeights(seasonT);
  const [wSummer, wFall, wWinter, wSpring] = weights;
  const gcW = groveCarpetW(seasonT);   // the sacred-pink day
  // fallen petals brown before summer takes them
  let bTT = seasonT;
  if (bTT < 1.2) bTT += 4;
  const browning = sm01((bTT - 4.35) / 0.45);

  // --- day/night: four sun cycles per season, a full moon opposite the sun --
  let dayPhase = (seasonClock / DAY_SECONDS) % 1;     // 0 sunrise · .25 noon · .5 sunset · .75 midnight
  if (clockNow) {
    const hours = clockNow.getHours() + clockNow.getMinutes() / 60 + clockNow.getSeconds() / 3600;
    dayPhase = ((hours - 6) / 24 + 1) % 1;            // 6:00 sunrise, 18:00 sunset
  }
  if (window.__force.day != null) dayPhase = window.__force.day;
  const sunTheta = dayPhase * Math.PI * 2;
  const sunEl = Math.sin(sunTheta);
  const dayW = sm01((sunEl + 0.12) / 0.3);
  const nightW = 1 - dayW;
  const duskW = 1 - THREE.MathUtils.smoothstep(Math.abs(sunEl), 0.04, 0.32);
  sunVec.set(Math.cos(sunTheta) * 12, sunEl * 9, 5);
  moonVec.set(-Math.cos(sunTheta) * 11, -sunEl * 8.5, -6);

  // --- weather episodes (deterministic, ~30 s segments) ----------------------
  const seg = Math.floor(simT / 30);
  const segT = simT - seg * 30;
  const segBlend = sm01(segT / 6);
  let precipW = THREE.MathUtils.lerp(hash01(seg - 1) < 0.42 ? 1 : 0, hash01(seg) < 0.42 ? 1 : 0, segBlend);
  precipW *= 1 - windowRamp(seasonT, 1.2, 1.24, 1.51, 1.55);   // the incense day stays clear
  precipW *= 1 - windowRamp(seasonT, 3.82, 3.88, 4.17, 4.25);  // and so does the petal storm
  precipW *= sm01((sessionT - 22) / 10);                        // open on clear skies
  if (clockMode) precipW = 0;                                   // fair skies for the clock
  if (window.__force.precip != null) precipW = window.__force.precip;
  const rainW = precipW * (1 - wWinter);
  const snowW = precipW * wWinter;

  // lightning — brief double-pulse flashes inside rainy spells
  let flashW = 0;
  if (rainW > 0.4) {
    const fw = Math.floor(simT / 3.5);
    if (hash01(fw * 17.3 + 5.1) < 0.22) {
      const ft = simT - fw * 3.5;
      flashW = (Math.max(0, 1 - ft * 7) + 0.65 * Math.max(0, 1 - Math.abs(ft - 0.28) * 14)) * rainW;
    }
  }
  if (window.__force.flash != null) flashW = window.__force.flash;
  let ffEpisode = THREE.MathUtils.lerp(hash01((seg - 1) * 7.31 + 101.7) < 0.55 ? 1 : 0, hash01(seg * 7.31 + 101.7) < 0.55 ? 1 : 0, segBlend);
  if (window.__force.ff != null) ffEpisode = window.__force.ff;
  breezeX = 0.32 * Math.sin(simT * 0.10) + 0.18 * Math.sin(simT * 0.037 + 2.0);
  breezeZ = 0.28 * Math.sin(simT * 0.083 + 1.2);
  const windMag = wind.length();

  // --- environment palette ----------------------------------------------------
  groundMat.color.copy(blendColor(tmpColor, 'ground'));
  tmpColor2.copy(SACRED_PINK).lerp(CARPET_BROWN, browning);
  groundMat.color.lerp(tmpColor2, gcW * 0.55);          // the grove itself blushes
  groundMat.color.multiplyScalar(1 - 0.24 * puddleW);   // soaked earth darkens
  trunkMat.color.copy(blendColor(tmpColor, 'trunk'));
  twigMat.color.copy(trunkMat.color);          // twigs frost pale with the winter trunks
  // fine twigs hide as foliage fills in; the bare seasons reveal the skeleton
  const foliageCover = Math.max(leafCoverage(seasonT), blossomCoverage(seasonT));
  twigMat.alphaTest = 0.26 + 0.72 * foliageCover;
  twigDepthMat.alphaTest = twigMat.alphaTest;
  rockMat.color.copy(blendColor(tmpColor, 'rock'));
  blendColor(tmpColor, 'fog');
  scene.fog.color.copy(NIGHT_FOG).lerp(tmpColor, dayW);
  scene.fog.color.lerp(RAIN_CLOUD, precipW * 0.45);

  blendColor(tmpColor, 'skyTop');
  skyMat.uniforms.uTop.value.copy(NIGHT_TOP).lerp(tmpColor, dayW);
  blendColor(tmpColor, 'skyBottom');
  tmpColor.lerp(DUSK_C, duskW * 0.7);
  skyMat.uniforms.uBottom.value.copy(NIGHT_BOTTOM).lerp(tmpColor, Math.max(dayW, duskW * 0.5));
  blendColor(tmpColor, 'cloud');
  tmpColor.lerp(RAIN_CLOUD, precipW * 0.65);
  skyMat.uniforms.uCloudCol.value.copy(NIGHT_CLOUD).lerp(tmpColor, dayW);
  skyMat.uniforms.uSunCol.value.copy(blendColor(tmpColor, 'sun'));
  skyMat.uniforms.uCloudAmt.value = Math.min(1, blendScalar('cloudAmt') + 0.5 * precipW);
  skyMat.uniforms.uOvercast.value = precipW;
  skyMat.uniforms.uStorm.value = precipW;
  skyMat.uniforms.uFlash.value = flashW;
  skyMat.uniforms.uStar.value = nightW * (0.55 + 0.45 * wWinter) * (1 - precipW * 0.85);
  skyMat.uniforms.uDusk.value = duskW;
  skyMat.uniforms.uMoonVis.value = nightW;
  skyMat.uniforms.uSunDir.value.copy(sunVec).normalize();
  skyMat.uniforms.uMoonDir.value.copy(moonVec).normalize();
  skyMat.uniforms.uTime.value = simT;

  blendColor(tmpColor, 'key');
  tmpColor.lerp(DUSK_C, duskW * 0.45);
  keyLight.color.copy(MOON_LIGHT).lerp(tmpColor, dayW);
  keyLight.intensity = blendScalar('keyIntensity') * (0.2 + 0.8 * dayW) * (1 - 0.45 * precipW);
  tmpVec.copy(moonVec).lerp(sunVec, dayW);
  keyLight.position.copy(tmpVec);
  blendColor(tmpColor, 'hemiSky');
  hemi.color.copy(NIGHT_HEMI_SKY).lerp(tmpColor, dayW);
  blendColor(tmpColor, 'hemiGround');
  hemi.groundColor.copy(NIGHT_HEMI_GROUND).lerp(tmpColor, dayW);
  hemi.intensity = blendScalar('hemiIntensity') * (0.38 + 0.62 * dayW) * (1 - 0.22 * precipW)
    + 1.7 * flashW;   // lightning floods the scene for a frame or two

  // --- foliage lifecycle ----------------------------------------------------
  swayTime.value = simT * 1.2;
  const swayAmt = 0.045 + 0.03 * wFall + 0.02 * wSpring + 0.03 * precipW + 0.08 * Math.min(1.5, windMag);
  for (const s of swayStrengths) s.value = swayAmt;
  swayPush.value.set((wind.x + breezeX) * 0.05, (wind.z + breezeZ) * 0.05);

  // god-ray shafts follow whichever light rules the sky — strongest at low angles
  beamDir.copy(keyLight.target.position).sub(keyLight.position).normalize();
  const lowSun = 1 - THREE.MathUtils.smoothstep(Math.abs(sunEl), 0.18, 0.6);
  const beamBase = 0.2 * Math.max(dayW, nightW * 0.5)
    * THREE.MathUtils.smoothstep(keyLight.position.y, 1.5, 4.5)
    * (1 - precipW * 0.8) * (1 + 1.5 * lowSun) * (0.88 + 0.12 * Math.sin(simT * 0.6));

  const carpetSpringW = springCarpet(seasonT);
  const carpetFallW = fallCarpet(seasonT);
  for (const tree of trees) {
    const tt = (seasonT + tree.tOff + 4) % 4;
    const [covB, bUp] = blossomState(tt);
    const covL = leafCoverage(tt);
    tree.covB = covB;
    tree.covL = covL;

    // buds open green, blush pink as they swell, then hold pink at full bloom
    tree.blossomMat.color.copy(BUD_GREEN).lerp(BLOSSOM_PINK[tree.paletteIdx], sm01((bUp - 0.15) / 0.5));

    tree.beamGroup.quaternion.setFromUnitVectors(DOWN_V, beamDir);
    tree.beamMat.color.copy(keyLight.color);
    tree.beamMat.opacity = beamBase * Math.max(covB, covL);

    const aB = 0.02 + (1 - covB) * 1.05;
    tree.blossomMat.alphaTest = aB;
    tree.blossomMesh.customDepthMaterial.alphaTest = aB;
    tree.blossomMesh.visible = covB > 0.01;
    const aL = 0.02 + (1 - covL) * 1.05;
    tree.leafMat.alphaTest = aL;
    tree.leafMesh.customDepthMaterial.alphaTest = aL;
    tree.leafMesh.visible = covL > 0.01;

    // leaf colour: fresh green → per-tree autumn blaze
    tree.leafMat.color.copy(SUMMER_LEAF[tree.paletteIdx])
      .lerp(SEASONS[1].canopy[tree.paletteIdx], leafTurn(tt));

    tree.grp.rotation.z = 0.006 * Math.sin(simT * 0.43 + tree.phase * 1.7);

    // carpets: pink after the petal storm (browning as they decay), russet
    // after leaf-fall, buried in winter
    tmpColor.copy(CARPET_SPRING_C).lerp(CARPET_BROWN, browning).multiplyScalar(carpetSpringW);
    tmpColor2.copy(CARPET_FALL_C).multiplyScalar(carpetFallW);
    tmpColor.add(tmpColor2);
    const wSum = carpetSpringW + carpetFallW;
    if (wSum > 0.01) tmpColor.multiplyScalar(1 / wSum);
    tree.carpetMat.color.copy(tmpColor);
    tree.carpetMat.emissive.copy(tmpColor).multiplyScalar(0.32);
    tree.carpetMat.opacity = Math.min(1, wSum * 1.1);
    const wantMap = carpetFallW > carpetSpringW ? leafCardTex : blossomCardTex;
    if (tree.carpetMat.map !== wantMap) tree.carpetMat.map = wantMap;
  }

  // drifts, snow caps, lantern warmth (lanterns wake at night)
  const driftS = THREE.MathUtils.smoothstep(wWinter, 0.15, 0.85);
  for (const d of drifts) d.scale.set(d.userData.base * driftS + 0.001, d.userData.base * 0.45 * driftS + 0.001, d.userData.base * driftS + 0.001);
  capMat.opacity = driftS;
  for (const cap of snowCaps) cap.visible = driftS > 0.02;
  twigSnowMat.opacity = driftS;

  // the visitor: prints appear one winter morning, fill in under fresh snow,
  // and vanish with the melt
  const printsW = ramp01(seasonT, 2.3, 2.32)
    * (1 - 0.55 * ramp01(seasonT, 2.4, 2.95))
    * driftS;
  printsMat.opacity = 0.72 * printsW;
  prints.visible = printsW > 0.02;
  const lanternW = 0.3 + nightW * (3.4 + 1.5 * wWinter) + 0.8 * precipW * nightW;
  for (const l of lanternLights) l.intensity = lanternW;
  for (const g of lanternGlows) g.opacity = nightW * (0.12 + 0.05 * wWinter) + 0.02 + 0.012 * Math.sin(simT * 2.2);

  // moths spiral the lit fireboxes in jittery orbits
  const mothW = nightW * (1 - wWinter) * (1 - precipW * 0.8);
  mothMat.opacity = 0.85 * mothW;
  const mothsOn = mothW > 0.02;
  for (const mo of moths) {
    mo.grp.visible = mothsOn;
    if (!mothsOn) continue;
    const th = simT * mo.sp + Math.sin(simT * 0.7 + mo.ph) * 1.5 + mo.ph;
    const mr = mo.r * (0.7 + 0.3 * Math.sin(simT * mo.wob + mo.ph * 2));
    mo.grp.position.set(
      mo.center.x + Math.cos(th) * mr,
      mo.center.y + 0.06 + Math.sin(simT * mo.wob * 0.7 + mo.ph) * 0.12,
      mo.center.z + Math.sin(th) * mr,
    );
    mo.grp.rotation.y = -th;
    const fl = Math.sin(simT * mo.flap + mo.ph) * 0.95;
    mo.wl.rotation.y = fl;
    mo.wr.rotation.y = -fl;
  }

  // --- particles --------------------------------------------------------------
  wind.addScaledVector(gustVec, Math.min(1, sdt * 3));   // gusts build over ~half a second
  gustVec.multiplyScalar(Math.exp(-sdt * 3));
  wind.multiplyScalar(Math.exp(-sdt * 0.85));
  petalStormW = petalStorm(seasonT);
  petals.update(sdt, simT, petalStormW + 0.18 * blossomCoverage(seasonT), spawnPetal);
  leaves.update(sdt, simT, leafFall(seasonT) + 0.14 * leafCoverage(seasonT) * leafTurn(seasonT), spawnLeaf);

  // the pink blanket builds with the storm, browns, and dissolves into summer
  groveCarpet.visible = gcW > 0.02;
  groveCarpetMat.opacity = Math.min(1, 1.05 * gcW);
  groveCarpetMat.color.copy(GROVE_PINK).lerp(CARPET_BROWN, browning);
  groveCarpetMat.emissive.copy(groveCarpetMat.color).multiplyScalar(0.25);

  rain.update(sdt, rainW);

  const snowActive = snowW > 0.01;
  snow.visible = snowActive;
  snowMat.opacity = Math.min(1, snowW * 1.5) * 0.9;
  if (snowActive && sdt > 0) {
    const p = snowGeo.getAttribute('position');
    for (let i = 0; i < CONFIG.snowCount; i++) {
      const d = snowData[i];
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      y -= d.speed * sdt;
      x += (Math.sin(simT * 0.8 + d.phase) * d.amp + (wind.x + breezeX) * 0.6) * sdt;
      z += (Math.cos(simT * 0.66 + d.phase) * d.amp + (wind.z + breezeZ) * 0.6) * sdt;
      if (y < groundHeight(x, z) + 0.04) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 12;
        x = Math.cos(a) * r; z = Math.sin(a) * r; y = rand(8, 12);
      }
      p.setXYZ(i, x, y, z);
    }
    p.needsUpdate = true;
  }

  // fireflies: only on some summer nights
  const ffW = wSummer * nightW * ffEpisode * (1 - rainW * 0.8);
  const ffActive = ffW > 0.01;
  fireflies.visible = ffActive;
  ffMat.opacity = ffW * (0.65 + 0.3 * Math.sin(simT * 1.7));
  if (ffActive && sdt > 0) {
    const p = ffGeo.getAttribute('position');
    for (let i = 0; i < CONFIG.fireflyCount; i++) {
      const d = ffData[i];
      p.setXYZ(i,
        d.cx + Math.sin(simT * d.fa * 6 + d.pa) * d.rx,
        d.cy + Math.sin(simT * d.fb * 6 + d.pb) * d.ry,
        d.cz + Math.cos(simT * d.fc * 6 + d.pc) * d.rz,
      );
    }
    p.needsUpdate = true;
  }

  moteMat.opacity = 0.09 + 0.04 * Math.sin(simT * 0.9);
  if (sdt > 0) {
    const p = moteGeo.getAttribute('position');
    for (let i = 0; i < CONFIG.moteCount; i++) {
      const d = moteData[i];
      p.setXYZ(i,
        d.cx + Math.sin(simT * d.fa * 6 + d.pa) * d.rx,
        d.cy + Math.sin(simT * d.fb * 6 + d.pb) * d.ry,
        d.cz + Math.cos(simT * d.fc * 6 + d.pc) * d.rz,
      );
    }
    p.needsUpdate = true;
  }

  sparkles.visible = wWinter > 0.05;
  sparkMat.opacity = wWinter * (0.28 + 0.26 * Math.sin(simT * 2.7)) * (0.4 + 0.6 * Math.max(dayW, nightW * 0.7));

  // mirror reflections follow the daylight (the env map is a daytime sky)
  for (const [m, base] of shineMats) m.reflectivity = base * (0.15 + 0.85 * dayW);

  // the Mogu clock takes the katana's place while C is active
  clockBlend += ((clockMode ? 1 : 0) - clockBlend) * Math.min(1, dt * 2.2);
  sword.visible = clockBlend < 0.6;
  clockGroup.visible = clockBlend > 0.02;
  if (clockGroup.visible) {
    clockGroup.quaternion.copy(camera.quaternion);
    clockGroup.scale.setScalar(0.25 + 0.75 * sm01(clockBlend));
    if (clockNow) {
      const u = clockGroup.userData;
      const ms = clockNow.getMilliseconds() / 1000;
      const sec = clockNow.getSeconds() + ms;
      const min = clockNow.getMinutes() + sec / 60;
      const hr = (clockNow.getHours() % 12) + min / 60;
      u.minutePivot.rotation.z = -(min / 60) * Math.PI * 2;
      u.hourPivot.rotation.z = -(hr / 12) * Math.PI * 2;
      u.secPivot.rotation.z = -(sec / 60) * Math.PI * 2;
      u.ruby.rotation.y = (sec / 60) * Math.PI * 2;   // one stately turn per minute
    }
  }

  // puddles fill while it rains, dry out slowly, and mirror the current sky
  puddleW += (rainW - puddleW) * Math.min(1, sdt / (rainW > puddleW ? 7 : 12));
  const pVis = puddleW > 0.02;
  const pScale = 0.4 + 0.6 * puddleW;      // shorelines recede as they sink away
  for (const p of puddles) {
    p.visible = pVis;
    p.scale.set(pScale, pScale, 1);
  }
  puddleMat.opacity = 0.62 * puddleW;
  puddleMat.color.copy(skyMat.uniforms.uBottom.value).multiplyScalar(0.55);
  wetGround.visible = pVis;
  wetMat.opacity = 0.42 * puddleW;

  // raindrop rings — only while rain is actually falling on the puddles
  const rippleOn = rainW > 0.08 && pVis;
  for (const rp of ripples) {
    const ct = simT * rp.speed + rp.phase;
    const cyc = Math.floor(ct);
    const f = ct - cyc;
    if (cyc !== rp.cyc) {       // each cycle strikes a fresh spot
      rp.cyc = cyc;
      const p = puddles[Math.floor(hash01(cyc * 7.7 + rp.phase * 91) * puddles.length)];
      const a = hash01(cyc * 3.3 + rp.phase * 53) * Math.PI * 2;
      const rr = hash01(cyc * 5.1 + rp.phase * 17) * 0.45;
      rp.baseR = p.geometry.parameters.outerRadius || p.geometry.parameters.radius;
      rp.mesh.position.set(
        p.position.x + Math.cos(a) * rp.baseR * rr * pScale,
        p.position.y + 0.006,
        p.position.z + Math.sin(a) * rp.baseR * rr * pScale,
      );
    }
    rp.mesh.visible = rippleOn;
    if (rippleOn) {
      const rs = (0.15 + f * 0.95) * rp.baseR * pScale;
      rp.mesh.scale.set(rs, 1, rs);
      rp.mesh.material.opacity = (1 - f) * 0.5 * Math.min(1, rainW) * puddleW;
    }
  }

  // migrating birds: one distant flock crossing per lucky weather segment
  const birdP = 0.04 + 0.55 * wSpring + 0.75 * wFall + 0.28 * wSummer;
  let flockOn = hash01(seg * 3.77 + 55.3) < birdP * (1 - precipW * 0.7);
  if (window.__force.birds != null) flockOn = !!window.__force.birds;
  flock.visible = flockOn;
  if (flockOn) {
    const fProg = segT / 30;
    const lat = (hash01(seg * 5.91 + 7.7) - 0.5) * 28;
    let dirSign = wFall >= wSpring ? -1 : 1;                       // south for autumn, north for spring
    if (wSummer > Math.max(wFall, wSpring)) dirSign = hash01(seg * 9.13 + 3.1) < 0.5 ? 1 : -1;
    const fz = THREE.MathUtils.lerp(-52 * dirSign, 52 * dirSign, fProg);
    flock.position.set(lat, 7.2 + 1.5 * Math.sin(fProg * Math.PI) + hash01(seg * 2.3) * 2, fz);
    tmpVec.set(lat, flock.position.y, fz + dirSign * 4);
    flock.lookAt(tmpVec);
    birdMat.opacity = 0.95 * sm01(fProg / 0.12) * (1 - sm01((fProg - 0.88) / 0.12))
      * (0.3 + 0.7 * dayW);
    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      const flap = Math.sin(simT * 7.5 + b.ph) * 0.62;
      b.wL.rotation.z = flap;
      b.wR.rotation.z = -flap;
    }
  }

  // incense: sticks appear on autumn's second day and burn through it
  const burnP = THREE.MathUtils.clamp((seasonT - 1.25) / 0.25, 0, 1);
  const burning = burnP > 0 && burnP < 1;
  stickGroup.visible = burning;
  if (burning) {
    for (const s of sticks) {
      s.stick.scale.y = Math.max(1e-3, 1 - burnP);
      s.ember.position.set(s.stick.position.x, STICK_H * (1 - burnP), s.stick.position.z);
      s.ember.material.opacity = 0.5 + 0.4 * Math.sin(simT * 6.5 + s.ph);
    }
  }
  smokeMat.color.setScalar(0.45 + 0.45 * dayW);
  let anySmoke = false;
  for (let i = 0; i < SMOKE_N; i++) {
    const it = smokeItems[i];
    it.age += sdt;
    if (it.age > it.life) {
      if (burning && sdt > 0) {
        it.age = 0;
        it.pos.set(
          incense.position.x + rand(-0.012, 0.012),
          incense.position.y + 0.125 + STICK_H * (1 - burnP),
          incense.position.z + rand(-0.012, 0.012),
        );
      } else {
        if (it.age < 1e8) {
          it.age = 1e9;
          dummy.position.set(0, -100, 0);
          dummy.quaternion.identity();
          dummy.scale.setScalar(1e-4);
          dummy.updateMatrix();
          smoke.setMatrixAt(i, dummy.matrix);
          anySmoke = true;          // one last upload to park it
        }
        continue;
      }
    }
    anySmoke = true;
    const f = it.age / it.life;
    it.pos.y += it.vy * sdt;
    it.pos.x += ((wind.x + breezeX) * 0.7 + Math.sin(simT * 1.8 + it.phase) * 0.05) * sdt;
    it.pos.z += ((wind.z + breezeZ) * 0.7 + Math.cos(simT * 1.5 + it.phase) * 0.05) * sdt;
    dummy.position.copy(it.pos);
    dummy.quaternion.copy(camera.quaternion);   // billboard
    dummy.scale.setScalar((0.35 + f * 2.2) * Math.pow(Math.sin(f * Math.PI), 0.6) + 1e-4);
    dummy.updateMatrix();
    smoke.setMatrixAt(i, dummy.matrix);
  }
  smoke.visible = burning || anySmoke;
  if (anySmoke) smoke.instanceMatrix.needsUpdate = true;

  // tassel swinging in the breeze and gusts
  const tSegs = sword.userData.tasselSegs;
  const tWind = Math.min(1.5, windMag + Math.abs(breezeX) * 0.7 + Math.abs(breezeZ) * 0.7);
  for (let i = 0; i < tSegs.length; i++) {
    const k = 0.18 + i * 0.1;
    tSegs[i].rotation.z = (i === 0 ? 0.22 : 0.04) + k * (0.45 + tWind) * Math.sin(simT * (1.5 + i * 0.4) + i * 1.3) * 0.55;
    tSegs[i].rotation.x = k * (0.35 + tWind) * Math.sin(simT * (1.18 + i * 0.33) + i * 2.1) * 0.45;
  }

  // anime gleam — a light streak tracing the blade edge every dozen seconds
  let gleamP = ((simT % 12) / 1.4);
  if (window.__force.gleam != null) gleamP = window.__force.gleam;
  const streak = sword.userData.streak;
  const star = sword.userData.glint;
  if (gleamP < 1) {
    const yy = THREE.MathUtils.lerp(1.1, 0.18, gleamP);
    const env = Math.sin(gleamP * Math.PI);
    const bowX = -0.085 * (1 - yy / 1.18) ** 2;
    streak.position.set(bowX + 0.052, yy, 0);
    streak.scale.set(1, 0.7 + 0.9 * env, 1);
    streak.material.opacity = env * (0.5 + 0.45 * dayW);
    star.position.copy(streak.position);
    star.material.opacity = env * 0.8;
  } else {
    streak.material.opacity = 0;
    star.material.opacity = 0;
  }

  // --- camera -----------------------------------------------------------------
  // The orbit is incremental: a drag leaves the camera where it was put, holds
  // a few seconds, then the orbit eases back in FROM that spot — no snap-back.
  if (!dragging) {
    holdT -= dt;
    const resume = sm01(-holdT / 1.5);
    if (!paused) camAzimuth += (Math.PI * 2 / CONFIG.orbitSeconds) * dt * resume;
    if (holdT < -4) pitchOffset *= Math.exp(-dt * 0.05);   // elevation relaxes very slowly
  }
  if (window.__force.az != null) camAzimuth = window.__force.az;
  const cb = sm01(clockBlend);
  let radius = THREE.MathUtils.clamp(CONFIG.orbitRadius + zoomOffset, 3.2, 18.3)
    + 0.5 * Math.sin(simT * (Math.PI * 2) / 73);
  radius = THREE.MathUtils.lerp(radius, 4.75, cb);   // clock mode: inside the tree ring
  const height = Math.max(0.55, CONFIG.orbitHeight + 0.4 * Math.sin(simT * (Math.PI * 2) / 47)
    + pitchOffset * 2.2 + Math.max(0, zoomOffset) * 0.22);   // rise a little as you pull back
  camera.position.set(Math.cos(camAzimuth) * radius, height, Math.sin(camAzimuth) * radius);
  lookTarget.y = GH0 + THREE.MathUtils.lerp(CONFIG.lookAtHeight, 1.85, cb);
  camera.lookAt(lookTarget);   // pointed at the sword — or at the clock that replaces it

  // clock mode puts the camera inside the tree ring — trees near (or behind)
  // the camera ease themselves out of the way so the face is never blocked
  for (const tree of trees) {
    const tdx = tree.grp.position.x - camera.position.x;
    const tdz = tree.grp.position.z - camera.position.z;
    const want = (cb > 0.4 && Math.hypot(tdx, tdz) < 4.2) ? 0.001 : 1;
    tree.hideBlend = THREE.MathUtils.lerp(tree.hideBlend ?? 1, want, Math.min(1, dt * 3.5));
    tree.grp.scale.setScalar(tree.hideBlend);
  }

  // --- season label -------------------------------------------------------------
  let maxW = 0, idx = 0;
  for (let i = 0; i < 4; i++) if (weights[i] > maxW) { maxW = weights[i]; idx = i; }
  if (idx !== lastSeasonIdx && maxW > 0.6) {
    lastSeasonIdx = idx;
    kanjiEl.textContent = SEASONS[idx].kanji;
    romajiEl.textContent = SEASONS[idx].name;
  }
  const opacityStr = (THREE.MathUtils.smoothstep(maxW, 0.62, 0.95) * 0.85).toFixed(2);
  if (opacityStr !== lastOpacityStr) {
    lastOpacityStr = opacityStr;
    seasonEl.style.opacity = opacityStr;
  }

  renderer.render(scene, camera);
}

window.addEventListener('resize', applyResolution);

renderer.setAnimationLoop(animate);
setTimeout(() => { fadeEl.style.opacity = '0'; }, 60);   // timer, not rAF — must fire even in a hidden tab
