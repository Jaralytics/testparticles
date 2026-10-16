/**
 * particle-text.js — "dust that becomes words" hero effect.
 *
 * Tens of thousands of WebGL point sprites float as dust and periodically fly
 * into the shape of a word, hold, scatter back into dust, and get recycled for
 * the next word. The pointer parts the particles like a hand through smoke.
 *
 * Zero dependencies, WebGL1 (works everywhere WebGL works), ES module.
 *
 *   import { createParticleText } from './particle-text.js';
 *   const fx = await createParticleText(document.querySelector('.hero'), {
 *     words: ['Ask.', 'Build.', 'Publish.', 'Trust.'],
 *     fontFamily: '"Inter", system-ui, sans-serif',
 *     textBox: document.querySelector('.verb-slot'),
 *   });
 *   // fx.pause(); fx.play(); fx.setTheme('dark'); fx.setWords([...]); fx.destroy();
 *   // fx.ripple(x, y);  // click wave (also fired by pointerdown on the container)
 *   // fx.shield(inputEl); fx.release();  // dust swarms over an element and leaves again
 *
 * Architecture (why it is cheap):
 *   - CPU only rewrites per-particle "keyframes" (start, target, start time,
 *     duration, mode) a few times per word. Nothing per particle per frame.
 *   - The vertex shader interpolates every particle every frame from uTime:
 *     cubic easing + a perpendicular "swirl" arc + sinusoidal drift +
 *     gaussian pointer repulsion + fake depth (size/alpha from z).
 *   - Pool layout: [word block | spare | permanent dust]. Each new word is
 *     morphed from the particles of the previous one (they loosen, dim and
 *     re-form); surplus dissolves into dust, shortfall is recruited from it.
 */

const VERT = `
precision highp float;
attribute vec3 aStart;
attribute vec3 aTarget;
attribute vec4 aTime;   // x: start time (s, < -500 = idle dust), y: duration, z: mode (0 form, 1 scatter, 2 swarm, 3 morph), w: seed
attribute vec3 aTint;
attribute vec3 aTintFrom;
attribute float aSize;
uniform vec2 uRes;
uniform float uTime, uPR, uDrift, uDustA, uA, uDark;
uniform vec2 uPointer;
uniform float uPush, uPushR;
uniform vec2 uLight;
uniform float uLightR, uLightK;
uniform vec3 uDust;
uniform vec4 uWaves[4]; // click ripples: x, y, start time, strength
uniform vec4 uWave;     // x: speed (px/s), y: ring width (px), w: life (s)
uniform vec3 uFuzz; // x: radius, y: depth, z: wobble (px)
varying vec3 vCol;
varying float vAlpha;
varying float vCore;

float hash(float n) { return fract(sin(n) * 43758.5453); }
float easeInOutCubic(float p) { return p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) * 0.5; }

void main() {
  float seed = aTime.w;
  float scatter = step(0.5, aTime.z) * step(aTime.z, 1.5);
  float morph = step(2.5, aTime.z);
  float swarm = step(1.5, aTime.z) * (1.0 - morph);
  float active = step(-500.0, aTime.x);
  float p = active * clamp((uTime - aTime.x) / aTime.y, 0.0, 1.0);
  float e = easeInOutCubic(p);

  // Idle float. Formed letters are drift-free (mode 0 target), loose dust always drifts,
  // so the end of every phase lands exactly where the next phase starts (no popping).
  vec3 drift = vec3(
    sin(uTime * 0.31 + seed * 40.0) * 16.0,
    cos(uTime * 0.23 + seed * 23.0) * 11.0,
    sin(uTime * 0.19 + seed * 11.0) * 40.0) * uDrift;
  // Swarm particles buzz in place once they reach the shield.
  vec3 buzz = vec3(sin(uTime * 3.1 + seed * 91.0) * 5.0, cos(uTime * 2.6 + seed * 57.0) * 3.0, 0.0) * swarm;
  // Letters are not crisp: each particle sits off its glyph point (most close, a few far,
  // some pushed in depth) and wobbles slowly, so words read as dense dust, not ink.
  float ang = hash(seed * 13.7) * 6.28318;
  float rr = uFuzz.x * (0.45 * hash(seed * 17.3) + 2.4 * pow(hash(seed * 21.9), 4.0));
  vec3 fuzz = vec3(cos(ang) * rr, sin(ang) * rr, (hash(seed * 19.1) - 0.5) * uFuzz.y)
    + vec3(sin(uTime * 0.7 + seed * 31.0), cos(uTime * 0.6 + seed * 29.0), 0.0) * uFuzz.z;
  float onWord = 1.0 - swarm;
  vec3 a = aStart + drift * (1.0 - scatter - morph) + fuzz * (scatter + morph);
  vec3 b = aTarget + drift * scatter + buzz * e + fuzz * onWord * (1.0 - scatter);
  vec3 dir = b - a;
  // Bend the path sideways, strongest mid-flight, so particles arc instead of sliding.
  float swirl = sin(e * 3.14159) * (hash(seed * 7.0) - 0.5) * 0.55;
  vec3 pos = mix(a, b, e) + vec3(-dir.y, dir.x, 0.0) * swirl;
  // Morph: the old word loosens into a soft cloud (some of it pushed deep in z) before it re-forms.
  vec3 loose = vec3(hash(seed * 3.1) - 0.5, hash(seed * 4.7) - 0.5, hash(seed * 8.3) - 0.5) * vec3(240.0, 150.0, 700.0);
  pos += loose * morph * sin(e * 3.14159);
  if (active < 0.5) pos = aStart + drift;

  float lit = active * (scatter > 0.5 ? 1.0 - e : (morph > 0.5 ? 1.0 - 0.9 * sin(e * 3.14159) : e));

  // Pointer parts the matter: formed letters give a little, loose dust gives a lot.
  vec2 dp = pos.xy - uPointer;
  float dd = length(dp) + 0.001;
  float fall = exp(-(dd * dd) / (uPushR * uPushR));
  pos.xy += (dp / dd) * uPush * fall * (1.0 - 0.7 * lit) * (1.0 - swarm) * (0.6 + 0.8 * hash(seed * 5.3));

  // Click ripples: a ring travels outward and shoves particles as it passes.
  float ringSum = 0.0;
  for (int k = 0; k < 4; k++) {
    vec4 w = uWaves[k];
    float age = uTime - w.z;
    if (age > 0.0 && age < uWave.w) {
      vec2 dw = pos.xy - w.xy;
      float dl = length(dw) + 0.001;
      float x = (dl - age * uWave.x) / uWave.y;
      float fade = 1.0 - age / uWave.w;
      float ring = exp(-x * x) * fade * fade;
      pos.xy += (dw / dl) * w.w * ring * (1.0 - 0.5 * lit) * (0.7 + 0.6 * hash(seed * 2.9));
      ringSum += ring;
    }
  }

  float depth = clamp(abs(pos.z) / 420.0, 0.0, 1.0);
  float flight = active * sin(e * 3.14159);
  vec2 clip = pos.xy / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = aSize * (1.0 + depth * 3.2) * (1.0 + flight * 0.9) * (1.0 + 0.7 * min(ringSum, 1.0)) * uPR;

  float key = 1.0 + uLightK * exp(-length(pos.xy - uLight) / uLightR);
  vec3 col = mix(uDust, mix(aTintFrom, aTint, e), lit);
  float alpha = mix(uDustA, 1.0, lit) * (1.0 - depth * 0.85);
  if (uDark > 0.5) col *= key; else alpha *= clamp(0.45 + 0.35 * key, 0.0, 1.0);
  vCol = col;
  vAlpha = alpha * uA * (1.0 + 1.2 * min(ringSum, 1.0));
  vCore = mix(0.08, 0.32, lit);
}`;

const FRAG = `
precision mediump float;
varying vec3 vCol;
varying float vAlpha;
varying float vCore;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = (1.0 - smoothstep(vCore, 0.5, r)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol, a);
}`;

export const THEMES = {
  light: { dust: [0.2, 0.17, 0.14], mark: [0.07, 0.07, 0.08], accent: [0.88, 0.24, 0.07], dustAlpha: 0.4, light: 0.6 },
  dark: { dust: [1, 0.86, 0.74], mark: [1, 0.95, 0.9], accent: [1, 0.27, 0.12], dustAlpha: 0.38, light: 1.1 },
};

const DEFAULTS = {
  words: ['Ask.', 'Build.', 'Publish.', 'Trust.'],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontWeight: 200,
  thicken: 0.012,          // stroke width as a fraction of font size (thin fonts need it)
  textBox: null,           // Element | {x,y,width,height} (px, relative to container) | (W,H) => rect
  count: 0,                // 0 = auto from area
  maxPerWord: 0,           // 0 = auto (~22% of count)
  accentIndex: 2,          // which word uses the accent color; -1 = none
  theme: 'auto',           // 'auto' | 'light' | 'dark'
  colors: {},              // { light: {...}, dark: {...} } partial overrides of THEMES
  timing: { first: 0.3, cycle: 3.2, hold: 4, morph: 1.6, spread: 0.7 },
  cloud: { cx: 0.4, cy: 0.34, sx: 0.3, sy: 0.2, share: 0.75 },
  pointer: { radius: 110, strength: 46 },
  ripple: { speed: 650, width: 48, strength: 75, life: 1.6 }, // click wave; strength 0 = off
  fuzz: { radius: 0.045, depth: 0.9, wobble: 0.012 }, // fractions of the font size; 0 = crisp letters
  shield: { pad: 6, density: 0.45, size: 1.7, share: 0.6 }, // density = particles per px^2, share = max fraction of free dust
  drift: 1,
  subFrames: 2,            // >1 = cheap motion blur (re-renders the frame at slightly earlier times)
  blurSpan: 0.12,          // seconds covered by the motion blur
  reducedMotion: 'auto',   // 'auto' | true | false
  maxDPR: 2,
  onFallback: null,        // called when WebGL is unavailable or the context is lost
};

const rand = Math.random;
function gauss() {
  let u = 0, v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const lerp = (a, b, t) => a + (b - a) * t;

export function supportsWebGL() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Rasterize `text` and return jittered sample points (x right, y down, origin at left baseline). */
function sampleText(text, font, size, thicken, maxPoints) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = font;
  const m = g.measureText(text);
  const asc = m.actualBoundingBoxAscent || size * 0.8;
  const desc = m.actualBoundingBoxDescent || size * 0.2;
  const sw = Math.max(0, size * thicken);
  const pad = Math.ceil(sw + 2);
  c.width = Math.ceil(m.width + pad * 2);
  c.height = Math.ceil(asc + desc + pad * 2);
  g.font = font;
  g.fillStyle = g.strokeStyle = '#000';
  g.lineWidth = sw;
  g.lineJoin = 'round';
  g.fillText(text, pad, pad + asc);
  if (sw > 0) g.strokeText(text, pad, pad + asc);
  const d = g.getImageData(0, 0, c.width, c.height).data;

  let ink = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 60) ink++;
  ink *= 4;
  const step = Math.max(1, Math.sqrt(ink / (maxPoints * 1.15)));

  let pts = [];
  for (let y = 0; y < c.height; y += step) {
    for (let x = 0; x < c.width; x += step) {
      const al = d[(Math.floor(y) * c.width + Math.floor(x)) * 4 + 3];
      if (al > 60 && rand() < al / 255) pts.push(x + rand() * step - pad, y + rand() * step - pad - asc);
    }
  }
  // Shuffle pairs so dust is assigned to letters randomly (otherwise the word forms in scanlines).
  const n = pts.length / 2;
  for (let i = n - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [pts[2 * i], pts[2 * j]] = [pts[2 * j], pts[2 * i]];
    [pts[2 * i + 1], pts[2 * j + 1]] = [pts[2 * j + 1], pts[2 * i + 1]];
  }
  if (n > maxPoints) pts = pts.slice(0, maxPoints * 2);
  return pts;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export async function createParticleText(container, options = {}) {
  const o = {
    ...DEFAULTS,
    ...options,
    timing: { ...DEFAULTS.timing, ...options.timing },
    cloud: { ...DEFAULTS.cloud, ...options.cloud },
    pointer: { ...DEFAULTS.pointer, ...options.pointer },
    shield: { ...DEFAULTS.shield, ...options.shield },
    fuzz: { ...DEFAULTS.fuzz, ...options.fuzz },
    ripple: { ...DEFAULTS.ripple, ...options.ripple },
  };
  const palette = {
    light: { ...THEMES.light, ...o.colors?.light },
    dark: { ...THEMES.dark, ...o.colors?.dark },
  };

  if (!supportsWebGL()) {
    o.onFallback?.('no-webgl');
    return null;
  }

  // Never sample text before the webfont is ready, or the words come out in the fallback font.
  const fontFor = (px) => `${o.fontWeight} ${px}px ${o.fontFamily}`;
  try {
    await document.fonts?.load(fontFor(100), o.words.join(''));
  } catch { /* use whatever is available */ }

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '0' });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.prepend(canvas);

  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) {
    canvas.remove();
    o.onFallback?.('no-webgl');
    return null;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = {};
  for (const name of ['uWaves', 'uWave', 'uFuzz', 'uRes', 'uTime', 'uPR', 'uDrift', 'uDustA', 'uA', 'uDark', 'uPointer', 'uPush', 'uPushR', 'uLight', 'uLightR', 'uLightK', 'uDust']) {
    U[name] = gl.getUniformLocation(prog, name);
  }

  const reduced = o.reducedMotion === 'auto' ? matchMedia('(prefers-reduced-motion: reduce)').matches : !!o.reducedMotion;
  const mqDark = matchMedia('(prefers-color-scheme: dark)');
  let theme = o.theme === 'auto' ? (mqDark.matches ? 'dark' : 'light') : o.theme;

  // ---- state -------------------------------------------------------------
  let W = 0, H = 0, PR = 1, N = 0, M = 0;
  let A = {}; // attribute arrays
  const bufs = {};
  const layout = { aStart: 3, aTarget: 3, aTime: 4, aTint: 3, aTintFrom: 3, aSize: 1 };
  let dirty = true;
  let wordPoints = [];
  let fontPx = 100;
  const waves = new Float32Array(16).fill(-1000);
  let waveIdx = 0;
  let time = 0, startedAt = 0, raf = 0, playing = false, destroyed = false;
  let sched = null;
  const ptr = { x: -9999, y: -9999, tx: -9999, ty: -9999, push: 0, pushT: 0, lx: 0, ly: 0, inside: false };

  function textRect() {
    const tb = o.textBox;
    if (tb instanceof Element) {
      const r = tb.getBoundingClientRect(), c = container.getBoundingClientRect();
      return { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height };
    }
    if (typeof tb === 'function') return tb(W, H);
    if (tb) return tb;
    return { x: W * 0.03, y: H * 0.05, width: W * 0.62, height: Math.min(H * 0.3, W * 0.17) };
  }

  function placeDust(i) {
    const c = o.cloud;
    let x, y;
    if (rand() < c.share) {
      x = (c.cx + gauss() * c.sx) * W;
      y = (c.cy + gauss() * c.sy) * H;
    } else {
      x = (rand() * 1.1 - 0.05) * W;
      y = (rand() * 1.1 - 0.05) * H;
    }
    const z = rand() < 0.18 ? 300 * gauss() : 60 * gauss();
    A.aStart.set([x, y, z], 3 * i);
    A.aTarget.set([x, y, z], 3 * i);
    A.aTime.set([-1000, 1, 0, rand()], 4 * i);
  }

  function buildWords() {
    const box = textRect();
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = fontFor(100);
    const mm = probe.measureText('Hg');
    const asc100 = mm.fontBoundingBoxAscent || mm.actualBoundingBoxAscent || 80;
    const desc100 = mm.fontBoundingBoxDescent || mm.actualBoundingBoxDescent || 20;
    const maxW100 = Math.max(...o.words.map((w) => probe.measureText(w).width), 1);
    const size = Math.max(12, Math.min((box.height / (asc100 + desc100)) * 100, (box.width / maxW100) * 100));
    fontPx = size;
    const baseline = box.y + (asc100 / 100) * size;
    wordPoints = o.words.map((w) => {
      const pts = sampleText(w, fontFor(size), size, o.thicken, M);
      for (let i = 0; i < pts.length; i += 2) {
        pts[i] += box.x;
        pts[i + 1] += baseline;
      }
      return pts;
    });
  }

  function allocate() {
    const r = container.getBoundingClientRect();
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    PR = Math.min(devicePixelRatio || 1, o.maxDPR);
    canvas.width = Math.round(W * PR);
    canvas.height = Math.round(H * PR);
    N = o.count || Math.round(Math.min(110000, Math.max(20000, W * H * 0.07)));
    M = Math.min(o.maxPerWord || Math.round(N * 0.22), Math.floor(N * 0.3));
    A = {};
    for (const [k, n] of Object.entries(layout)) A[k] = new Float32Array(N * n);
    for (let i = 0; i < N; i++) {
      placeDust(i);
      A.aSize[i] = 1 + rand() * 0.9;
    }
    for (const [k, n] of Object.entries(layout)) {
      if (!bufs[k]) bufs[k] = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[k]);
      gl.bufferData(gl.ARRAY_BUFFER, A[k], gl.DYNAMIC_DRAW);
      const loc = gl.getAttribLocation(prog, k);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
    }
    dirty = false;
    buildWords();
    sched = { next: o.timing.first, idx: 0, count: 0, extras: null };
  }

  // ---- keyframe writers (CPU, a few times per word) --------------------------
  // One block [0, M) carries the word. Each new word is morphed from the particles of the
  // previous one; surplus particles dissolve into dust, missing ones are recruited from dust.
  const MORPH_K = 1.3; // morph flights are a bit longer than plain forming

  function tinted(i, tint) {
    const s = 0.85 + 0.3 * rand();
    A.aTint.set([tint[0] * s, tint[1] * s, tint[2] * s], 3 * i);
  }

  function formWord(pts, at, tint) {
    const t = o.timing;
    const n = Math.min(pts.length / 2, M);
    const old = sched.count;
    if (sched.extras) recycle(sched.extras);
    sched.extras = null;
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i], y = pts[2 * i + 1];
      const seed = A.aTime[4 * i + 3];
      if (i < old) {
        const cur = posAt(i, at);
        A.aStart.set(cur, 3 * i);
        A.aTintFrom.set(A.aTint.subarray(3 * i, 3 * i + 3), 3 * i);
        A.aTime.set([at + (cur[0] / W) * t.spread + 0.35 * rand(), t.morph * MORPH_K, 3, seed], 4 * i);
      } else {
        // Recruited dust arrives a little later so it blends with the morphing cloud.
        A.aTintFrom.set(tint, 3 * i);
        A.aTime.set([at + (old ? t.morph * 0.4 : 0) + (x / W) * t.spread + 0.35 * rand(), t.morph, 0, seed], 4 * i);
      }
      A.aTarget.set([x, y, 0], 3 * i);
      tinted(i, tint);
    }
    if (old > n) {
      const sx = 0.18 * W, sy = 0.22 * H;
      for (let i = n; i < old; i++) {
        const cur = posAt(i, at);
        A.aStart.set(cur, 3 * i);
        A.aTarget.set([cur[0] + gauss() * sx, cur[1] + gauss() * sy - 40 * (0.5 + rand()), 260 * gauss()], 3 * i);
        A.aTime.set([at + (cur[0] / W) * t.spread + 0.35 * rand(), t.morph, 1, A.aTime[4 * i + 3]], 4 * i);
      }
      sched.extras = { from: n, to: old, at: at + t.spread + 0.35 + t.morph + 0.3 };
    }
    sched.count = n;
    dirty = true;
  }

  function recycle(g) {
    for (let i = g.from; i < g.to; i++) {
      A.aStart.set(A.aTarget.subarray(3 * i, 3 * i + 3), 3 * i);
      A.aTime[4 * i] = -1000;
      A.aTime[4 * i + 2] = 0;
    }
    dirty = true;
  }

  function step(now) {
    const t = o.timing;
    const pal = palette[theme];
    while (now >= sched.next) {
      const w = sched.idx % wordPoints.length;
      formWord(wordPoints[w], sched.next, w === o.accentIndex ? pal.accent : pal.mark);
      sched.idx++;
      sched.next += t.hold + t.spread + 0.35 + t.morph * MORPH_K;
    }
    if (sched.extras && now >= sched.extras.at) {
      recycle(sched.extras);
      sched.extras = null;
    }
    if (swarm?.recycleAt && now >= swarm.recycleAt) settleSwarm();
  }

  // ---- shield: free dust swarms over an element and buzzes there ------------
  let shieldEl = null;
  let swarm = null; // { ids, home, size, recycleAt }

  // Approximate on-screen position (no drift/swirl) so re-targeting mid-flight barely pops.
  function posAt(i, now) {
    const t0 = A.aTime[4 * i], dur = A.aTime[4 * i + 1];
    const s = A.aStart.subarray(3 * i, 3 * i + 3);
    if (t0 < -500) return [s[0], s[1], s[2]];
    const p = Math.min(1, Math.max(0, (now - t0) / dur));
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    const b = A.aTarget.subarray(3 * i, 3 * i + 3);
    return [lerp(s[0], b[0], e), lerp(s[1], b[1], e), lerp(s[2], b[2], e)];
  }

  function applyShield(now) {
    const sh = o.shield;
    const r = shieldEl.getBoundingClientRect(), c = container.getBoundingClientRect();
    const x0 = r.left - c.left - sh.pad, y0 = r.top - c.top - sh.pad;
    const w = r.width + 2 * sh.pad, h = r.height + 2 * sh.pad;
    if (!swarm) {
      const pool = N - 2 * M;
      const K = Math.max(1, Math.min(Math.floor(pool * sh.share), Math.round(w * h * sh.density)));
      const stride = pool / K;
      const ids = new Int32Array(K), home = new Float32Array(K * 3), size = new Float32Array(K);
      for (let k = 0; k < K; k++) {
        const i = 2 * M + Math.floor((k + rand()) * stride);
        ids[k] = i;
        home.set(A.aStart.subarray(3 * i, 3 * i + 3), 3 * k);
        size[k] = A.aSize[i];
        A.aSize[i] *= sh.size;
      }
      swarm = { ids, home, size, recycleAt: 0 };
    }
    swarm.recycleAt = 0;
    const tint = palette[theme].mark;
    const dur = o.timing.morph * 0.7;
    for (const i of swarm.ids) {
      A.aStart.set(posAt(i, now), 3 * i);
      const tx = x0 + rand() * w;
      A.aTarget.set([tx, y0 + rand() * h, 0], 3 * i);
      A.aTime.set([now + ((tx - x0) / w) * 0.25 + 0.25 * rand(), dur, 2, A.aTime[4 * i + 3]], 4 * i);
      A.aTintFrom.set(tint, 3 * i);
      tinted(i, tint);
    }
    canvas.style.zIndex = '2'; // above the form while the swarm is out
    dirty = true;
  }

  function releaseShield(now) {
    if (!swarm || swarm.recycleAt) return;
    swarm.ids.forEach((i, k) => {
      A.aStart.set(posAt(i, now), 3 * i);
      A.aTarget.set(swarm.home.subarray(3 * k, 3 * k + 3), 3 * i);
      A.aTime.set([now + 0.4 * rand(), o.timing.morph, 1, A.aTime[4 * i + 3]], 4 * i);
    });
    swarm.recycleAt = now + o.timing.morph + 0.5;
    dirty = true;
  }

  function settleSwarm() {
    swarm.ids.forEach((i, k) => {
      A.aStart.set(swarm.home.subarray(3 * k, 3 * k + 3), 3 * i);
      A.aTime[4 * i] = -1000;
      A.aTime[4 * i + 2] = 0;
      A.aSize[i] = swarm.size[k];
    });
    swarm = null;
    canvas.style.zIndex = '0';
    dirty = true;
  }

  // ---- render ----------------------------------------------------------------
  function upload() {
    for (const [k] of Object.entries(layout)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[k]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, A[k]);
    }
    dirty = false;
  }

  function render(subFrames = o.subFrames, span = o.blurSpan) {
    const pal = palette[theme];
    const dark = theme === 'dark';
    if (dirty) upload();
    // Smooth pointer, push and the "key light" that follows it.
    if (ptr.x === -9999 && ptr.tx !== -9999) { ptr.x = ptr.tx; ptr.y = ptr.ty; }
    ptr.x = lerp(ptr.x, ptr.tx, 0.25);
    ptr.y = lerp(ptr.y, ptr.ty, 0.25);
    ptr.push = lerp(ptr.push, ptr.inside ? o.pointer.strength : 0, 0.08);
    const lbx = o.cloud.cx * W, lby = o.cloud.cy * H;
    const ltx = ptr.inside ? 0.55 * ptr.x + 0.45 * lbx : lbx;
    const lty = ptr.inside ? 0.4 * Math.min(ptr.y, 0.5 * H) + 0.6 * lby : lby;
    ptr.lx = ptr.lx ? lerp(ptr.lx, ltx, 0.05) : ltx;
    ptr.ly = ptr.ly ? lerp(ptr.ly, lty, 0.05) : lty;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    if (dark) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform2f(U.uRes, W, H);
    gl.uniform1f(U.uPR, PR);
    gl.uniform1f(U.uDrift, o.drift);
    gl.uniform1f(U.uDustA, pal.dustAlpha);
    gl.uniform1f(U.uDark, dark ? 1 : 0);
    gl.uniform2f(U.uPointer, ptr.x, ptr.y);
    gl.uniform1f(U.uPush, ptr.push);
    gl.uniform1f(U.uPushR, o.pointer.radius);
    gl.uniform2f(U.uLight, ptr.lx, ptr.ly);
    gl.uniform1f(U.uLightR, 0.42 * Math.max(W, H));
    gl.uniform1f(U.uLightK, pal.light);
    gl.uniform3fv(U.uDust, pal.dust);
    gl.uniform4fv(U.uWaves, waves);
    gl.uniform4f(U.uWave, o.ripple.speed, o.ripple.width, 0, o.ripple.life);
    gl.uniform3f(U.uFuzz, o.fuzz.radius * fontPx, o.fuzz.depth * fontPx, o.fuzz.wobble * fontPx);
    gl.uniform1f(U.uA, Math.min(1, (dark ? 1 : 1.6) / subFrames));
    for (let s = 0; s < subFrames; s++) {
      gl.uniform1f(U.uTime, time - (s / subFrames) * span);
      gl.drawArrays(gl.POINTS, 0, N);
    }
  }

  function frame(ts) {
    time = (ts - startedAt) / 1000;
    step(time);
    render();
    raf = requestAnimationFrame(frame);
  }

  function renderStill() {
    const t = o.timing;
    time = t.first + t.spread + 0.35 + t.morph + 0.2; // first word fully formed
    step(time);
    render(12, 0.22);
  }

  // ---- lifecycle -------------------------------------------------------------
  function play() {
    if (destroyed || reduced || playing) return;
    playing = true;
    startedAt = performance.now() - time * 1000;
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
  }

  let userPaused = false;
  let visible = true;
  const sync = () => (visible && !document.hidden && !userPaused ? play() : pause());

  const onMove = (e) => {
    const r = container.getBoundingClientRect();
    ptr.tx = e.clientX - r.left;
    ptr.ty = e.clientY - r.top;
    ptr.inside = true;
  };
  const onLeave = () => { ptr.inside = false; };
  function ripple(x, y) {
    if (reduced || !o.ripple.strength) return;
    waves.set([x, y, time, o.ripple.strength], 4 * (waveIdx++ % 4));
  }
  const onDown = (e) => {
    const r = container.getBoundingClientRect();
    ripple(e.clientX - r.left, e.clientY - r.top);
  };
  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerleave', onLeave);

  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; sync(); });
  io.observe(container);
  document.addEventListener('visibilitychange', sync);

  let rzTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      const r = container.getBoundingClientRect();
      if (Math.abs(r.width - W) < 2 && Math.abs(r.height - H) < 2) return;
      restart();
    }, 150);
  });
  ro.observe(container);

  const onScheme = () => {
    if (o.theme === 'auto') setTheme(mqDark.matches ? 'dark' : 'light', true);
  };
  mqDark.addEventListener('change', onScheme);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    pause();
    o.onFallback?.('context-lost');
  });

  function restart() {
    const was = playing;
    pause();
    time = 0;
    waves.fill(-1000);
    allocate();
    swarm = null;
    canvas.style.zIndex = '0';
    if (shieldEl) applyShield(0);
    if (reduced) renderStill();
    else if (was || !userPaused) sync();
  }

  function setTheme(next, fromSystem = false) {
    if (!fromSystem) o.theme = next;
    theme = next;
    // Already-formed words keep their old tint until recycled; restart for a clean switch.
    restart();
  }

  allocate();
  if (reduced) renderStill();
  else sync();

  return {
    canvas,
    get playing() { return playing; },
    get reducedMotion() { return reduced; },
    play() { userPaused = false; sync(); },
    pause() { userPaused = true; pause(); },
    setTheme,
    setWords(words) { o.words = words; restart(); },
    ripple,
    shield(el) {
      if (destroyed) return;
      shieldEl = el;
      applyShield(reduced ? time - 5 : time);
      if (reduced) render(12, 0.22);
    },
    release() {
      if (destroyed || !shieldEl) return;
      shieldEl = null;
      if (reduced) { if (swarm) settleSwarm(); render(12, 0.22); return; }
      releaseShield(time);
    },
    destroy() {
      destroyed = true;
      pause();
      io.disconnect();
      ro.disconnect();
      clearTimeout(rzTimer);
      document.removeEventListener('visibilitychange', sync);
      mqDark.removeEventListener('change', onScheme);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
      container.removeEventListener('pointerdown', onDown);
      for (const b of Object.values(bufs)) gl.deleteBuffer(b);
      gl.deleteProgram(prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
  };
}
