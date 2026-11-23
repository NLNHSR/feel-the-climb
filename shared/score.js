// Procedural score: all music and sound effects are synthesized live with Web Audio (no samples, no licensing).
// One knob drives the drama: setIntensity(0…1). Arrangement layers enter at thresholds and the tempo rises.
//
// Two layers of sound:
//   • A per-variant synth engine, chosen by the theme's `synth` key (see audio-themes.js and ENGINES below).
//     Each engine has its own key, progression, instruments, reverb and SFX recipes.
//   • The original generic "trailer build-up" score, used when a theme names no (known) engine.
// A theme may also supply sampled `music` / `sfx[event]` URLs; those always win over the synth versions.
//
// One-shots: riser(seconds), impact(strength), stinger(), whoosh(up), tick(pitch) follow the active engine.
// Voice: narrate(text) plays a pre-recorded clip registered with setVoiceClips() and ducks the music.

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const R = Math.random;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0 below a, 1 above b, linear between: how far a layer has faded in. */
const ramp = (a, b, x) => clamp01((x - a) / (b - a));

// D minor epic loop: Dm – B♭ – F – C   (i – VI – III – VII)   (generic score)
const CHORDS = [
  { bass: 38, pad: [50, 53, 57, 62] },
  { bass: 34, pad: [46, 50, 53, 58] },
  { bass: 41, pad: [53, 57, 60, 65] },
  { bass: 36, pad: [48, 52, 55, 60] },
];
const OSTINATO = [0, 2, 1, 2, 0, 2, 1, 3]; // indexes into chord pad tones

// ═════════════════════ Offline DSP: instrument + texture buffers rendered once in JS ═════════════════════
// Tonal buffers are rendered at 32 kHz (plenty for mallets/plucks) and cached per note, so each note at
// play time is one AudioBufferSourceNode + one GainNode.
const TSR = 32000;
const decayScale = (f) => Math.min(1.8, Math.max(0.35, Math.pow(440 / f, 0.45)));

function finish(d, sr, { peak = 0.9, fadeIn = 0.0015, fadeOut = 0.012 } = {}) {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  const k = m > 0 ? peak / m : 0, fi = Math.max(1, Math.floor(sr * fadeIn)), fo = Math.max(1, Math.floor(sr * fadeOut));
  for (let i = 0; i < d.length; i++) {
    let g = k;
    if (i < fi) g *= i / fi;
    const j = d.length - 1 - i;
    if (j < fo) g *= j / fo;
    d[i] = Number.isFinite(d[i]) ? d[i] * g : 0;
  }
  return d;
}
/** Sum of exponentially damped sinusoids (a modal instrument). partials: [ratio, amp, t60 seconds]. */
function modal(f, dur, partials, { click = 0, ctone = 0.3, cdur = 0.004, spread = 0, sr = TSR } = {}) {
  const n = Math.ceil(sr * dur), d = new Float32Array(n);
  for (const [ratio, amp, t60] of partials) {
    const fr = f * ratio * (1 + spread * (R() * 2 - 1));
    if (fr >= sr * 0.45 || amp <= 0) continue;
    const w = (2 * Math.PI * fr) / sr, r = Math.exp(Math.log(0.001) / (t60 * sr)), c = 2 * r * Math.cos(w), r2 = r * r;
    const len = Math.min(n, Math.ceil(t60 * sr * 1.15));
    let y2 = 0, y1 = amp * r * Math.sin(w);
    if (n > 1) d[1] += y1;
    for (let i = 2; i < len; i++) { const y = c * y1 - r2 * y2; d[i] += y; y2 = y1; y1 = y; }
  }
  if (click) {
    const cn = Math.floor(sr * cdur);
    let s = 0;
    for (let i = 0; i < cn && i < n; i++) { s += ctone * (R() * 2 - 1 - s); d[i] += click * s * (1 - i / cn) * (1 - i / cn); }
  }
  return { data: finish(d, sr), sr, rate: 1 };
}
/** Karplus-Strong plucked string. Tuned exactly via playbackRate (the loop delay is an integer). */
function karplus(f, dur, { t60 = 2, bright = 0.5, pick = 0.2, lp = 0.2, sr = TSR } = {}) {
  const gd = lp / (1 - lp);
  const P = Math.max(4, Math.floor(sr / f - 0.5 - gd)), L = P + 1;
  const rate = (f * (P + 0.5 + gd)) / sr;
  const n = Math.ceil(sr * dur), d = new Float32Array(n), ring = new Float32Array(L);
  const exc = new Float32Array(P), a = 0.08 + 0.9 * bright;
  let s = 0, mean = 0;
  for (let i = 0; i < P; i++) { s += a * (R() * 2 - 1 - s); exc[i] = s; mean += s; }
  mean /= P;
  const pk = Math.max(1, Math.round(pick * P)), ex = new Float32Array(P);
  for (let i = 0; i < P; i++) ex[i] = exc[i] - mean - (i >= pk ? exc[i - pk] - mean : 0) * 0.9;
  const loss = Math.pow(0.001, 1 / (t60 * f));
  let w = 0, lps = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    let fb = 0.5 * (ring[(w + 1) % L] + ring[w]);
    if (lp) { lps += (1 - lp) * (fb - lps); fb = lps; }
    const y = (i < P ? ex[i] : 0) + loss * fb;
    ring[w] = y; w = (w + 1) % L;
    const o = y - dx + 0.995 * dy; dx = y; dy = o; d[i] = o;
  }
  return { data: finish(d, sr, { fadeIn: 0.0006 }), sr, rate };
}
/** RBJ biquad as a stateful sample processor (for rendering textures). */
function bq(type, f, q, sr = TSR) {
  const w = (2 * Math.PI * f) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = (-2 * cs) / a0, A2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
/** Add a sine chirp (exponential glide f0 → f1, exponential decay) into d at sample `at`. */
function chirp(d, sr, at, f0, f1, glide, amp, tau) {
  let ph = 0;
  const n = Math.min(d.length - at, Math.floor(tau * 7 * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = f1 + (f0 - f1) * Math.exp(-t / glide);
    ph += (2 * Math.PI * f) / sr;
    d[at + i] += amp * Math.sin(ph) * Math.exp(-t / tau) * Math.min(1, i / (sr * 0.0012));
  }
}
function creakTex(dur, r0, r1, f, sr = TSR) {
  const n = Math.floor(sr * dur), d = new Float32Array(n);
  const res = [bq('bp', f, 9, sr), bq('bp', f * 2.37, 7, sr), bq('bp', f * 4.9, 5, sr)], k = [1, 0.55, 0.25];
  let next = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    let x = 0;
    if (i >= next) {
      x = (0.5 + R() * 0.5) * Math.sin(Math.PI * Math.min(1, u * 1.25));
      next = i + Math.floor((sr / (r0 + (r1 - r0) * u)) * (0.7 + R() * 0.6));
    }
    d[i] = k[0] * res[0](x) + k[1] * res[1](x) + k[2] * res[2](x);
  }
  return { data: finish(d, sr), sr, rate: 1 };
}
const TONAL = {
  marimba: (f) => { const s = decayScale(f); return modal(f, 1.5, [[1, 1, 1.0 * s], [3.93, 0.16, 0.2 * s], [9.2, 0.04, 0.06 * s]], { click: 0.3, ctone: 0.18 }); },
  kalimba: (f) => { const s = decayScale(f); return modal(f, 2.2, [[1, 1, 1.8 * s], [1.004, 0.3, 1.5 * s], [5.65, 0.14, 0.2 * s], [11.9, 0.04, 0.06 * s]], { click: 0.25, ctone: 0.4 }); },
  celesta: (f) => { const s = decayScale(f); return modal(f, 2.4, [[1, 1, 1.7 * s], [2, 0.16, 0.6 * s], [3.01, 0.12, 0.35 * s], [4.07, 0.07, 0.22 * s], [6.3, 0.03, 0.1 * s]], { click: 0.12, ctone: 0.3 }); },
  musicbox: (f) => { const s = decayScale(f); return modal(f, 2.0, [[1, 1, 1.4 * s], [1.005, 0.4, 1.2 * s], [3, 0.22, 0.45 * s], [5.9, 0.1, 0.16 * s], [9.1, 0.04, 0.06 * s]], { click: 0.3, ctone: 0.6, cdur: 0.002 }); },
  glock: (f) => { const s = decayScale(f); return modal(f, 2.0, [[1, 1, 1.6 * s], [2.76, 0.2, 0.5 * s], [5.4, 0.08, 0.18 * s]], { click: 0.15, ctone: 0.7, cdur: 0.002 }); },
  bell: (f) => { const s = decayScale(f); return modal(f / 2, 6, [[0.5, 0.5, 5.5 * s], [1, 0.45, 4 * s], [1.183, 0.42, 3.4 * s], [1.506, 0.28, 2.5 * s], [2, 0.7, 2.8 * s], [2.514, 0.22, 1.7 * s], [2.662, 0.18, 1.5 * s], [3.011, 0.2, 1.2 * s], [4.166, 0.12, 0.8 * s], [5.433, 0.07, 0.5 * s], [6.796, 0.04, 0.35 * s]], { click: 0.08, ctone: 0.5, spread: 0.002 }); },
  chime: (f) => { const s = decayScale(f); return modal(f, 3.4, [[1, 1, 2.8 * s], [2.76, 0.42, 1.4 * s], [5.4, 0.2, 0.7 * s], [8.93, 0.08, 0.35 * s]], { click: 0.06, ctone: 0.5 }); },
  xylo: (f) => { const s = decayScale(f); return modal(f, 0.8, [[1, 1, 0.45 * s], [3.0, 0.3, 0.12 * s], [6.1, 0.08, 0.04 * s]], { click: 0.5, ctone: 0.6, cdur: 0.002 }); },
  glass: (f) => modal(f, 0.9, [[1, 1, 0.55], [2.32, 0.35, 0.32], [4.25, 0.18, 0.16], [6.63, 0.07, 0.09]], { click: 0.1, ctone: 0.7, cdur: 0.002 }),
  wood: (f) => modal(f, 0.2, [[1, 1, 0.08], [1.59, 0.42, 0.055], [2.61, 0.22, 0.035], [3.92, 0.08, 0.02]], { click: 0.5, ctone: 0.5, cdur: 0.003 }),
  ceramic: (f) => modal(f, 0.18, [[1, 1, 0.1], [2.16, 0.45, 0.06], [3.85, 0.25, 0.035], [5.7, 0.1, 0.02]], { click: 0.2, ctone: 0.6, cdur: 0.002 }),
  stone: (f) => modal(f, 0.12, [[1, 1, 0.035], [1.73, 0.55, 0.026], [2.9, 0.35, 0.018], [4.6, 0.15, 0.01]], { click: 1.2, ctone: 0.35, cdur: 0.005 }),
  harp: (f) => karplus(f, 3.6, { t60: 3.2 * decayScale(f), bright: 0.55, pick: 0.45, lp: 0.1 }),
  guitar: (f) => karplus(f, 3.0, { t60: 2.4 * decayScale(f), bright: 0.32, pick: 0.17, lp: 0.2 }),
  uke: (f) => karplus(f, 1.6, { t60: 1.1 * decayScale(f), bright: 0.5, pick: 0.22, lp: 0.16 }),
  pizz: (f) => karplus(f, 1.0, { t60: 0.6 * decayScale(f), bright: 0.22, pick: 0.3, lp: 0.32 }),
  bubble: (f) => { const d = new Float32Array(Math.floor(TSR * 0.12)); chirp(d, TSR, 0, f * 0.7, f * 1.6, 0.014, 1, 0.022); return { data: finish(d, TSR), sr: TSR, rate: 1 }; },
};
const TEX = {
  rustle: () => {
    const sr = TSR, n = Math.floor(sr * 0.12), d = new Float32Array(n), env = new Float32Array(n), hp = bq('hp', 1800, 0.7), bp = bq('bp', 4200, 0.7);
    const k = 6 + Math.floor(R() * 6);
    for (let j = 0; j < k; j++) { const at = Math.floor(R() * n * 0.7), a = 0.3 + R() * 0.7, tau = sr * (0.003 + R() * 0.006); for (let i = at; i < n; i++) env[i] += a * Math.exp(-(i - at) / tau); }
    for (let i = 0; i < n; i++) d[i] = bp(hp(R() * 2 - 1)) * env[i] * Math.pow(1 - i / n, 1.2);
    return { data: finish(d, sr), sr, rate: 1 };
  },
  stepStone: () => {
    const sr = TSR, n = Math.floor(sr * 0.2), d = new Float32Array(n), bp = bq('bp', 700 + R() * 500, 1.1), hp = bq('hp', 2500, 0.7);
    chirp(d, sr, 0, 150 + R() * 30, 62, 0.02, 1, 0.035);
    const o = Math.floor(sr * (0.004 + R() * 0.006));
    for (let i = o; i < n; i++) { const t = (i - o) / sr, w = R() * 2 - 1; d[i] += 1.6 * bp(w) * Math.exp(-t / 0.022) + 0.4 * hp(w) * Math.exp(-t / 0.008); }
    if (R() < 0.6) chirp(d, sr, Math.floor(sr * (0.05 + R() * 0.03)), 120, 70, 0.02, 0.35, 0.02);
    return { data: finish(d, sr), sr, rate: 1 };
  },
  droplet: (v) => {
    const sr = TSR, d = new Float32Array(Math.floor(sr * 0.16)), f0 = 480 + v * 70 + R() * 40;
    chirp(d, sr, 0, f0, f0 * 2.6, 0.012, 1, 0.028);
    chirp(d, sr, Math.floor(sr * 0.045), f0 * 1.5, f0 * 3.2, 0.01, 0.25, 0.018);
    return { data: finish(d, sr), sr, rate: 1 };
  },
  splash: () => {
    const sr = TSR, n = Math.floor(sr * 0.6), d = new Float32Array(n), lp = bq('lp', 1400, 0.6), bp = bq('bp', 500, 0.8);
    for (let i = 0; i < n; i++) { const t = i / sr, w = R() * 2 - 1; d[i] = (0.6 * lp(w) + 0.5 * bp(w)) * Math.min(1, t / 0.02) * Math.exp(-t / 0.11); }
    for (let k = 0; k < 4; k++) chirp(d, sr, Math.floor(sr * (0.06 + R() * 0.3)), 300 + R() * 300, 900 + R() * 600, 0.008, 0.25 + R() * 0.2, 0.015);
    return { data: finish(d, sr), sr, rate: 1 };
  },
  creak: (v) => creakTex(0.32 + v * 0.14, 14 + v * 4, 40 + v * 10, 460 + v * 90),
  paper: () => {
    const sr = TSR, n = Math.floor(sr * 0.24), d = new Float32Array(n), env = new Float32Array(n), bp = bq('bp', 2300, 0.7), lp = bq('lp', 300, 0.7);
    for (let k = 0; k < 14; k++) { const at = Math.floor(R() * n * (k < 7 ? 0.35 : 0.85)), a = 0.3 + R() * 0.7, tau = sr * (0.002 + R() * 0.006); for (let i = at; i < n; i++) env[i] += a * Math.exp(-(i - at) / tau); }
    for (let i = 0; i < n; i++) { const t = i / sr, w = R() * 2 - 1; d[i] = bp(w) * env[i] * 0.8 + lp(w) * 2.5 * Math.exp(-t / 0.03) * Math.min(1, t / 0.004); }
    return { data: finish(d, sr), sr, rate: 1 };
  },
  grind: (v) => {
    const short = v >= 2, sr = TSR, n = Math.floor(sr * (short ? 0.7 : 1.75)), d = new Float32Array(n), lp1 = bq('lp', 300, 0.8), bp2 = bq('bp', 1000, 1.3), je = bq('lp', 26, 0.7);
    const lock = Math.floor(sr * (short ? 0.46 : 1.35));
    let br = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, w = R() * 2 - 1; br = (br + 0.03 * w) / 1.03;
      const jit = Math.min(2.2, Math.abs(je(R() * 2 - 1)) * 9);
      const body = i < lock ? Math.min(1, t / (short ? 0.06 : 0.15)) * Math.pow(1 - i / lock, 0.25) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 2.3 * t)) : 0;
      ph += (2 * Math.PI * (44 + 5 * Math.sin(2 * Math.PI * 0.8 * t))) / sr;
      d[i] = body * (lp1(br * 7) * (0.5 + 0.5 * jit) + 0.3 * bp2(w) * jit + 0.25 * Math.sin(ph));
    }
    chirp(d, sr, lock, 95, 46, 0.05, 0.9, 0.12); // the staircase locks into place
    const cl = bq('bp', 1600, 1.2);
    for (let i = lock; i < Math.min(n, lock + sr * 0.08); i++) d[i] += 0.5 * cl(R() * 2 - 1) * Math.exp(-(i - lock) / (sr * 0.015));
    return { data: finish(d, sr), sr, rate: 1 };
  },
  slide: (v) => {
    const sr = TSR, endS = v >= 2 ? 0.42 : 0.78, n = Math.floor(sr * (endS + 0.24)), d = new Float32Array(n), lp = bq('lp', 650, 0.6), bp = bq('bp', 360, 0.9);
    let br = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, u = Math.min(1, t / endS), w = R() * 2 - 1; br = (br + 0.04 * w) / 1.04;
      const e = t < endS ? Math.pow(Math.sin(Math.PI * u), 1.6) : 0;
      ph += (2 * Math.PI * (190 + 26 * u)) / sr;
      d[i] = e * (lp(br * 6) * 0.8 + bp(w) * 0.25 + Math.sin(ph) * 0.12);
    }
    const tok = TONAL.wood(midi(v >= 2 ? 62 : 67)).data, at = Math.floor(sr * endS);
    for (let i = 0; i < tok.length && at + i < n; i++) d[at + i] += tok[i] * (v >= 2 ? 0.6 : 0.35);
    return { data: finish(d, sr), sr, rate: 1 };
  },
  crackle: () => {
    const sr = TSR, n = Math.floor(sr * 1.3), d = new Float32Array(n), bp = bq('bp', 3200, 0.8), hp = bq('hp', 900, 0.7);
    for (let i = 0; i < n; i++) { const t = i / sr, rate = 900 * Math.exp(-t / 0.25) + 30; const x = R() < rate / sr ? (R() * 2 - 1) * (0.4 + R()) : 0; d[i] = bp(hp(x)) * 6; }
    return { data: finish(d, sr), sr, rate: 1 };
  },
  bubbles: () => { // a short upward stream of bubbles
    const sr = TSR, n = Math.floor(sr * 0.9), d = new Float32Array(n);
    for (let k = 0; k < 9; k++) { const u = k / 9, f = 380 + u * 900 + R() * 160; chirp(d, sr, Math.floor(sr * (u * 0.62 + R() * 0.05)), f * 0.7, f * 1.7, 0.012, 0.5 + R() * 0.5, 0.02 + R() * 0.012); }
    return { data: finish(d, sr), sr, rate: 1 };
  },
};

// ═════════════════════ Kit: instruments and SFX building blocks for the engines ═════════════════════
function createKit(ctx, io) {
  const sr = ctx.sampleRate;
  const kept = [];
  const keep = (n) => { kept.push(n); return n; };
  // Engine music bus, high-passed at 30 Hz: sub rumble nobody hears only makes the glue compressor pump.
  const bus = keep(ctx.createGain()), rumble = keep(ctx.createBiquadFilter());
  rumble.type = 'highpass'; rumble.frequency.value = 30; rumble.Q.value = 0.7; bus.connect(rumble).connect(io.music);
  const sfxBus = keep(ctx.createGain()); sfxBus.connect(io.sfxOut);

  // Additive waveforms (band-limited, rolled off so nothing buzzes)
  const wave = (fn, n = 40) => { const re = new Float32Array(n + 1), im = new Float32Array(n + 1); for (let k = 1; k <= n; k++) im[k] = fn(k); return ctx.createPeriodicWave(re, im); };
  const W = {
    strings: wave((k) => Math.pow(k, -1.05) * (k > 14 ? Math.exp(-(k - 14) / 8) : 1)),
    warm: wave((k) => Math.pow(k, -1.35)),
    brass: wave((k) => Math.pow(k, -0.8) * (k > 18 ? Math.exp(-(k - 18) / 6) : 1)),
    soft: wave((k) => [0, 1, 0.22, 0.07, 0.03, 0.012][k] || 0, 6),
    choir: wave((k) => Math.pow(k, -1.2)),
    pulse: wave((k) => (Math.sin(Math.PI * k * 0.3) / k) * Math.exp(-k / 14)),
    reed: wave((k) => (k % 2 ? 1 / k : 0.08 / k)),
  };

  // Noise buffers (white/pink/brown), loop-crossfaded so looping never clicks
  const nbufs = {};
  function noiseBuf(kind) {
    if (nbufs[kind]) return nbufs[kind];
    if (kind === 'white' && io.white) return (nbufs.white = io.white());
    const len = Math.floor(sr * 3), X = Math.floor(sr * 0.05), raw = new Float32Array(len + X);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = R() * 2 - 1;
      if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; raw[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22; }
      else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; raw[i] = last * 3.5; }
      else raw[i] = w;
    }
    const b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = i < X ? raw[i] * (i / X) + raw[len + i] * (1 - i / X) : raw[i];
    return (nbufs[kind] = b);
  }

  // Instrument/texture buffer cache (LRU-ish cap)
  const cache = new Map();
  function get(kind, note = 0, variant = 0) {
    const key = kind + ':' + note + ':' + variant;
    let b = cache.get(key);
    if (b) return b;
    const r = TONAL[kind] ? TONAL[kind](midi(note)) : TEX[kind] ? TEX[kind](variant) : null;
    if (!r) return null;
    const ab = ctx.createBuffer(1, r.data.length, r.sr);
    ab.getChannelData(0).set(r.data);
    b = { buf: ab, rate: r.rate || 1 };
    cache.set(key, b);
    if (cache.size > 220) cache.delete(cache.keys().next().value);
    return b;
  }
  // Pre-render buffers in small slices so the first notes never stall a frame.
  const queue = [];
  let pumping = false;
  function pump() {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 5) { const [k, n, v] = queue.shift(); get(k, n, v); }
    if (queue.length) setTimeout(pump, 16); else pumping = false;
  }
  function warm(list) { queue.push(...list); if (!pumping) { pumping = true; setTimeout(pump, 20); } }

  /** A voice group: every node made for one note/hit; all disconnected when its last source ends. */
  function G(dest, gain = 1) {
    const out = ctx.createGain(); out.gain.value = gain; out.connect(dest);
    const nodes = [out];
    let live = 0;
    const end = () => { if (--live > 0) return; for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } } nodes.length = 0; };
    return {
      out,
      add(n) { nodes.push(n); return n; },
      play(src, t0, t1, off) { nodes.push(src); live++; src.onended = end; if (off != null) src.start(t0, off); else src.start(t0); src.stop(Math.max(t1, t0 + 0.01)); return src; },
    };
  }
  const osc = (g, w, f, t0, t1, det = 0) => { const o = ctx.createOscillator(); if (typeof w === 'string') o.type = w; else o.setPeriodicWave(w); o.frequency.value = f; if (det) o.detune.value = det; return g.play(o, t0, t1); };
  const nz = (g, kind, t0, t1) => { const s = ctx.createBufferSource(); s.buffer = noiseBuf(kind); s.loop = true; return g.play(s, t0, t1, R() * 1.8); };
  const flt = (g, type, f, q = 0.7, gain = 0) => { const b = g.add(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; if (gain) b.gain.value = gain; return b; };
  const gn = (g, v = 0) => { const a = g.add(ctx.createGain()); a.gain.value = v; return a; };
  const pn = (g, p) => { const s = g.add(ctx.createStereoPanner()); s.pan.value = p; return s; };
  // Envelopes (no clicks: linear attacks, exponential approach to zero)
  const perc = (p, t, a, peak, dec) => { p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a); p.setTargetAtTime(0, t + a, dec / 5); };
  const swell = (p, t, a, peak, end, rel) => { p.setValueAtTime(0, t); p.setTargetAtTime(peak, t, Math.max(0.005, a / 3)); p.setTargetAtTime(0, Math.max(end, t + 0.02), Math.max(0.01, rel / 5)); };

  /** Persistent channel: gain → EQ → pan → bus (+ reverb send). */
  function ch({ gain = 1, pan = 0, send = 0.3, eq = [], to = bus } = {}) {
    const inp = keep(ctx.createGain()); inp.gain.value = gain;
    let last = inp;
    for (const [type, f, q = 0.7, g = 0] of eq) { const b = keep(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; last.connect(b); last = b; }
    const p = keep(ctx.createStereoPanner()); p.pan.value = pan; last.connect(p).connect(to);
    if (send) { const s = keep(ctx.createGain()); s.gain.value = send; last.connect(s).connect(io.verbIn); }
    return inp;
  }
  const sfxCh = (o = {}) => ch({ ...o, to: sfxBus });
  /** Persistent filter stage that channels can feed (e.g. an underwater low-pass over the whole score). */
  function stage(type, f, q = 0.7) { const b = keep(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(bus); return b; }
  /** Stereo ping-pong delay with a darkening feedback loop. */
  function delay({ time = 0.375, fb = 0.32, cut = 2600, wet = 0.22, send = 0.15 } = {}) {
    const inp = keep(ctx.createGain()), fl = keep(ctx.createBiquadFilter()), dl = keep(ctx.createDelay(2)), dr = keep(ctx.createDelay(2));
    const fa = keep(ctx.createGain()), fbk = keep(ctx.createGain()), pl = keep(ctx.createStereoPanner()), pr = keep(ctx.createStereoPanner()), w = keep(ctx.createGain());
    fl.type = 'lowpass'; fl.frequency.value = cut; dl.delayTime.value = time; dr.delayTime.value = time;
    fa.gain.value = fb; fbk.gain.value = fb; pl.pan.value = -0.65; pr.pan.value = 0.65; w.gain.value = wet;
    inp.connect(fl).connect(dl); dl.connect(pl).connect(w); dl.connect(fa).connect(dr); dr.connect(pr).connect(w); dr.connect(fbk).connect(fl);
    w.connect(bus);
    if (send) { const s = keep(ctx.createGain()); s.gain.value = send; w.connect(s).connect(io.verbIn); }
    return { input: inp, setTime(t, now) { dl.delayTime.setTargetAtTime(t, now, 0.5); dr.delayTime.setTargetAtTime(t, now, 0.5); } };
  }
  /** Persistent oscillators → low-pass → gain(0): drones whose level the engine moves in update(). */
  function drone(specs, { cut = 400, q = 0.6, dest = bus, trem = 0 } = {}) {
    const f = keep(ctx.createBiquadFilter()), g = keep(ctx.createGain());
    f.type = 'lowpass'; f.frequency.value = cut; f.Q.value = q; g.gain.value = 0;
    let tg = null;
    if (trem) { tg = keep(ctx.createGain()); tg.gain.value = 1 - trem / 2; const l = keep(ctx.createOscillator()), lg = keep(ctx.createGain()); l.frequency.value = 0.17 + R() * 0.06; lg.gain.value = trem / 2; l.connect(lg).connect(tg.gain); l.start(); f.connect(tg).connect(g); }
    else f.connect(g);
    g.connect(dest);
    for (const [w, n, det = 0, lvl = 1] of specs) {
      const o = keep(ctx.createOscillator()); if (typeof w === 'string') o.type = w; else o.setPeriodicWave(w);
      o.frequency.value = midi(n); o.detune.value = det;
      const og = keep(ctx.createGain()); og.gain.value = lvl; o.connect(og).connect(f); o.start();
    }
    return { gain: g.gain, filter: f };
  }
  /** Persistent noise bed with slow swells (ocean, air). */
  function bed({ kind = 'brown', type = 'lowpass', f = 600, q = 0.6, pan = 0, rate = 0.1, depth = 0.6, dest = bus } = {}) {
    const s = keep(ctx.createBufferSource()), b = keep(ctx.createBiquadFilter()), m = keep(ctx.createGain()), g = keep(ctx.createGain()), p = keep(ctx.createStereoPanner());
    s.buffer = noiseBuf(kind); s.loop = true; b.type = type; b.frequency.value = f; b.Q.value = q; m.gain.value = 1 - depth / 2; g.gain.value = 0; p.pan.value = pan;
    const l = keep(ctx.createOscillator()), lg = keep(ctx.createGain()); l.frequency.value = rate; lg.gain.value = depth / 2; l.connect(lg).connect(m.gain); l.start();
    s.connect(b).connect(m).connect(g).connect(p).connect(dest); s.start(0, R() * 2);
    return { gain: g.gain, filter: b };
  }

  // ── tonal voices (oscillator-based, for sustained parts) ──
  function sustain(dest, t, notes, dur, o = {}) {
    const { vel = 0.05, a = 0.4, r = 0.8, cut = 2400, q = 0.6, wave: wv = W.strings, voices = 2, det = 7, vib = 0.1, vibRate = 5.2, cutTo = 0, cutTime = 0, cutEnd = 0, glide = 0, pan = null } = o;
    const g = G(dest), end = t + dur, stop = end + r * 1.15 + 0.05;
    const f = flt(g, 'lowpass', cut, q), e = gn(g);
    f.connect(e);
    if (pan != null) e.connect(pn(g, pan)).connect(g.out); else e.connect(g.out);
    swell(e.gain, t, a, (vel * 1.6) / Math.sqrt(notes.length * voices), end, r);
    if (cutTo) { f.frequency.setValueAtTime(cut, t); f.frequency.setTargetAtTime(cutTo, t, cutTime || a / 2); }
    if (cutEnd) f.frequency.setTargetAtTime(cutEnd, end, r / 3);
    let lg = null;
    if (vib) { const l = osc(g, 'sine', vibRate * (0.9 + R() * 0.2), t, stop); lg = gn(g); l.connect(lg); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(vib * 100, t + Math.min(0.9, Math.max(0.1, dur * 0.5))); }
    for (const n of notes) for (let k = 0; k < voices; k++) {
      const d = (voices > 1 ? ((2 * k) / (voices - 1) - 1) * det : 0) + (R() - 0.5) * 4;
      const ov = osc(g, wv, midi(n), t, stop, d);
      if (glide) { ov.detune.setValueAtTime(d, t); ov.detune.linearRampToValueAtTime(d + glide, end); }
      if (lg) lg.connect(ov.detune);
      ov.connect(f);
    }
  }
  const brass = (dest, t, notes, dur, o = {}) => sustain(dest, t, notes, dur, { wave: W.brass, voices: 3, det: 8, vib: 0.04, vibRate: 4.6, q: 0.8, cut: 260, cutTo: 500 + 2800 * (o.bright ?? 0.6), cutTime: (o.a ?? 0.5) * 0.7, cutEnd: 300, ...o });
  const VOW = { ah: [[750, 6, 1], [1150, 8, 0.55], [2800, 10, 0.25]], oo: [[330, 5, 1], [760, 7, 0.4], [2350, 10, 0.08]] };
  function choir(dest, t, notes, dur, o = {}) {
    const { vel = 0.04, a = 1.2, r = 1.6, vowel = 'ah', breath = 0.15 } = o;
    const g = G(dest), end = t + dur, stop = end + r * 1.4 + 0.05, src = gn(g, 1), e = gn(g);
    for (const [f, q, k] of VOW[vowel]) src.connect(flt(g, 'bandpass', f, q)).connect(gn(g, k * 2.8)).connect(e);
    src.connect(flt(g, 'lowpass', 420, 0.5)).connect(gn(g, 0.4)).connect(e);
    e.connect(g.out);
    swell(e.gain, t, a, (vel * 1.6) / Math.sqrt(notes.length * 2), end, r);
    const l = osc(g, 'sine', 4.4 + R() * 0.6, t, stop), lg = gn(g); l.connect(lg); lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(14, t + 0.8);
    for (const n of notes) for (const d of [-9, 9]) { const ov = osc(g, W.choir, midi(n), t, stop, d + (R() - 0.5) * 6); lg.connect(ov.detune); ov.connect(src); }
    if (breath) nz(g, 'pink', t, stop).connect(gn(g, breath)).connect(src);
  }
  function spic(dest, t, n, { vel = 0.08, len = 0.15, cut = 1600, wave: wv = W.strings } = {}) {
    const g = G(dest), stop = t + len * 1.5 + 0.06, f = flt(g, 'lowpass', cut * 2, 0.8), e = gn(g);
    f.frequency.setValueAtTime(cut * 2, t); f.frequency.setTargetAtTime(cut, t, 0.04);
    f.connect(e).connect(g.out); perc(e.gain, t, 0.006, vel, len);
    for (const d of [-6, 6]) osc(g, wv, midi(n), t, stop, d + (R() - 0.5) * 4).connect(f);
  }
  function sbass(dest, t, n, { vel = 0.1, len = 0.2, cut = 600, q = 3, sub = 0.6 } = {}) {
    const g = G(dest), stop = t + len * 1.5 + 0.06, f = flt(g, 'lowpass', cut, q), e = gn(g);
    f.frequency.setValueAtTime(cut * 3, t); f.frequency.setTargetAtTime(cut, t, len * 0.3);
    f.connect(e).connect(g.out); perc(e.gain, t, 0.005, vel, len);
    osc(g, W.warm, midi(n), t, stop, -5).connect(f); osc(g, W.warm, midi(n), t, stop, 5).connect(f);
    if (sub) osc(g, 'sine', midi(n - 12), t, stop).connect(gn(g, sub)).connect(e);
  }
  function apl(dest, t, n, { vel = 0.05, len = 0.15, cut = 2000, wave: wv = W.pulse } = {}) {
    const g = G(dest), stop = t + len * 1.5 + 0.06, f = flt(g, 'lowpass', cut, 1.2), e = gn(g);
    f.frequency.setValueAtTime(cut * 2.2, t); f.frequency.setTargetAtTime(cut, t, len * 0.25);
    f.connect(e).connect(g.out); perc(e.gain, t, 0.003, vel, len);
    osc(g, wv, midi(n), t, stop, -4).connect(f); osc(g, wv, midi(n), t, stop, 4).connect(f);
  }
  function fm(dest, t, n, { vel = 0.06, dur = 1.5, ratio = 3.5, index = 1.6, pan = null } = {}) {
    const g = G(dest), f = midi(n), stop = t + dur * 1.4 + 0.05;
    const car = osc(g, 'sine', f, t, stop), mod = osc(g, 'sine', f * ratio, t, stop), mg = gn(g), e = gn(g);
    mg.gain.setValueAtTime(f * index, t); mg.gain.setTargetAtTime(f * index * 0.12, t, dur * 0.12);
    mod.connect(mg).connect(car.frequency);
    car.connect(e); if (pan != null) e.connect(pn(g, pan)).connect(g.out); else e.connect(g.out);
    perc(e.gain, t, 0.004, vel, dur);
  }
  /** Rising tones with tremolo, swelling to `vel` at t+dur and cut there (risers). */
  function riseTones(dest, t, notes, dur, { vel = 0.05, mult = 2, wave: wv = W.strings, trem = [8, 16], cut = [500, 4500], voices = 2 } = {}) {
    const g = G(dest), stop = t + dur + 0.08, f = flt(g, 'lowpass', cut[0], 0.7), tg = gn(g, 1), e = gn(g);
    f.frequency.setValueAtTime(cut[0], t); f.frequency.exponentialRampToValueAtTime(cut[1], t + dur);
    f.connect(tg).connect(e).connect(g.out);
    e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(vel / Math.sqrt(notes.length * voices), t + dur); e.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    if (trem) { tg.gain.value = 0.55; const l = osc(g, 'sine', trem[0], t, stop); l.frequency.setValueAtTime(trem[0], t); l.frequency.linearRampToValueAtTime(trem[1], t + dur); l.connect(gn(g, 0.45)).connect(tg.gain); }
    for (const n of notes) for (let k = 0; k < voices; k++) { const o2 = osc(g, wv, midi(n), t, stop, (k - 0.5) * 14); o2.frequency.setValueAtTime(midi(n), t); o2.frequency.exponentialRampToValueAtTime(midi(n) * mult, t + dur); o2.connect(f); }
  }

  // ── percussion ──
  function thump(dest, t, { f0 = 120, f1 = 45, fdec = 0.12, vel = 0.5, dec = 0.35, a = 0.003, wave: wv = 'sine' } = {}) {
    const g = G(dest), o = osc(g, wv, f0, t, t + a + dec * 1.4 + 0.03), e = gn(g);
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + fdec);
    o.connect(e).connect(g.out); perc(e.gain, t, a, vel, dec);
  }
  function hit(dest, t, { kind = 'white', type = 'bandpass', f = 1000, q = 1, vel = 0.2, dec = 0.08, a = 0.001, f1 = 0 } = {}) {
    const g = G(dest), n = nz(g, kind, t, t + a + dec * 1.4 + 0.03), b = flt(g, type, f, q), e = gn(g);
    if (f1) { b.frequency.setValueAtTime(f, t); b.frequency.exponentialRampToValueAtTime(f1, t + dec); }
    n.connect(b).connect(e).connect(g.out); perc(e.gain, t, a, vel, dec);
  }
  const heart = (d, t, v = 1) => {
    thump(d, t, { f0: 72, f1: 44, fdec: 0.09, vel: 0.5 * v, dec: 0.2 }); thump(d, t, { f0: 150, f1: 90, fdec: 0.05, vel: 0.13 * v, dec: 0.07 });
    thump(d, t + 0.14, { f0: 66, f1: 42, fdec: 0.08, vel: 0.34 * v, dec: 0.16 }); thump(d, t + 0.14, { f0: 140, f1: 85, fdec: 0.05, vel: 0.09 * v, dec: 0.05 });
  };
  const kick = (d, t, v = 1) => { thump(d, t, { f0: 160, f1: 46, fdec: 0.08, vel: 0.55 * v, dec: 0.34 }); hit(d, t, { f: 3200, q: 0.8, vel: 0.05 * v, dec: 0.012 }); };
  const taiko = (d, t, v = 1, p = 1) => {
    thump(d, t, { f0: 110 * p, f1: 52 * p, fdec: 0.16, vel: 0.6 * v, dec: 0.55 }); thump(d, t, { f0: 220 * p, f1: 118 * p, fdec: 0.06, vel: 0.17 * v, dec: 0.16 });
    hit(d, t, { type: 'lowpass', f: 900 * p, q: 0.4, vel: 0.24 * v, dec: 0.09 });
  };
  const tom = (d, t, v = 1, p = 1) => { thump(d, t, { f0: 175 * p, f1: 98 * p, fdec: 0.12, vel: 0.4 * v, dec: 0.32 }); hit(d, t, { f: 1100 * p, q: 1, vel: 0.12 * v, dec: 0.05 }); };
  function timp(d, t, note, v = 1) {
    const f = midi(note), g = G(d), parts = v < 0.3 ? 3 : 5; // quiet roll strokes need fewer modes
    for (const [r, a, dec] of [[1, 1, 1.9], [1.504, 0.45, 1.1], [1.742, 0.25, 0.8], [2.0, 0.22, 0.7], [2.44, 0.1, 0.45]].slice(0, parts)) {
      const o = osc(g, 'sine', f * r * 1.015, t, t + 0.004 + dec * 1.4 * Math.min(1, 0.4 + v), 0), e = gn(g);
      o.frequency.setValueAtTime(f * r * 1.015, t); o.frequency.exponentialRampToValueAtTime(f * r, t + 0.08);
      o.connect(e).connect(g.out); perc(e.gain, t, 0.004, 0.32 * v * a, dec);
    }
    hit(d, t, { type: 'lowpass', f: 500, q: 0.5, vel: 0.12 * v, dec: 0.05 });
  }
  const frame = (d, t, v = 1, slap = 0) => { thump(d, t, { f0: 130, f1: 80, fdec: 0.08, vel: 0.32 * v, dec: 0.24 }); hit(d, t, { f: 950, q: 1.1, vel: (0.08 + slap) * v, dec: 0.045 }); };
  const bongo = (d, t, v = 1, hi = false) => { const f = hi ? 380 : 270; thump(d, t, { f0: f * 1.25, f1: f, fdec: 0.03, vel: 0.2 * v, dec: 0.12 }); hit(d, t, { f: 2400, q: 1.2, vel: 0.05 * v, dec: 0.015 }); };
  function shaker(d, t, v = 1) {
    const g = G(d), n = nz(g, 'white', t, t + 0.14), e = gn(g);
    n.connect(flt(g, 'bandpass', 6800, 1.3)).connect(flt(g, 'highpass', 3200, 0.7)).connect(e).connect(g.out);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.07 * v, t + 0.012); e.gain.setTargetAtTime(0, t + 0.014, 0.014);
  }
  const hat = (d, t, v = 1, open = 0) => hit(d, t, { type: 'highpass', f: 7600, q: 0.7, vel: 0.05 * v, dec: open ? 0.28 : 0.035 });
  const clap = (d, t, v = 1) => { for (const k of [0, 0.011, 0.023]) hit(d, t + k, { f: 1500, q: 0.9, vel: 0.14 * v, dec: 0.012 }); hit(d, t + 0.03, { f: 1300, q: 0.7, vel: 0.12 * v, dec: 0.15 }); };
  function crash(d, t, v = 1, dec = 2.2) {
    const g = G(d), n = nz(g, 'white', t, t + dec * 1.4 + 0.05), e = gn(g);
    n.connect(flt(g, 'highpass', 3200, 0.6)).connect(flt(g, 'peaking', 6200, 1.2, 5)).connect(e).connect(g.out); perc(e.gain, t, 0.002, 0.1 * v, dec);
  }
  function revCym(d, t, dur, v = 1) {
    const g = G(d), n = nz(g, 'white', t, t + dur + 0.06), h = flt(g, 'highpass', 5000, 0.6), e = gn(g);
    h.frequency.setValueAtTime(5000, t); h.frequency.exponentialRampToValueAtTime(2200, t + dur);
    n.connect(h).connect(e).connect(g.out); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.09 * v, t + dur); e.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  }
  const subDrop = (d, t, { f0 = 60, f1 = 28, dur = 1.6, vel = 0.5 } = {}) => thump(d, t, { f0, f1, fdec: dur * 0.8, vel, dec: dur, a: 0.006 });

  // ── SFX building blocks ──
  function nsweep(dest, t, o = {}) {
    const { dur = 0.4, kind = 'pink', type = 'bandpass', f0 = 400, f1 = 3000, q = 1, peak = 0.08, at = 0.5, pan0 = null, pan1 = null, rev = false } = o;
    const g = G(dest), n = nz(g, kind, t, t + dur * 1.3 + 0.06), b = flt(g, type, f0, q), e = gn(g);
    b.frequency.setValueAtTime(f0, t); b.frequency.exponentialRampToValueAtTime(f1, t + dur);
    n.connect(b).connect(e);
    if (pan0 != null) { const p = pn(g, pan0); p.pan.setValueAtTime(pan0, t); p.pan.linearRampToValueAtTime(pan1 ?? pan0, t + dur); e.connect(p).connect(g.out); } else e.connect(g.out);
    if (rev) { e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(peak, t + dur); e.gain.linearRampToValueAtTime(0, t + dur + 0.03); }
    else { const tp = t + dur * at; e.gain.setValueAtTime(0, t); e.gain.setTargetAtTime(peak, t, Math.max(0.004, (tp - t) / 2.2)); e.gain.setTargetAtTime(0, tp, Math.max(0.01, (t + dur - tp) / 3.5)); }
  }
  function tsweep(dest, t, { f0 = 800, f1 = 0, dur = 0.1, wave: wv = 'sine', peak = 0.05, a = 0.003, pan = null, glide = 0.6 } = {}) {
    const g = G(dest), o = osc(g, wv, f0, t, t + a + dur * 1.4 + 0.03), e = gn(g);
    if (f1) { o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur * glide); }
    o.connect(e); if (pan != null) e.connect(pn(g, pan)).connect(g.out); else e.connect(g.out);
    perc(e.gain, t, a, peak, dur);
  }
  /** Play a cached buffer (tonal note or texture). */
  function play(dest, kind, note, t, o = {}) {
    const { vel = 0.3, rate = 1, variant = 0, pan = null, bend = 0, bendTime = 0.3, cut = 0 } = o;
    const b = get(kind, note, variant);
    if (!b) return;
    const g = G(dest, vel), s = ctx.createBufferSource(), r0 = b.rate * rate;
    s.buffer = b.buf; s.playbackRate.setValueAtTime(r0, t);
    if (bend) s.playbackRate.exponentialRampToValueAtTime(r0 * Math.pow(2, bend / 12), t + bendTime);
    let head = g.out;
    if (pan != null) { const p = pn(g, pan); p.connect(head); head = p; }
    if (cut) { const f = flt(g, 'lowpass', cut, 0.5); f.connect(head); head = f; }
    s.connect(head);
    g.play(s, t, t + b.buf.duration / r0 + 0.05);
  }
  /** Strum / glissando of buffer notes. vel may be a function of the note index. */
  const arp = (dest, kind, notes, t, gap, vel, o = {}) => notes.forEach((n, k) => play(dest, kind, n, t + k * gap + R() * gap * 0.12, { ...o, vel: typeof vel === 'function' ? vel(k) : vel }));
  /** Call fn(time, progress) at an accelerating rate (drum rolls, bubble streams). */
  function roll(t, dur, r0, r1, fn) { let x = t; while (x < t + dur - 0.005) { const u = (x - t) / dur; fn(x, u); x += 1 / (r0 + (r1 - r0) * u); } }

  function destroy() { for (const n of kept) { try { n.stop?.(); } catch { /* not started */ } try { n.disconnect(); } catch { /* gone */ } } kept.length = 0; cache.clear(); }

  return {
    ctx, W, R, ramp, midi, bus, sfxBus, ch, sfxCh, stage, delay, drone, bed, warm, get, destroy,
    sustain, brass, choir, spic, sbass, apl, fm, riseTones,
    thump, hit, heart, kick, taiko, tom, timp, frame, bongo, shaker, hat, clap, crash, revCym, subDrop,
    nsweep, tsweep, play, arp, roll,
    hv: (v, a = 0.16) => v * (1 - a / 2 + R() * a),
    jit: (t, a = 0.006) => t + R() * a,
  };
}

// ═════════════════════ Per-variant engines ═════════════════════
// Each returns { spb (grid steps per bar), stepDur(i), step(t, s, bar, i, sd), update?(now, i), sfx: { event(t, vol, o) },
// mix, trim?: { event: gain } (loudness balance), gap?: { event: seconds } (minimum spacing for long effects) }.
// sfx recipes receive the start time, a volume multiplier and the caller's { rate, dur, up }.
const ENGINES = {};
/** Events an engine doesn't define fall back to a close relative before the generic sound. */
const ALIAS = { whoosh: 'zoomIn', impact: 'intro', spin: 'zoomIn', footstep: 'step', grind: 'step', stinger: 'unlock', peek: 'unlock', sonar: 'unlock' };

// ── The Ascent: E minor/Dorian climb. Heartbeat + low strings at sea level → taiko, brass, soaring line at the summit.
ENGINES['ascent'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 40, v: [52, 59, 64, 67] }, { b: 36, v: [52, 55, 60, 64] }, { b: 43, v: [50, 55, 59, 62] }, { b: 38, v: [50, 54, 57, 62] },
    { b: 40, v: [52, 59, 64, 67] }, { b: 36, v: [52, 55, 60, 64] }, { b: 45, v: [52, 57, 61, 64] }, { b: 47, v: [52, 59, 64, 66], v2: [54, 59, 63, 66] },
  ]; // Em C G D | Em C A(Dorian IV) Bsus4→B
  const MEL = [[[0, 76, 12], [12, 78, 4]], [[0, 79, 8], [8, 76, 8]], [[0, 74, 12], [12, 71, 4]], [[0, 69, 8], [8, 74, 8]],
    [[0, 76, 12], [12, 78, 4]], [[0, 79, 8], [8, 81, 8]], [[0, 81, 12], [12, 83, 4]], [[0, 83, 16]]];
  const OST = [0, 0, 7, 0, 12, 0, 7, 0, 0, 0, 7, 0, 12, 7, 0, 7], ACC = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const low = K.ch({ send: 0.2, eq: [['lowpass', 1500, 0.5]] }), vla = K.ch({ pan: -0.3, send: 0.45 }), ost = K.ch({ pan: 0.2, send: 0.26, eq: [['highpass', 110, 0.6]] });
  const brs = K.ch({ pan: 0.28, send: 0.5 }), lead = K.ch({ pan: -0.08, send: 0.6 }), drm = K.ch({ send: 0.25 }), tko = K.ch({ send: 0.42 });
  const dry = K.sfxCh({ send: 0.04 }), room = K.sfxCh({ send: 0.28 }), wet = K.sfxCh({ send: 0.6 });
  const GL = [64, 67, 69, 71, 74, 76, 79, 81, 83];
  K.warm([...GL.map((n) => ['harp', n]), ['stone', 86], ['stone', 79], ['stone', 74], ['bell', 76], ['glass', 88], ...[0, 1, 2, 3].map((v) => ['stepStone', 0, v]), ['creak', 0, 1]]);
  const intro = (t, v) => {
    K.subDrop(room, t, { f0: 62, f1: 28, dur: 2.2, vel: 0.55 * v }); K.taiko(room, t, 1.1 * v); K.crash(wet, t, 1.4 * v, 2.6);
    K.brass(wet, t, [40, 47, 52, 55, 59, 64], 1.6, { vel: 0.2 * v, a: 0.06, r: 1.2, bright: 0.9 });
    K.sustain(wet, t, [64, 67, 71, 76], 1.2, { vel: 0.1 * v, a: 0.03, r: 1.0, cut: 4200 });
  };
  return {
    spb: 16,
    mix: { verb: { dur: 3.6, decay: 2.6, tone: 0.45, pre: 0.025 }, verbLevel: 0.5, level: 0.55, sfxLevel: 1 },
    trim: { hover: 0.65, select: 0.5, back: 0.8, zoomIn: 1.3, start: 0.42, complete: 0.6, unlock: 0.9, riser: 0.7, step: 0.32 },
    stepDur: (i) => 60 / (70 + 50 * i) / 4,
    step(t, s, bar, i, sd) {
      const ph = bar % 8, c = P[ph], barDur = sd * 16;
      if (s === 0 || (s === 8 && c.v2)) {
        const v = s === 8 ? c.v2 : c.v, d = (c.v2 ? barDur / 2 : barDur) * 1.06;
        if (s === 0) K.sustain(low, t, [c.b - 12, c.b], barDur * 1.06, { vel: 0.08 + 0.08 * i, a: 0.3 + 0.3 * (1 - i), r: 0.9, cut: 360 + 800 * i, vib: 0.04 });
        const pd = ramp(0.26, 0.42, i);
        if (pd) K.sustain(vla, t, v, d, { vel: (0.05 + 0.04 * i) * pd, a: 0.7, r: 1.0, cut: 800 + 2400 * i, vib: 0.1 });
        const br = ramp(0.6, 0.74, i);
        if (br) K.brass(brs, t, v.map((n) => n - 12), d, { vel: 0.08 * br, a: d * 0.6, r: 0.45, bright: 0.45 + 0.5 * i });
      }
      const hb = 1 - ramp(0.45, 0.6, i);
      if (hb > 0 && s % 4 === 0) K.heart(drm, t, (s === 0 ? 0.72 : 0.6) * hb);
      const os = ramp(0.18, 0.3, i);
      if (os && (i > 0.42 || s % 2 === 0)) K.spic(ost, K.jit(t, 0.004), c.b + 12 + OST[s], { vel: K.hv((0.05 + 0.05 * ACC[s]) * os * (0.75 + 0.45 * i)), len: sd * 1.1, cut: 900 + 2000 * i });
      if (i > 0.3 && s === 0) K.timp(drm, t, c.b > 40 ? c.b - 12 : c.b, 0.55 * ramp(0.3, 0.45, i));
      const tk = ramp(0.48, 0.6, i);
      if (tk) {
        if (s === 0 || s === 6 || s === 12) K.taiko(tko, t, tk * (s === 0 ? 1 : 0.75));
        if (i > 0.68 && (s === 3 || s === 9 || s === 10)) K.taiko(tko, t, tk * 0.35, 1.35);
        if (i > 0.7 && (ph === 3 || ph === 7) && s >= 12) K.tom(drm, t, 0.55 + 0.1 * (s - 12), 1.6 - 0.12 * (s - 12));
      }
      if (i > 0.75 && s === 0 && ph % 4 === 0) K.subDrop(drm, t, { f0: 58, f1: 32, dur: 1.2, vel: 0.35 });
      if (i > 0.82 && (s === 4 || s === 12)) { K.hit(drm, t, { f: 1800, q: 0.9, vel: 0.12, dec: 0.08 }); K.thump(drm, t, { f0: 240, f1: 160, vel: 0.12, dec: 0.08 }); }
      if (i > 0.8 && ph === 7 && s === 8) K.revCym(drm, t, barDur / 2, 1);
      if (i > 0.8 && ph === 0 && s === 0) K.crash(drm, t, 1);
      const ld = ramp(0.78, 0.9, i);
      if (ld) for (const [st, n, len] of MEL[ph]) if (st === s) K.sustain(lead, t, i > 0.93 ? [n, n - 12] : [n], len * sd * 1.02, { vel: 0.07 * ld, a: 0.12, r: 0.5, cut: 3200, vib: 0.18, voices: 3, det: 9 });
    },
    sfx: {
      hover: (t, v) => K.play(dry, 'stone', 86, t, { vel: 0.05 * v, rate: 0.94 + R() * 0.12 }),
      select: (t, v) => { K.play(dry, 'stone', 79, t, { vel: 0.17 * v }); K.thump(dry, t, { f0: 220, f1: 140, vel: 0.08 * v, dec: 0.05 }); K.play(room, 'glass', 88, t + 0.012, { vel: 0.05 * v }); },
      back: (t, v) => { K.nsweep(dry, t, { dur: 0.06, f0: 900, f1: 1400, q: 1.2, peak: 0.05 * v, rev: true }); K.play(dry, 'stone', 74, t + 0.06, { vel: 0.11 * v }); },
      zoomIn: (t, v) => K.nsweep(dry, t, { dur: 0.32, f0: 500, f1: 2600, q: 1.3, peak: 0.12 * v, at: 0.7 }),
      zoomOut: (t, v) => { for (const p of [-1, 1]) K.nsweep(room, t, { dur: 0.6, f0: 2200, f1: 380, q: 0.9, peak: 0.08 * v, at: 0.3, pan0: 0.4 * p, pan1: 0.75 * p }); K.nsweep(room, t, { dur: 0.7, kind: 'white', type: 'highpass', f0: 6000, f1: 4000, peak: 0.012 * v, at: 0.4 }); },
      start: (t, v) => {
        K.play(room, 'creak', 0, t, { vel: 0.16 * v, variant: 1 });
        K.roll(t + 0.32, 0.42, 14, 22, (x, u) => K.tom(room, x, (0.12 + 0.3 * u) * v, 1.25));
        K.taiko(room, t + 0.76, 0.5 * v);
      },
      complete: (t, v) => {
        K.thump(room, t, { f0: 90, f1: 38, fdec: 0.25, dec: 0.9, vel: 0.5 * v }); K.hit(room, t, { type: 'lowpass', f: 700, q: 0.6, vel: 0.2 * v, dec: 0.12 });
        K.brass(wet, t + 0.02, [52, 56, 59, 64, 68], 0.55, { vel: 0.13 * v, a: 0.04, r: 0.9, bright: 0.85 });
        K.play(wet, 'bell', 76, t + 0.02, { vel: 0.17 * v }); K.crash(wet, t, 0.6 * v, 1.6);
      },
      unlock: (t, v) => { K.arp(wet, 'harp', GL, t, 0.045, (k) => (0.08 + 0.01 * k) * v); K.nsweep(wet, t, { dur: 0.7, kind: 'white', type: 'highpass', f0: 5000, f1: 9000, peak: 0.02 * v, at: 0.6 }); },
      intro: (t, v) => intro(t, v),
      impact: (t, v) => intro(t, v),
      riser: (t, v, o) => {
        const d = o.dur || 2.4;
        K.riseTones(room, t, [52, 59, 64], d, { vel: 0.14 * v, mult: 2, trem: [9, 18], cut: [500, 5000] });
        K.nsweep(room, t, { dur: d, kind: 'white', f0: 300, f1: 6000, q: 1.1, peak: 0.12 * v, rev: true });
        K.roll(t + d * 0.4, d * 0.6, 10, 22, (x, u) => K.timp(room, x, 40, (0.08 + 0.35 * u * u) * v));
      },
      step: (t, v) => K.play(dry, 'stepStone', 0, t, { vel: 0.14 * v, variant: (R() * 4) | 0, rate: 0.9 + R() * 0.2 }),
      stinger: (t, v) => { K.arp(wet, 'harp', GL, t, 0.04, 0.12 * v); K.play(wet, 'bell', 76, t + 0.3, { vel: 0.14 * v }); },
    },
  };
};

// ── Second Brain: warm pulsing analog synth over a heartbeat, MRI hum underneath; driving arpeggio at the light-up.
ENGINES['second-brain'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 45, v: [57, 60, 64, 67, 71] }, { b: 41, v: [53, 57, 60, 64, 67] }, { b: 36, v: [55, 59, 62, 64, 67] }, { b: 40, v: [52, 57, 59, 64, 69], v2: [52, 56, 59, 64, 68] },
  ]; // Am9 Fmaj9 Cmaj9 Esus4→E
  const ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 5, 4, 3, 2];
  const MEL = [[[0, 72, 6], [6, 76, 2], [8, 79, 8]], [[0, 77, 6], [6, 76, 2], [8, 72, 8]], [[0, 74, 6], [6, 76, 2], [8, 79, 6], [14, 81, 2]], [[0, 81, 8], [8, 80, 8]]];
  const dl = K.delay({ time: 0.375, fb: 0.3, cut: 2400, wet: 0.24 });
  const pad = K.ch({ pan: -0.15, send: 0.4 }), bass = K.ch({ send: 0.08, eq: [['highpass', 38, 0.7]] }), arpC = K.ch({ pan: 0.2, send: 0.25, to: dl.input });
  const arpDry = K.ch({ pan: 0.15, send: 0.2 }), lead = K.ch({ pan: -0.1, send: 0.45 }), drm = K.ch({ send: 0.18 }), mri = K.ch({ send: 0.3 });
  const hum = K.drone([['triangle', 33, 0, 1], ['sine', 45, 2, 0.5], [W.warm, 57, -3, 0.08]], { cut: 260, trem: 0.3 });
  const air = K.bed({ kind: 'pink', type: 'bandpass', f: 520, q: 0.6, rate: 0.07, depth: 0.5 });
  const dry = K.sfxCh({ send: 0.05 }), room = K.sfxCh({ send: 0.3 }), wet = K.sfxCh({ send: 0.55 });
  K.warm([[81], [88], [76], [74]].map(([n]) => ['glass', n]).concat([['crackle', 0, 0], ['crackle', 0, 1]]));
  const chime = (t, notes, v, gap = 0.08) => notes.forEach((n, k) => K.fm(wet, t + k * gap, n, { vel: 0.07 * v, dur: 1.6, ratio: 3.5, index: 1.2, pan: (k - 1) * 0.3 }));
  const intro = (t, v) => {
    K.subDrop(room, t, { f0: 70, f1: 30, dur: 1.6, vel: 0.6 * v }); K.kick(room, t, 0.8 * v);
    K.play(wet, 'crackle', 0, t, { vel: 0.12 * v, pan: -0.5 }); K.play(wet, 'crackle', 0, t + 0.03, { vel: 0.12 * v, pan: 0.5, variant: 1 });
    K.sustain(wet, t, [69, 72, 76, 79, 83], 1.2, { vel: 0.07 * v, a: 0.01, r: 1.2, wave: W.warm, cut: 5000, cutTo: 1200, cutTime: 0.4, vib: 0 });
    chime(t + 0.05, [81, 88, 93], v);
  };
  return {
    spb: 16,
    mix: { verb: { dur: 2.2, decay: 3, tone: 0.6, pre: 0.012 }, verbLevel: 0.45, level: 0.9, sfxLevel: 1 },
    trim: { hover: 0.8, select: 0.7, back: 0.7, zoomIn: 1.3, start: 0.8, complete: 0.9, unlock: 1.4, riser: 2.4 },
    stepDur: (i) => 60 / (84 + 36 * i) / 4,
    update(now, i) {
      hum.gain.setTargetAtTime(0.03 * (1 - 0.4 * i), now, 0.5); hum.filter.frequency.setTargetAtTime(220 + 260 * i, now, 0.5);
      air.gain.setTargetAtTime(0.018 * (1 - 0.5 * i), now, 0.5);
      dl.setTime((60 / (84 + 36 * i)) * 0.75, now);
    },
    step(t, s, bar, i, sd) {
      const ph = bar % 4, c = P[ph], barDur = sd * 16, v = c.v2 && s >= 8 ? c.v2 : c.v;
      if (s === 0 || (s === 8 && c.v2)) {
        const d = (c.v2 ? barDur / 2 : barDur) * 1.06, cut = 420 + 1600 * i;
        K.sustain(pad, t, v, d, { vel: 0.032 + 0.06 * i, a: s === 8 ? 0.25 : 0.9, r: 1.3, cut, cutTo: cut * 1.7, cutTime: d * 0.4, q: 2.2, wave: W.warm, det: 12, vib: 0.05, vibRate: 0.35 });
      }
      const hb = 1 - ramp(0.55, 0.68, i);
      if (hb > 0 && s % 4 === 0) K.heart(drm, t, 0.55 * hb);
      const kn = 1 - ramp(0.3, 0.5, i);
      if (kn > 0 && s % 2 === 0) K.hit(mri, t, { f: 240, q: 3, vel: (s % 4 === 0 ? 0.09 : 0.05) * kn, dec: 0.05 });
      const bp = ramp(0.22, 0.32, i);
      if (bp && (s % 2 === 0 || i > 0.62)) K.sbass(bass, t, c.b + ((s === 6 || s === 14) && i > 0.5 ? 12 : 0), { vel: K.hv(0.11 * bp * (s % 4 === 0 ? 1 : 0.75), 0.1), len: sd * (s % 2 ? 0.9 : 1.6), cut: 260 + 800 * i });
      const ar = ramp(0.42, 0.52, i);
      if (ar) {
        const T = v.concat(v.map((n) => n + 12)), n = T[Math.min(T.length - 1, ARP[s] + (i > 0.78 && s >= 8 ? 3 : 0))];
        const o = { vel: K.hv(0.055 * ar * (s % 4 === 0 ? 1.15 : 0.9), 0.1), len: sd * 0.85, cut: 700 + 3600 * i };
        K.apl(arpC, t, n, o);
        if (i > 0.7) K.apl(arpDry, t, n + 12, { ...o, vel: o.vel * 0.35 });
      }
      const kk = ramp(0.6, 0.68, i);
      if (kk && s % 4 === 0) K.kick(drm, t, 0.9 * kk);
      if (i > 0.68 && s % 4 === 2) K.hat(drm, t, 0.9);
      if (i > 0.86 && s % 2 === 1) K.hat(drm, t, 0.35);
      if (i > 0.74 && (s === 4 || s === 12)) K.clap(drm, t, 0.7);
      const ld = ramp(0.8, 0.9, i);
      if (ld) for (const [st, n, len] of MEL[ph]) if (st === s) K.fm(lead, t, n, { vel: 0.06 * ld, dur: len * sd * 1.4 + 0.5, ratio: 2, index: 0.9 });
    },
    sfx: {
      hover: (t, v) => { const r = 0.92 + R() * 0.16; K.hit(dry, t, { f: 2200 * r, q: 2, vel: 0.05 * v, dec: 0.012 }); K.tsweep(dry, t, { f0: 900 * r, f1: 700 * r, dur: 0.04, peak: 0.03 * v }); },
      select: (t, v) => { K.play(room, 'glass', 81, t, { vel: 0.12 * v }); K.play(room, 'glass', 88, t + 0.05, { vel: 0.08 * v }); },
      back: (t, v) => { K.play(room, 'glass', 76, t, { vel: 0.08 * v }); K.play(room, 'glass', 74, t + 0.05, { vel: 0.05 * v }); },
      zoomIn: (t, v) => { K.nsweep(room, t, { dur: 0.42, f0: 600, f1: 4000, q: 1.6, peak: 0.1 * v, at: 0.75 }); K.tsweep(wet, t + 0.1, { f0: 2400, f1: 3600, dur: 0.3, peak: 0.008 * v, wave: 'triangle' }); },
      zoomOut: (t, v) => { K.nsweep(room, t, { dur: 0.5, f0: 3500, f1: 500, q: 1.4, peak: 0.09 * v, at: 0.3 }); K.tsweep(room, t, { f0: 300, f1: 120, dur: 0.4, peak: 0.05 * v }); },
      start: (t, v) => {
        K.riseTones(room, t, [45, 52], 0.9, { vel: 0.12 * v, mult: 2, wave: W.warm, trem: [6, 22], cut: [300, 2600] });
        K.nsweep(room, t, { dur: 0.9, kind: 'white', f0: 800, f1: 5000, q: 2, peak: 0.03 * v, rev: true });
      },
      complete: (t, v) => {
        K.thump(room, t, { f0: 80, f1: 40, dec: 0.5, vel: 0.4 * v }); K.tsweep(room, t, { f0: 1800, f1: 120, dur: 0.22, peak: 0.06 * v, glide: 0.8 });
        K.hit(room, t, { f: 3000, q: 0.8, vel: 0.1 * v, dec: 0.25 }); K.play(wet, 'crackle', 0, t, { vel: 0.1 * v });
        chime(t + 0.08, [84, 88, 93], v);
      },
      unlock: (t, v) => { K.fm(wet, t, 88, { vel: 0.05 * v, dur: 0.9, index: 1 }); K.fm(wet, t + 0.09, 93, { vel: 0.045 * v, dur: 1.1, index: 1 }); K.hit(dry, t, { f: 4200, q: 1.5, vel: 0.03 * v, dec: 0.02 }); },
      riser: (t, v, o) => {
        const d = o.dur || 2.2;
        K.riseTones(room, t, [45, 57], d, { vel: 0.08 * v, mult: 4, wave: W.warm, trem: [3, 14], cut: [300, 4000] });
        K.nsweep(room, t, { dur: d, kind: 'white', f0: 400, f1: 5000, q: 5, peak: 0.08 * v, rev: true });
      },
      intro: (t, v) => intro(t, v),
      impact: (t, v) => intro(t, v),
      step: (t, v) => K.tsweep(room, t, { f0: K.midi([69, 72, 76, 81][(R() * 4) | 0]), dur: 0.05, peak: 0.028 * v, wave: 'triangle' }),
      stinger: (t, v) => chime(t, [84, 88, 93], v),
    },
  };
};

// ── Uncharted: 6/8 seafaring adventure in D Mixolydian. Low strings, frame drum + shaker, warm pad, ocean wash.
ENGINES['uncharted'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 38, v: [50, 57, 62, 66] }, { b: 36, v: [48, 55, 60, 64] }, { b: 43, v: [50, 55, 59, 62] }, { b: 38, v: [50, 57, 62, 66] },
    { b: 47, v: [50, 54, 59, 62] }, { b: 43, v: [50, 55, 59, 62] }, { b: 40, v: [50, 55, 59, 64] }, { b: 45, v: [50, 57, 62, 64], v2: [49, 57, 61, 64] },
  ]; // D C G D | Bm G Em7 Asus4→A
  const MEL = [[[0, 69, 6], [6, 74, 6]], [[0, 76, 4], [4, 74, 2], [6, 72, 6]], [[0, 71, 6], [6, 74, 6]], [[0, 69, 12]],
    [[0, 78, 6], [6, 76, 4], [10, 74, 2]], [[0, 74, 4], [4, 71, 2], [6, 74, 6]], [[0, 76, 6], [6, 79, 6]], [[0, 81, 12]]];
  const H8 = [0, 1, 2, 3, 2, 1], CEL = [0, 7, 12, 7, 12, 7];
  const low = K.ch({ send: 0.25, eq: [['lowpass', 1300, 0.5]] }), pad = K.ch({ pan: -0.2, send: 0.55 }), harp = K.ch({ pan: 0.3, send: 0.5 });
  const cel = K.ch({ pan: -0.25, send: 0.3 }), lead = K.ch({ pan: 0.05, send: 0.6 }), horn = K.ch({ pan: 0.25, send: 0.55 }), perc = K.ch({ send: 0.3 }), timpC = K.ch({ send: 0.45 });
  const seaL = K.bed({ kind: 'brown', f: 520, pan: -0.6, rate: 0.083, depth: 0.8 }), seaR = K.bed({ kind: 'brown', f: 650, pan: 0.6, rate: 0.11, depth: 0.8 });
  const dry = K.sfxCh({ send: 0.06 }), room = K.sfxCh({ send: 0.32 }), wet = K.sfxCh({ send: 0.65 }), far = K.sfxCh({ send: 0.9, eq: [['lowpass', 2600, 0.6]] });
  const GL = [74, 76, 78, 81, 83, 86, 88, 90];
  K.warm([...new Set(P.flatMap((c) => c.v.map((n) => n + 12)).concat(GL))].map((n) => ['harp', n]).concat([0, 1, 2, 3].map((v) => ['droplet', 0, v]), [['wood', 79], ['paper', 0, 0], ['splash', 0, 0], ['creak', 0, 0], ['bell', 69]]));
  const hitOrch = (t, v) => {
    K.brass(wet, t, [38, 50, 57, 62, 66], 0.8, { vel: 0.17 * v, a: 0.04, r: 1.0, bright: 0.85 }); K.sustain(wet, t, [62, 66, 69, 74], 0.7, { vel: 0.1 * v, a: 0.02, r: 1.0, cut: 4500 });
    K.timp(room, t, 38, 0.9 * v); K.crash(wet, t, 1.2 * v, 2.4);
  };
  return {
    spb: 12,
    mix: { verb: { dur: 4.2, decay: 2.4, tone: 0.5, pre: 0.03 }, verbLevel: 0.55, level: 0.7, sfxLevel: 1 },
    trim: { hover: 0.3, select: 0.36, back: 0.45, zoomIn: 0.3, zoomOut: 0.45, start: 0.5, complete: 0.7, unlock: 0.5, riser: 0.65, step: 0.28, peek: 0.65 },
    gap: { step: 0.35 },
    stepDur: (i) => 60 / (54 + 14 * i) / 6,
    update(now, i) { const g = 0.05 * (1 - 0.3 * i); seaL.gain.setTargetAtTime(g, now, 0.8); seaR.gain.setTargetAtTime(g, now, 0.8); },
    step(t, s, bar, i, sd) {
      const ph = bar % 8, c = P[ph], barDur = sd * 12, v = c.v2 && s >= 6 ? c.v2 : c.v;
      if (s === 0 || (s === 6 && c.v2)) {
        const d = (c.v2 ? barDur / 2 : barDur) * 1.08;
        if (s === 0) K.sustain(low, t, [c.b - 12, c.b], barDur * 1.06, { vel: 0.06 + 0.06 * i, a: 0.5, r: 1.0, cut: 420 + 600 * i, vib: 0.04 });
        K.sustain(pad, t, v, d, { vel: 0.03 + 0.05 * i, a: 1.1, r: 1.6, cut: 800 + 1600 * i, wave: W.warm, vib: 0.06, det: 10 });
        const hr = ramp(0.76, 0.9, i);
        if (hr) K.brass(horn, t, v, d, { vel: 0.05 * hr, a: d * 0.5, bright: 0.5 + 0.4 * i });
      }
      const hp = ramp(0.1, 0.22, i);
      if (hp) {
        if (s === 0) K.frame(perc, t, 0.75 * hp);
        if (s === 6) K.frame(perc, t, 0.5 * hp);
        if (i > 0.35 && s === 10) K.frame(perc, t, 0.2 * hp, 0.05);
        if (i > 0.25 && s % 2 === 0) K.shaker(perc, K.jit(t, 0.004), (s % 6 === 0 ? 0.8 : 0.45) * ramp(0.25, 0.35, i));
        if (i > 0.6 && s % 2 === 1) K.shaker(perc, t, 0.25);
        if (i > 0.55 && (s === 3 || s === 4 || s === 9)) K.bongo(perc, t, 0.55 * ramp(0.55, 0.65, i), s !== 4);
      }
      const hl = ramp(0.3, 0.42, i);
      if (hl && (s % 2 === 0 || i > 0.62)) {
        const T = v.map((n) => n + 12), k = H8[s >> 1], n = s % 2 ? T[(k + 2) % T.length] : T[k];
        K.play(harp, 'harp', n, K.jit(t), { vel: K.hv((s % 2 ? 0.1 : 0.17) * hl) });
      }
      const co = ramp(0.55, 0.65, i);
      if (co && s % 2 === 0) K.spic(cel, t, c.b + CEL[s >> 1], { vel: K.hv(0.07 * co), len: sd * 2.2, cut: 900 + 900 * i });
      if (i > 0.62 && s === 0 && ph % 4 === 0) K.timp(timpC, t, c.b > 40 ? c.b - 12 : c.b, 0.6);
      if (i > 0.7 && ph === 7 && s >= 6) { K.timp(timpC, t, 33, 0.12 + 0.06 * (s - 6)); K.timp(timpC, t + sd / 2, 33, 0.12 + 0.06 * (s - 6)); }
      if (i > 0.82 && ph === 7 && s === 0) K.revCym(perc, t, barDur, 0.9);
      if (i > 0.82 && ph === 0 && s === 0) K.crash(perc, t, 0.8);
      const ld = ramp(0.68, 0.8, i);
      if (ld) for (const [st, n, len] of MEL[ph]) if (st === s) {
        K.sustain(lead, t, [n], len * sd * 1.02, { vel: 0.07 * ld, a: 0.15, r: 0.6, cut: 3000, vib: 0.16, voices: 3, det: 9 });
        if (i > 0.84) K.brass(horn, t, [n - 12], len * sd, { vel: 0.04, a: 0.15, bright: 0.5 });
      }
    },
    sfx: {
      hover: (t, v) => K.play(room, 'droplet', 0, t, { vel: 0.07 * v, variant: (R() * 4) | 0, rate: 0.95 + R() * 0.1 }),
      select: (t, v) => { K.play(room, 'wood', 79, t, { vel: 0.2 * v }); K.thump(dry, t, { f0: 200, f1: 120, vel: 0.06 * v, dec: 0.05 }); },
      back: (t, v) => K.play(dry, 'paper', 0, t, { vel: 0.13 * v, rate: 0.85 }),
      zoomIn: (t, v) => {
        K.nsweep(room, t, { dur: 0.55, type: 'lowpass', f0: 300, f1: 2200, q: 1.5, peak: 0.12 * v, at: 0.6 });
        K.thump(room, t + 0.38, { f0: 140, f1: 70, dec: 0.08, vel: 0.1 * v }); K.hit(room, t + 0.38, { f: 600, vel: 0.05 * v, dec: 0.06 });
      },
      zoomOut: (t, v) => K.nsweep(room, t, { dur: 0.7, type: 'lowpass', f0: 2000, f1: 300, q: 1.2, peak: 0.1 * v, at: 0.25, pan0: -0.5, pan1: 0.5 }),
      peek: (t, v) => { [86, 90, 93, 95].forEach((n, k) => K.play(wet, 'celesta', n, t + k * 0.13 + R() * 0.04, { vel: 0.035 * v, pan: (R() - 0.5) * 0.8 })); K.nsweep(wet, t, { dur: 1.0, kind: 'white', type: 'highpass', f0: 4000, f1: 8000, peak: 0.02 * v, at: 0.5 }); },
      step: (t, v) => { K.play(room, 'splash', 0, t, { vel: 0.2 * v, rate: 0.9 + R() * 0.2 }); K.play(room, 'creak', 0, t + 0.08, { vel: 0.08 * v, rate: 0.9 + R() * 0.2 }); },
      start: (t, v) => { K.play(room, 'creak', 0, t, { vel: 0.13 * v, rate: 1.15 }); [62, 64, 66, 69].forEach((n, k) => K.spic(room, t + 0.12 + k * 0.05, n, { vel: 0.07 * v, len: 0.12, cut: 2200 })); K.sustain(room, t + 0.32, [69, 74], 0.5, { vel: 0.08 * v, a: 0.04, r: 0.5, cut: 3000 }); },
      complete: (t, v) => {
        K.nsweep(room, t, { dur: 1.6, f0: 300, f1: 2500, q: 0.6, peak: 0.14 * v, at: 0.45, pan0: -0.6, pan1: 0.6 });
        K.sustain(wet, t + 0.2, [50, 57, 62, 66, 69, 74], 1.8, { vel: 0.12 * v, a: 0.6, r: 1.4, cut: 1500, cutTo: 4500 });
        K.brass(wet, t + 0.3, [50, 57, 62, 66], 1.6, { vel: 0.08 * v, a: 0.7, bright: 0.8 });
        K.arp(wet, 'harp', GL, t + 0.8, 0.05, (k) => (0.08 + 0.01 * k) * v);
      },
      unlock: (t, v) => K.play(far, 'bell', 69, t, { vel: 0.2 * v }),
      riser: (t, v, o) => {
        const d = o.dur || 0.95; // the intro's cloud cover gathers for ~1 s before it bursts
        K.roll(t, d, 10, 22, (x, u) => K.timp(room, x, 38, (0.08 + 0.35 * u * u) * v));
        K.riseTones(room, t, [50, 57, 62], d, { vel: 0.12 * v, mult: 1.5, trem: [12, 18], cut: [600, 3500] });
      },
      intro: (t, v) => {
        hitOrch(t, v);
        K.nsweep(room, t + 0.25, { dur: 2.2, f0: 400, f1: 1600, q: 0.6, peak: 0.12 * v, at: 0.35, pan0: -0.6, pan1: 0.6 });
        K.sustain(far, t, [38, 38.1], 2.0, { wave: W.reed, vel: 0.18 * v, a: 0.3, r: 0.9, cut: 700, voices: 2, det: 6, vib: 0.03, vibRate: 0.6, glide: 30 });
      },
      impact: (t, v) => hitOrch(t, v),
      stinger: (t, v) => K.arp(wet, 'harp', GL, t, 0.05, 0.12 * v),
    },
  };
};

// ── Origin Story (underwater trailer, D minor). opts.recap = tighter, punchier arrangement for Weekly Recap.
// The whole score sits behind a low-pass "depth" filter that opens as intensity rises (surfacing).
ENGINES['origin-story'] = (K, opts = {}) => {
  const { W, R, ramp } = K;
  const recap = opts.variant === 'recap';
  const P = [
    { b: 38, v: [50, 57, 62, 65] }, { b: 34, v: [50, 53, 58, 62] }, { b: 41, v: [53, 57, 60, 65] }, { b: 36, v: [52, 55, 60, 64] },
    { b: 38, v: [50, 57, 62, 65] }, { b: 34, v: [50, 53, 58, 62] }, { b: 43, v: [50, 55, 58, 62] }, { b: 45, v: [50, 57, 62, 64], v2: [49, 57, 61, 64] },
  ]; // Dm Bb F C | Dm Bb Gm Asus4→A
  const PUL = [0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 12, 0, 12], ACC = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const sh = recap ? -0.12 : 0; // recap: every layer enters a little earlier
  const depth = K.stage('lowpass', 300, 0.8);
  const C = (o) => K.ch({ ...o, to: depth });
  const low = C({ send: 0.2, eq: [['lowpass', 1600, 0.5]] }), str = C({ pan: -0.25, send: 0.45 }), brs = C({ pan: 0.28, send: 0.5 }), cho = C({ pan: -0.1, send: 0.6 });
  const syn = C({ pan: 0.12, send: 0.15, eq: [['highpass', 50, 0.7]] }), perc = C({ send: 0.22 }), tko = C({ send: recap ? 0.3 : 0.42 }), whale = C({ pan: -0.35, send: 0.85 }), bub = C({ pan: 0.3, send: 0.5 });
  const sub = K.drone([['sine', 26, 0, 0.5], [W.strings, 38, -5, 0.5], [W.strings, 38, 6, 0.5], [W.strings, 45, 3, 0.2]], { cut: 260, dest: depth, trem: 0.2 });
  const dry = K.sfxCh({ send: 0.06 }), room = K.sfxCh({ send: 0.32 }), wet = K.sfxCh({ send: 0.65 });
  const deep = K.sfxCh({ send: 0.45, eq: [['lowpass', 900, 0.7]] });
  const STEP = [74, 77, 79, 81, 84, 86, 89, 91];
  let stepK = 0;
  K.warm([...new Set([...STEP, 62, 65, 69, 74, 78, 81, 86, 90, 93, 98, 100])].flatMap((n) => [['bubble', n], ['celesta', n]]).concat([['bubbles', 0, 0], ['bubbles', 0, 1], ['bell', 86], ['chime', 93], ['wood', 93]]));
  const bubbles = (dest, t, v, n = 5, span = 0.5, base = 74) => { for (let k = 0; k < n; k++) K.play(dest, 'bubble', base + ((R() * 14) | 0), t + R() * span, { vel: (0.05 + R() * 0.05) * v, pan: (R() - 0.5) * 1.2 }); };
  const whaleCall = (t, n, dur, v) => K.sustain(whale, t, [n, n + 0.07], dur, { wave: W.brass, vel: 0.07 * v, a: dur * 0.35, r: dur * 0.4, cut: 650, q: 1.4, voices: 2, det: 10, vib: 0.25, vibRate: 0.9, glide: -500 });
  const braam = (t, v) => {
    K.subDrop(room, t, { f0: 64, f1: 26, dur: 2.8, vel: 0.7 * v });
    K.brass(room, t, [38, 45, 50, 53, 57], 1.8, { vel: 0.22 * v, a: 0.03, r: 1.0, bright: 0.95 });
    K.taiko(room, t, 1.3 * v); K.crash(wet, t, 1.4 * v, 3);
    // the surface breaks: bright major bloom, air and a splash of shimmer
    K.sustain(wet, t + 0.05, [62, 66, 69, 74, 78], 2.4, { vel: 0.13 * v, a: 0.5, r: 1.6, cut: 2000, cutTo: 7000, cutTime: 0.8 });
    K.choir(wet, t + 0.05, [62, 66, 69, 74], 2.4, { vel: 0.1 * v, a: 0.6, r: 1.6, vowel: 'ah' });
    K.nsweep(wet, t, { dur: 1.2, kind: 'white', type: 'highpass', f0: 2500, f1: 7000, peak: 0.08 * v, at: 0.08 });
    K.arp(wet, 'celesta', [86, 90, 93, 98, 100, 102], t + 0.15, 0.05, (k) => (0.05 + 0.006 * k) * v, { pan: 0.3 });
    bubbles(wet, t + 0.05, v, 8, 0.8, 79);
  };
  const titleHit = (t, v) => {
    K.subDrop(room, t, { f0: 58, f1: 32, dur: 1.1, vel: 0.55 * v }); K.taiko(room, t, 0.9 * v);
    K.brass(deep, t, [38, 50, 57, 62, 65], 0.35, { vel: 0.2 * v, a: 0.02, r: 0.6, bright: 0.9 });
    K.hit(room, t, { type: 'lowpass', f: 1200, f1: 200, q: 0.5, vel: 0.15 * v, dec: 0.6 });
  };
  const bpm = (i) => (recap ? 86 + 46 * i : 70 + 62 * i);
  return {
    spb: 16,
    mix: { verb: { dur: recap ? 2.6 : 3.4, decay: 2.6, tone: 0.45, pre: 0.02 }, verbLevel: 0.5, level: recap ? 0.7 : 0.73, sfxLevel: 1 },
    trim: { hover: 0.8, start: 0.4, complete: 0.7, unlock: 1.8, riser: 0.8, whoosh: 0.45, step: 0.5, sonar: 1.4 },
    stepDur: (i) => 60 / bpm(i) / 4,
    update(now, i) {
      // deep and muffled → bright at the surface
      depth.frequency.setTargetAtTime(Math.min(16000, (recap ? 520 : 300) * Math.pow(2, Math.pow(i, 0.4) * 5.8)), now, 0.35);
      sub.gain.setTargetAtTime(0.1 - 0.045 * ramp(0.1, 0.5, i), now, 0.6);
    },
    step(t, s, bar, i, sd) {
      const ph = bar % 8, c = P[ph], barDur = sd * 16, v = c.v2 && s >= 8 ? c.v2 : c.v;
      const hb = (1 - ramp(0.012, 0.035, i)) + ramp(0.15 + sh, 0.22 + sh, i) * (1 - ramp(0.6 + sh, 0.7 + sh, i));
      if (hb > 0.01 && s % 4 === 0) K.heart(perc, t, 0.8 * Math.min(1, hb));
      if (s === 0 || (s === 8 && c.v2)) {
        const d = (c.v2 ? barDur / 2 : barDur) * 1.06, pd = ramp(0.32 + sh, 0.42 + sh, i);
        if (pd) K.sustain(str, t, v, d, { vel: (0.05 + 0.04 * i) * pd, a: 0.5, r: 0.9, cut: 900 + 2400 * i });
        const br = ramp(0.76 + sh, 0.86 + sh, i);
        if (br) K.brass(brs, t, v.map((n) => n - 12), d, { vel: 0.08 * br, a: d * 0.5, bright: 0.6 + 0.35 * i });
        const chv = ramp(0.84 + sh, 0.92 + sh, i);
        if (chv) K.choir(cho, t, v.map((n) => n + 12), d, { vel: 0.06 * chv, a: 0.6, r: 1.0, vowel: 'ah' });
        if (s === 0 && i > 0.74 + sh && ph % 4 === 0) K.subDrop(perc, t, { f0: 58, f1: 30, dur: 1.2, vel: 0.4 });
        // whale-like low swells between the hits
        if (s === 0 && ph % 2 === 1 && i > 0.2 + sh && i < 0.93) whaleCall(t + barDur * 0.1, c.b + 12 + (R() < 0.5 ? 7 : 0), barDur * 1.6, 0.7 + 0.5 * i);
        if (s === 0 && i > 0.1 && R() < 0.6) bubbles(bub, t + R() * barDur * 0.5, 0.5 + 0.5 * i, 2 + ((R() * 3) | 0), 0.4);
      }
      const pl = ramp(0.16 + sh, 0.26 + sh, i);
      if (pl && (s % 2 === 0 || i > 0.5 + sh)) K.spic(low, K.jit(t, 0.003), (c.b < 40 ? c.b + 12 : c.b) + PUL[s], { vel: K.hv((0.07 + 0.05 * ACC[s]) * pl, 0.1), len: sd * (i > 0.5 ? 0.9 : 1.6), cut: 700 + 1600 * i });
      const wp = ramp(0.36 + sh, 0.42 + sh, i) * (1 - ramp(0.64 + sh, 0.7 + sh, i));
      if (wp && (s === 0 || s === 8 || (recap && (s === 4 || s === 12)))) K.kick(perc, t, 0.65 * wp);
      const sp = ramp(0.56 + sh, 0.66 + sh, i);
      if (sp) K.sbass(syn, t, c.b > 40 ? c.b - 12 : c.b, { vel: K.hv(0.08 * sp * (ACC[s] ? 1 : 0.65), 0.08), len: sd * 0.8, cut: 300 + 1200 * i });
      const tk = ramp(0.64 + sh, 0.72 + sh, i);
      if (tk) {
        if (s === 0 || s === 6 || s === 12) K.taiko(tko, t, tk * (s === 0 ? 1 : 0.8));
        if (s === 8 || s === 14) K.taiko(tko, t, tk * 0.45, 1.3);
        if (recap && (s === 4 || s === 12)) K.clap(perc, t, 0.6 * tk);
        if (ph % 2 === 1 && s >= 12) K.tom(perc, t, tk * (0.4 + 0.12 * (s - 12)), 1.5 - 0.12 * (s - 12));
      }
      if (i > 0.74 + sh && s % 2 === 1) K.hat(perc, t, 0.6);
      if (i > 0.9 + sh / 2 && s % 2 === 0) K.spic(str, t, v[s % 4 === 0 ? 2 : 3] + 12, { vel: 0.04, len: sd * 0.9, cut: 3500 });
      if (i > 0.84 + sh && ph === 7 && s === 8) K.revCym(perc, t, barDur / 2, 1);
      if (i > 0.84 + sh && ph === 0 && s === 0) K.crash(perc, t, 0.8);
    },
    sfx: {
      whoosh: (t, v) => { K.nsweep(room, t, { dur: 0.42, kind: 'brown', type: 'lowpass', f0: 250, f1: 1600, q: 1.6, peak: 0.24 * v, at: 0.6, pan0: -0.3, pan1: 0.3 }); K.play(room, 'bubbles', 0, t + 0.08, { vel: 0.05 * v, rate: 1.3 }); },
      intro: (t, v) => titleHit(t, v),
      impact: (t, v) => braam(t, v),
      sonar: (t, v) => {
        // a clean pitched ping, then watery echoes (recap: one echo, ~0.6 s)
        for (const [dt, a] of recap ? [[0, 1], [0.24, 0.25]] : [[0, 1], [0.36, 0.32], [0.72, 0.12]]) K.tsweep(wet, t + dt, { f0: 1175 * 1.012, f1: 1175, dur: recap ? 0.32 : 0.55, peak: 0.08 * a * v, a: 0.002, glide: 0.2, pan: dt ? (dt > 0.5 ? 0.4 : -0.4) : 0 });
        K.tsweep(wet, t, { f0: 2350, dur: 0.12, peak: 0.012 * v });
      },
      step: (t, v) => { const n = STEP[stepK++ % STEP.length]; K.play(dry, 'bubble', n, t, { vel: 0.1 * v }); K.hit(dry, t, { f: 3000, q: 2, vel: 0.02 * v, dec: 0.01 }); },
      riser: (t, v, o) => {
        const d = o.dur || 2.2;
        K.nsweep(room, t, { dur: d, kind: 'white', f0: 250, f1: 6000, q: 1.2, peak: 0.13 * v, rev: true });
        K.riseTones(room, t, [38, 45, 50], d, { vel: 0.11 * v, mult: 2.5, wave: W.warm, trem: [6, 20], cut: [300, 5000] });
        K.revCym(room, t, d, 0.9 * v);
        K.roll(t, d, 4, 26, (x, u) => K.play(wet, 'bubble', Math.round(70 + u * 22 + R() * 6), x, { vel: (0.04 + 0.06 * u) * v, pan: (R() - 0.5) }));
      },
      hover: (t, v) => (recap ? K.play(dry, 'wood', 93, t, { vel: 0.035 * v, rate: 0.97 + R() * 0.06 }) : K.play(dry, 'bubble', 88 + ((R() * 3) | 0), t, { vel: 0.035 * v })),
      select: (t, v) => { K.play(dry, 'bubble', 79, t, { vel: 0.07 * v }); K.play(dry, 'bubble', 86, t + 0.05, { vel: 0.06 * v }); },
      back: (t, v) => { K.play(dry, 'bubble', 86, t, { vel: 0.06 * v }); K.play(dry, 'bubble', 79, t + 0.05, { vel: 0.05 * v }); },
      start: (t, v) => { K.play(room, 'bubbles', 0, t, { vel: 0.12 * v }); K.sustain(room, t, [50, 57, 62, 65], 0.8, { vel: 0.09 * v, a: 0.75, r: 0.12, cut: 900, cutTo: 2600, cutTime: 0.4 }); },
      complete: (t, v) => {
        K.arp(wet, 'celesta', [74, 78, 81, 86, 90], t, 0.06, (k) => (0.12 + 0.01 * k) * v); K.play(wet, 'bell', 86, t + 0.3, { vel: 0.11 * v });
        K.taiko(room, t, 0.45 * v); K.crash(wet, t, 0.5 * v, 1.4); K.play(room, 'bubbles', 0, t + 0.05, { vel: 0.12 * v, variant: 1 });
      },
      unlock: (t, v) => {
        [93, 98, 100].forEach((n, k) => K.play(wet, 'chime', n, t + k * 0.07, { vel: 0.04 * v }));
        K.nsweep(wet, t, { dur: 0.8, kind: 'white', type: 'highpass', f0: 5000, f1: 9000, peak: 0.016 * v, at: 0.5 });
        const g = 2600 + R() * 400; // a stylised dolphin chirp
        K.tsweep(room, t + 0.12, { f0: g, f1: g * 1.6, dur: 0.12, peak: 0.016 * v, wave: 'sine', glide: 0.9 });
        K.tsweep(room, t + 0.22, { f0: g * 1.5, f1: g * 1.1, dur: 0.1, peak: 0.012 * v, glide: 0.9 });
      },
      stinger: (t, v) => K.arp(wet, 'celesta', [74, 78, 81, 86, 90], t, 0.06, 0.12 * v),
    },
  };
};

// ── Living Tree: warm, organic, hopeful D major ~84 bpm. Nylon guitar, marimba, string swells, cello drone.
ENGINES['living-tree'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 38, v: [50, 57, 62, 64, 66] }, { b: 38, v: [50, 55, 59, 62, 67] }, { b: 47, v: [47, 54, 57, 62, 66] }, { b: 43, v: [43, 50, 57, 59, 62] },
    { b: 42, v: [42, 50, 57, 62, 66] }, { b: 40, v: [40, 47, 50, 55, 62] }, { b: 43, v: [43, 50, 54, 59, 62] }, { b: 45, v: [45, 52, 57, 62, 64], v2: [45, 52, 57, 61, 64] },
  ]; // Dadd9 G/D Bm7 Gadd9 | D/F# Em7 Gmaj7 Asus4→A (all sit on the D cello pedal)
  const MEL = [[[0, 78, 6], [6, 76, 2], [8, 74, 8]], [[0, 74, 6], [6, 71, 2], [8, 67, 8]], [[0, 69, 6], [6, 71, 2], [8, 74, 8]], [[0, 76, 8], [8, 74, 8]],
    [[0, 78, 8], [8, 81, 8]], [[0, 79, 6], [6, 78, 2], [8, 76, 8]], [[0, 74, 4], [4, 76, 4], [8, 78, 8]], [[0, 76, 8], [8, 73, 8]]];
  const TRAVIS = [0, null, 3, null, 1, null, 4, null, 0, null, 2, null, 1, null, 3, null];
  const MAR = { 3: 2, 6: 3, 10: 4, 14: 3 }, KAL = [86, 88, 90, 93, 95];
  const gtr = K.ch({ pan: -0.18, send: 0.3, eq: [['peaking', 220, 1, 3], ['highshelf', 5000, 0.7, -4]] }), str = K.ch({ pan: 0.25, send: 0.5 });
  const mar = K.ch({ pan: 0.3, send: 0.32 }), kal = K.ch({ pan: -0.35, send: 0.5 }), perc = K.ch({ send: 0.22 }), lead = K.ch({ pan: 0.05, send: 0.55 });
  const cello = K.drone([[W.strings, 38, -4, 1], [W.strings, 38, 5, 1], [W.strings, 45, 2, 0.45], ['sine', 26, 0, 0.4]], { cut: 520, trem: 0.25 });
  const breeze = K.bed({ kind: 'pink', type: 'bandpass', f: 1800, q: 0.5, rate: 0.06, depth: 0.7 });
  const dry = K.sfxCh({ send: 0.06 }), room = K.sfxCh({ send: 0.3 }), wet = K.sfxCh({ send: 0.6 });
  K.warm([...new Set(P.flatMap((c) => c.v.concat(c.v2 || [])))].map((n) => ['guitar', n]).concat([62, 66, 69, 74, 76, 78, 81, 86].map((n) => ['marimba', n]), KAL.map((n) => ['kalimba', n]), [0, 1, 2, 3].map((v) => ['rustle', 0, v])));
  const rustles = (dest, t, v, n, span) => { for (let k = 0; k < n; k++) K.play(dest, 'rustle', 0, t + (span * k) / n + R() * 0.03, { vel: v, variant: (R() * 4) | 0, rate: 0.85 + R() * 0.3 }); };
  const bloom = (t, v) => {
    K.sustain(wet, t, [50, 57, 62, 66, 69, 76], 2.6, { vel: 0.14 * v, a: 0.5, r: 2.0, cut: 1400, cutTo: 3200 });
    K.arp(wet, 'marimba', [62, 66, 69, 74, 78, 81], t, 0.05, 0.16 * v); K.arp(room, 'guitar', [50, 57, 62, 66, 69], t, 0.025, 0.2 * v);
  };
  return {
    spb: 16,
    mix: { verb: { dur: 2.6, decay: 3, tone: 0.55, pre: 0.015 }, verbLevel: 0.45, level: 0.94, sfxLevel: 1 },
    trim: { hover: 0.45, select: 0.33, back: 0.33, start: 0.5, complete: 1.7, unlock: 0.75, step: 0.55 },
    stepDur: (i) => 60 / (80 + 8 * i) / 4,
    update(now, i) { cello.gain.setTargetAtTime(0.05 * (1 - 0.2 * i), now, 0.6); breeze.gain.setTargetAtTime(0.012 + 0.012 * i, now, 0.8); },
    step(t, s, bar, i, sd) {
      const ph = bar % 8, c = P[ph], barDur = sd * 16, v = c.v2 && s >= 8 && i > 0.4 ? c.v2 : c.v;
      if (i < 0.2) {
        if (s === 0) K.arp(gtr, 'guitar', v, t, 0.07, (k) => K.hv(0.16 + 0.02 * k));
        if (i > 0.08 && s === 8) K.play(gtr, 'guitar', v[3], t, { vel: 0.15 });
      } else {
        const k = TRAVIS[s];
        if (k != null) K.play(gtr, 'guitar', v[k], K.jit(t, 0.008), { vel: K.hv((k <= 1 ? 0.27 : 0.2) * (0.85 + 0.3 * i)) });
        if (i > 0.66 && s % 2 === 1 && R() < 0.3) K.play(gtr, 'guitar', v[2 + ((R() * 3) | 0)], t, { vel: 0.1 });
      }
      if (s === 0 || (s === 8 && c.v2 && i > 0.4)) {
        const sw = ramp(0.28, 0.42, i), d = (s === 8 || (c.v2 && i > 0.4) ? barDur / 2 : barDur) * 1.06;
        if (sw) K.sustain(str, t, v.slice(2).map((n) => n + 12), d, { vel: (0.05 + 0.03 * i) * sw, a: d * 0.4, r: 1.2, cut: 1200 + 1800 * i, vib: 0.12 });
      }
      const mr = ramp(0.4, 0.5, i);
      if (mr && MAR[s] != null) K.play(mar, 'marimba', v[MAR[s]] + 12, K.jit(t), { vel: K.hv(0.18 * mr) });
      const sk = ramp(0.48, 0.58, i);
      if (sk) K.shaker(perc, K.jit(t, 0.004), (s % 4 === 0 ? 0.7 : s % 2 === 0 ? 0.45 : 0.25) * sk);
      const fd = ramp(0.6, 0.7, i);
      if (fd) { if (s === 0) K.frame(perc, t, 0.75 * fd); if (s === 8) K.frame(perc, t, 0.55 * fd); if (s === 6 || s === 14) K.frame(perc, t, 0.16 * fd, 0.05); }
      if (i > 0.72 && (s === 2 || s === 7 || s === 11) && R() < 0.5) K.play(kal, 'kalimba', KAL[(R() * KAL.length) | 0], t, { vel: 0.09 });
      const ld = ramp(0.78, 0.9, i);
      if (ld) for (const [st, n, len] of MEL[ph]) if (st === s) {
        K.sustain(lead, t, [n], len * sd * 1.02, { vel: 0.06 * ld, a: 0.12, r: 0.6, cut: 3000, vib: 0.15, voices: 3, det: 8 });
        K.play(mar, 'marimba', n, t, { vel: 0.12 * ld });
      }
    },
    sfx: {
      hover: (t, v) => K.play(dry, 'rustle', 0, t, { vel: 0.06 * v, variant: (R() * 4) | 0, rate: 0.9 + R() * 0.2 }),
      select: (t, v) => K.play(room, 'marimba', 74, t, { vel: 0.22 * v }),
      back: (t, v) => K.play(room, 'marimba', 69, t, { vel: 0.14 * v }),
      zoomIn: (t, v) => { K.nsweep(room, t, { dur: 0.42, f0: 450, f1: 1700, q: 1.1, peak: 0.09 * v, at: 0.6 }); rustles(room, t + 0.16, 0.035 * v, 2, 0.15); },
      zoomOut: (t, v) => { K.nsweep(room, t, { dur: 0.45, f0: 1700, f1: 420, q: 1.1, peak: 0.08 * v, at: 0.35 }); rustles(room, t + 0.05, 0.03 * v, 2, 0.15); },
      start: (t, v) => { K.play(room, 'guitar', 69, t, { vel: 0.26 * v, bend: 1, bendTime: 0.35 }); K.nsweep(room, t, { dur: 0.5, kind: 'white', type: 'highpass', f0: 3000, f1: 6000, peak: 0.02 * v, at: 0.7 }); },
      complete: (t, v) => {
        K.thump(room, t, { f0: 420, f1: 160, fdec: 0.04, dec: 0.07, vel: 0.14 * v }); K.hit(room, t, { type: 'lowpass', f: 900, q: 0.6, vel: 0.08 * v, dec: 0.04 });
        K.arp(wet, 'kalimba', [86, 90, 93], t + 0.07, 0.06, 0.14 * v); K.nsweep(wet, t + 0.07, { dur: 0.7, kind: 'white', type: 'highpass', f0: 3000, f1: 7000, peak: 0.025 * v, at: 0.4 });
      },
      unlock: (t, v) => K.play(room, 'kalimba', [81, 83, 86, 88][(R() * 4) | 0], t, { vel: 0.15 * v }),
      intro: (t, v) => bloom(t, v),
      impact: (t, v) => bloom(t, v),
      riser: (t, v, o) => {
        const d = o.dur || 2.8;
        K.sustain(room, t, [57, 62, 66], d, { vel: 0.1 * v, a: d * 0.9, r: 0.3, cut: 800, cutTo: 3200, cutTime: d * 0.5, glide: 200 });
        K.nsweep(room, t, { dur: d, kind: 'white', type: 'highpass', f0: 2500, f1: 6000, peak: 0.03 * v, rev: true });
        K.roll(t + 0.3, d - 0.3, 3, 14, (x, u) => K.play(room, 'rustle', 0, x, { vel: (0.015 + 0.04 * u) * v, variant: (R() * 4) | 0, pan: R() - 0.5 }));
      },
      step: (t, v, o) => K.play(dry, 'marimba', 86, t, { vel: 0.07 * v, rate: o.rate || 1 }),
      stinger: (t, v) => K.arp(wet, 'kalimba', [86, 90, 93], t, 0.06, 0.14 * v),
    },
  };
};

// ── Shifting Stairs: a hushed night in a stone tower that slowly wakes. D harmonic minor, a magical 3/4.
// Ground floor: cello drone + soft heartbeat (music box glints). Climbing: muted pizzicato waltz + steady pulse,
// celesta. Near the sunlit top: warm horns, timpani and a broad string line. ~70 → 118 bpm.
ENGINES['shifting-stairs'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 38, v: [50, 57, 62, 65] }, { b: 43, v: [50, 55, 58, 62] }, { b: 37, v: [52, 55, 57, 61] }, { b: 38, v: [50, 53, 57, 62] },
    { b: 34, v: [50, 53, 58, 62] }, { b: 43, v: [50, 55, 58, 62] }, { b: 40, v: [52, 55, 58, 62] }, { b: 45, v: [49, 55, 57, 61] },
  ]; // Dm Gm A7/C# Dm | Bb Gm Eø A7
  const MEL = [[[0, 69, 4], [4, 74, 6], [10, 77, 2]], [[0, 76, 4], [4, 74, 8]], [[0, 81, 8], [8, 79, 4]], [[0, 74, 6], [6, 77, 2], [8, 76, 4]],
    [[0, 70, 4], [4, 74, 6], [10, 77, 2]], [[0, 79, 4], [4, 77, 4], [8, 74, 4]], [[0, 76, 6], [6, 74, 2], [8, 70, 4]], [[0, 69, 6], [6, 73, 6]]];
  const A6 = [0, 1, 2, 3, 2, 1], GL = [62, 65, 69, 72, 74, 77, 81, 84, 86];
  const low = K.ch({ send: 0.3, eq: [['lowpass', 1200, 0.5]] }), cho = K.ch({ pan: -0.15, send: 0.7 }), pz = K.ch({ pan: 0.2, send: 0.35, eq: [['highpass', 70, 0.7]] });
  const cel = K.ch({ pan: -0.3, send: 0.6 }), box = K.ch({ pan: 0.25, send: 0.65 }), vln = K.ch({ pan: 0.3, send: 0.6 }), lead = K.ch({ pan: 0, send: 0.65 });
  const hrn = K.ch({ pan: -0.25, send: 0.55 }), timpC = K.ch({ send: 0.55 }), pulse = K.ch({ send: 0.35, eq: [['lowpass', 1400, 0.6]] });
  const cello = K.drone([[W.strings, 38, -4, 1], [W.strings, 38, 5, 1], [W.strings, 45, 2, 0.4]], { cut: 480, trem: 0.3 });
  const dry = K.sfxCh({ send: 0.05 }), room = K.sfxCh({ send: 0.35 }), wet = K.sfxCh({ send: 0.7 });
  K.warm([...new Set(P.flatMap((c) => [c.b, ...c.v]))].map((n) => ['pizz', n]).concat([...new Set(MEL.flat().map((m) => m[1]))].flatMap((n) => [['musicbox', n + 12], ['celesta', n]]), GL.map((n) => ['harp', n]), [['grind', 0, 2], ['grind', 0, 3], ['bell', 74], ['bell', 86], ['stone', 84], ['stone', 77], ['stone', 72], ['creak', 0, 1]], [0, 1, 2, 3].map((v) => ['stepStone', 0, v])));
  let lastStep = -1;
  const foot = (t, v, r = 1) => K.play(room, 'stepStone', 0, t, { vel: 0.16 * v, variant: (R() * 4) | 0, rate: r * (0.92 + R() * 0.16) });
  const arrive = (t, v) => {
    K.subDrop(room, t, { f0: 60, f1: 28, dur: 2.0, vel: 0.5 * v }); K.taiko(room, t, 0.9 * v);
    K.revCym(wet, t - 0.9, 0.9, 0.7 * v); K.crash(wet, t, 1.1 * v, 2.6);
    K.brass(wet, t, [38, 45, 50, 54, 57, 62], 1.8, { vel: 0.18 * v, a: 0.08, r: 1.3, bright: 0.85 });
  };
  return {
    spb: 12,
    mix: { verb: { dur: 4.6, decay: 2.2, tone: 0.42, pre: 0.035 }, verbLevel: 0.58, level: 0.56, sfxLevel: 1 },
    trim: { hover: 1, select: 0.8, back: 1.6, zoomIn: 1.8, zoomOut: 2.4, start: 0.42, complete: 0.6, unlock: 0.9, riser: 1.9, step: 1, footstep: 0.55 },
    stepDur: (i) => 60 / (70 + 48 * i) / 4,
    update(now, i) { cello.gain.setTargetAtTime(0.06 * (1 - 0.35 * i), now, 0.6); },
    step(t, s, bar, i, sd) {
      const ph = bar % 8, c = P[ph], barDur = sd * 12, v = c.v;
      if (s === 0) {
        K.choir(cho, t, v, barDur * 1.12, { vel: 0.02 + 0.03 * i, a: 1.0, r: 1.6, vowel: i > 0.6 ? 'ah' : 'oo' });
        K.sustain(low, t, [c.b - 12, c.b], barDur * 1.06, { vel: 0.035 + 0.07 * ramp(0.25, 0.7, i), a: 0.6, r: 1.1, cut: 400 + 500 * i, vib: 0.05 });
        const fs = ramp(0.55, 0.68, i);
        if (fs) K.sustain(vln, t, v.map((n) => n + 12), barDur * 1.06, { vel: 0.07 * fs, a: 0.5, r: 0.9, cut: 2000 + 2000 * i, vib: 0.14 });
        const hr = ramp(0.6, 0.72, i);
        if (hr) K.brass(hrn, t, v.map((n) => n - 12), barDur * 1.05, { vel: 0.07 * hr, a: barDur * 0.45, r: 0.6, bright: 0.45 + 0.4 * i });
        if (i > 0.6) K.timp(timpC, t, c.b > 40 ? c.b - 12 : c.b, 0.5 * ramp(0.6, 0.7, i));
        if (i > 0.85 && ph === 7) K.revCym(timpC, t, barDur, 0.8);
      }
      if (i > 0.72 && ph === 7 && s >= 6) { K.timp(timpC, t, 33, 0.1 + 0.06 * (s - 6)); K.timp(timpC, t + sd / 2, 33, 0.1 + 0.06 * (s - 6)); }
      const hb = 1 - ramp(0.34, 0.48, i);
      if (hb > 0 && (s === 0 || s === 6)) K.heart(pulse, t, 0.55 * hb);
      const pu = ramp(0.3, 0.42, i);
      if (pu && s % 4 === 0) K.frame(pulse, t, (s === 0 ? 0.6 : 0.32) * pu);
      const pzv = ramp(0.26, 0.36, i);
      if (pzv) {
        if (s === 0) K.play(pz, 'pizz', c.b, t, { vel: K.hv(0.42 * pzv) });
        if (s === 4 || s === 8) [v[1], v[2], v[3]].forEach((n, k) => K.play(pz, 'pizz', n, t + k * 0.012, { vel: K.hv(0.15 * pzv) }));
      }
      const ca = ramp(0.44, 0.54, i);
      if (ca && s % 2 === 0) K.play(cel, 'celesta', v[A6[s >> 1]] + 12, K.jit(t), { vel: K.hv(0.1 * ca) });
      const mb = ramp(0.08, 0.16, i) * (1 - ramp(0.5, 0.6, i)), ld = ramp(0.68, 0.8, i);
      for (const [st, n, len] of MEL[ph]) if (st === s) {
        if (mb) K.play(box, 'musicbox', n + 12, K.jit(t), { vel: K.hv(0.13 * mb) });
        if (ld) K.sustain(lead, t, i > 0.86 ? [n, n - 12] : [n], len * sd * 1.02, { vel: 0.07 * ld, a: 0.12, r: 0.6, cut: 3200, vib: 0.16, voices: 3, det: 8 });
      }
    },
    sfx: {
      hover: (t, v) => K.play(dry, 'stone', 84, t, { vel: 0.04 * v, rate: 0.94 + R() * 0.12 }),
      select: (t, v) => { K.play(dry, 'stone', 77, t, { vel: 0.13 * v }); K.thump(dry, t, { f0: 200, f1: 130, vel: 0.06 * v, dec: 0.05 }); K.play(room, 'bell', 86, t + 0.01, { vel: 0.025 * v }); },
      back: (t, v) => K.play(dry, 'stone', 72, t, { vel: 0.08 * v }),
      zoomIn: (t, v) => K.nsweep(room, t, { dur: 0.5, f0: 400, f1: 2200, q: 1.1, peak: 0.07 * v, at: 0.7 }),
      zoomOut: (t, v) => { for (const p of [-1, 1]) K.nsweep(wet, t, { dur: 0.65, f0: 1800, f1: 300, q: 2.4, peak: 0.05 * v, at: 0.3, pan0: 0.3 * p, pan1: 0.7 * p }); },
      start: (t, v) => { K.play(room, 'creak', 0, t, { vel: 0.16 * v, variant: 1 }); K.roll(t + 0.32, 0.42, 14, 22, (x, u) => K.tom(room, x, (0.12 + 0.3 * u) * v, 1.2)); K.taiko(room, t + 0.76, 0.5 * v); },
      complete: (t, v) => {
        K.thump(room, t, { f0: 85, f1: 36, fdec: 0.25, dec: 0.9, vel: 0.5 * v }); K.hit(room, t, { type: 'lowpass', f: 650, q: 0.6, vel: 0.2 * v, dec: 0.12 });
        K.play(wet, 'bell', 74, t + 0.02, { vel: 0.2 * v }); K.play(wet, 'bell', 86, t + 0.02, { vel: 0.08 * v });
      },
      unlock: (t, v) => { K.arp(wet, 'harp', GL, t, 0.045, (k) => (0.07 + 0.01 * k) * v); K.play(wet, 'chime', 93, t + 0.4, { vel: 0.04 * v }); },
      intro: (t, v) => arrive(t, v),
      riser: (t, v, o) => {
        const d = o.dur || 2.2;
        K.riseTones(room, t, [50, 57, 62], d, { vel: 0.14 * v, mult: 2, trem: [8, 16], cut: [500, 4500] });
        K.nsweep(room, t, { dur: d, kind: 'white', f0: 300, f1: 5000, q: 1, peak: 0.1 * v, rev: true });
      },
      // One event, two meanings: an isolated step is a staircase swinging (short grind → clunk);
      // steps in quick succession are the marker's footsteps.
      step: (t, v) => {
        const run = t - lastStep < 0.4; lastStep = t;
        if (run) foot(t, 0.55 * v); else K.play(room, 'grind', 0, t, { vel: 0.09 * v, variant: 2 + ((R() * 2) | 0), rate: 0.94 + R() * 0.12 });
      },
      footstep: (t, v) => { foot(t, v, 0.85); foot(t + 0.38, 0.85 * v, 0.9); },
      grind: (t, v) => K.play(room, 'grind', 0, t, { vel: 0.13 * v, variant: (R() * 2) | 0 }),
      stinger: (t, v) => K.arp(wet, 'harp', GL, t, 0.04, 0.1 * v),
    },
  };
};

// ── Impossible Tower: serene, meditative ambient in F Lydian (~60 bpm). A slow warm pad, sparse kalimba, lots of air.
// Intensity lives around 0.18–0.56 here: a second pad voice and a slow high bell figure join near the summit.
// Never drums.
ENGINES['impossible-tower'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 41, v: [53, 57, 60, 64, 67], h: [53, 57, 60, 64, 67, 69, 72, 76], k: [77, 79, 81, 84, 86, 88] },
    { b: 41, v: [55, 59, 62, 64], h: [55, 59, 62, 64, 67, 71, 74, 76], k: [79, 81, 83, 86, 88, 91] },
    { b: 45, v: [55, 60, 62, 64], h: [57, 60, 62, 64, 67, 69, 72, 76], k: [76, 79, 81, 84, 86, 88] },
    { b: 38, v: [53, 57, 60, 64], h: [50, 53, 57, 60, 64, 65, 69, 72], k: [77, 81, 84, 86, 88, 89] },
  ]; // Fmaj9 · G6/F (Lydian) · Am11 · Dm9, two bars each
  const BELL = [[84, 79], [83, 79], [81, 76], [81, 77]]; // the slow high bell figure, two notes per chord
  const MEL = [[[0, 72, 8], [8, 76, 8]], [[0, 79, 16]], [[0, 74, 8], [8, 71, 8]], [[0, 76, 16]], [[0, 72, 8], [8, 74, 8]], [[0, 76, 12], [12, 74, 4]], [[0, 69, 8], [8, 72, 8]], [[0, 76, 16]]];
  const dl = K.delay({ time: 0.75, fb: 0.38, cut: 2200, wet: 0.26, send: 0.25 });
  const pad = K.ch({ pan: -0.2, send: 0.6 }), bass = K.ch({ send: 0.2 }), harp = K.ch({ pan: 0.25, send: 0.45, to: dl.input });
  const kal = K.ch({ pan: -0.3, send: 0.55, to: dl.input }), air = K.ch({ pan: 0.15, send: 0.8 }), bell = K.ch({ pan: 0.3, send: 0.8 }), lead = K.ch({ pan: 0, send: 0.6 });
  const breath = K.bed({ kind: 'pink', type: 'bandpass', f: 1100, q: 0.5, rate: 0.05, depth: 0.7 });
  const dry = K.sfxCh({ send: 0.08 }), room = K.sfxCh({ send: 0.45 }), wet = K.sfxCh({ send: 0.75 });
  K.warm([...new Set(P.flatMap((c) => c.h))].map((n) => ['harp', n]).concat([...new Set(P.flatMap((c) => c.k))].map((n) => ['kalimba', n]), [76, 77, 79, 81, 83, 84, 86, 88, 91, 93, 96].map((n) => ['chime', n]), [['slide', 0, 2], ['slide', 0, 3], ['wood', 72], ['bell', 77], ['stepStone', 0, 0], ['stepStone', 0, 1]]));
  let lastStep = -1;
  const shimmer = (t, v, n = 5) => { const pool = [84, 86, 88, 91, 93, 96]; for (let k = 0; k < n; k++) K.play(wet, 'chime', pool[(R() * pool.length) | 0], t + k * 0.12 + R() * 0.06, { vel: (0.03 + R() * 0.02) * v, pan: (R() - 0.5) * 1.2, cut: 6000 }); };
  const bloom = (t, v) => {
    K.sustain(wet, t, [41, 53, 60, 64, 67, 72], 3.2, { wave: W.soft, vel: 0.16 * v, a: 1.2, r: 2.4, cut: 1100, cutTo: 2600, cutTime: 1.2, vib: 0.05 });
    K.nsweep(wet, t + 0.2, { dur: 2.4, kind: 'white', type: 'highpass', f0: 6000, f1: 8000, peak: 0.012 * v, at: 0.4 });
    shimmer(t + 0.4, 0.9 * v, 6);
  };
  return {
    spb: 16,
    mix: { verb: { dur: 5.5, decay: 2.0, tone: 0.55, pre: 0.04 }, verbLevel: 0.6, level: 0.62, sfxLevel: 1 },
    trim: { hover: 0.75, select: 1, back: 1, start: 0.42, complete: 0.8, unlock: 0.45, riser: 0.8, intro: 0.45, impact: 0.45, step: 1 },
    stepDur: (i) => 60 / (60 + 8 * i) / 4,
    update(now, i) { breath.gain.setTargetAtTime(0.008 + 0.01 * i, now, 1); dl.setTime((60 / (60 + 8 * i)) * 0.75, now); },
    step(t, s, bar, i, sd) {
      const ci = (bar >> 1) % 4, c = P[ci], half = bar % 2, chordDur = sd * 32, mi = bar % 8;
      if (s === 0 && half === 0) {
        K.sustain(pad, t, c.v, chordDur * 1.08, { wave: W.soft, vel: 0.03 + 0.08 * ramp(0.1, 0.6, i), a: 2.4, r: 3.2, cut: 800 + 1400 * i, det: 9, vib: 0.06, vibRate: 0.45 });
        K.sustain(bass, t, [c.b], chordDur * 1.05, { wave: W.soft, vel: 0.05 + 0.05 * i, a: 1.6, r: 2.5, cut: 500, voices: 1, vib: 0 });
        const av = ramp(0.34, 0.46, i);
        if (av) K.choir(air, t, c.v.slice(1).map((n) => n + 12), chordDur, { vel: 0.035 * av, a: 2.5, r: 3, vowel: 'oo', breath: 0.3 });
      }
      // sparse kalimba ("felt piano") notes, more of them as you rise
      if (i > 0.1 && s % 4 === 0 && R() < 0.22 + 0.4 * i) K.play(kal, 'kalimba', c.k[(R() * c.k.length) | 0], K.jit(t, 0.03), { vel: K.hv(0.1 * ramp(0.1, 0.22, i)) });
      // slow harp arpeggio: quarter notes, eighths only near the top
      const hp = ramp(0.26, 0.36, i);
      if (hp && (s % 4 === 0 || (i > 0.5 && s % 2 === 0))) {
        const k = half * 8 + (s >> 1), idx = k < 8 ? k : 15 - k;
        K.play(harp, 'harp', c.h[idx], K.jit(t, 0.01), { vel: K.hv((s % 4 ? 0.08 : 0.13) * hp) });
      }
      // slow high bell figure near the summit
      const bf = ramp(0.4, 0.5, i);
      if (bf && half === 1 && (s === 0 || s === 8)) K.play(bell, 'chime', BELL[ci][s ? 1 : 0], K.jit(t, 0.02), { vel: 0.07 * bf, cut: 5000 });
      if (i > 0.46 && s === 4 && bar % 4 === 2 && R() < 0.6) shimmer(t, 0.7);
      const ld = ramp(0.52, 0.62, i);
      if (ld) for (const [st, n, len] of MEL[mi]) if (st === s) K.sustain(lead, t, [n], len * sd, { wave: W.soft, vel: 0.06 * ld, a: 0.3, r: 1.3, cut: 2400, vib: 0.12, vibRate: 4.6, voices: 2, det: 5 });
    },
    sfx: {
      hover: (t, v) => K.play(dry, 'wood', 72, t, { vel: 0.05 * v, rate: 0.96 + R() * 0.08, cut: 2500 }),
      select: (t, v) => { K.play(room, 'chime', 84, t, { vel: 0.06 * v, cut: 4000 }); K.play(room, 'chime', 91, t + 0.11, { vel: 0.05 * v, cut: 4000 }); },
      back: (t, v) => { K.play(room, 'chime', 91, t, { vel: 0.035 * v, cut: 3500 }); K.play(room, 'chime', 84, t + 0.11, { vel: 0.03 * v, cut: 3500 }); },
      zoomIn: (t, v) => K.nsweep(room, t, { dur: 0.6, type: 'lowpass', f0: 400, f1: 1600, q: 0.8, peak: 0.05 * v, at: 0.6 }),
      zoomOut: (t, v) => K.nsweep(room, t, { dur: 0.6, type: 'lowpass', f0: 1600, f1: 350, q: 0.8, peak: 0.05 * v, at: 0.4 }),
      start: (t, v) => {
        K.sustain(room, t, [53, 60], 0.8, { wave: W.soft, vel: 0.1 * v, a: 0.6, r: 0.6, cut: 900, cutTo: 2000, cutTime: 0.4, vib: 0.08 });
        K.nsweep(room, t, { dur: 0.8, f0: 500, f1: 1400, q: 1.4, peak: 0.03 * v, at: 0.7 });
        K.play(wet, 'chime', 77, t + 0.62, { vel: 0.05 * v, cut: 4000 }); K.play(wet, 'chime', 84, t + 0.78, { vel: 0.05 * v, cut: 4000 });
      },
      complete: (t, v) => {
        K.play(wet, 'bell', 77, t, { vel: 0.16 * v, cut: 4500 }); K.play(room, 'slide', 0, t + 0.05, { vel: 0.04 * v, variant: 2, rate: 0.8 });
        K.sustain(wet, t, [53, 60, 64, 67, 72], 2.2, { wave: W.soft, vel: 0.08 * v, a: 0.7, r: 1.8, cut: 2200 });
      },
      unlock: (t, v) => K.arp(room, 'kalimba', [72, 76, 79], t, 0.13, (k) => (0.1 + 0.015 * k) * v),
      intro: (t, v) => bloom(t, v),
      impact: (t, v) => bloom(t, v),
      riser: (t, v, o) => {
        const d = o.dur || 2.2;
        K.sustain(room, t, [53, 60, 64, 67], d, { wave: W.soft, vel: 0.1 * v, a: d * 0.9, r: 0.6, cut: 900, cutTo: 2600, cutTime: d * 0.5 });
        K.revCym(room, t, d, 0.45 * v);
      },
      // An isolated step is the architecture locking into place (smooth glide → wooden clunk); steps in quick
      // succession are the figure's footsteps (light, dry taps).
      step: (t, v) => {
        const run = t - lastStep < 0.45; lastStep = t;
        if (run) K.play(dry, 'stepStone', 0, t, { vel: 0.07 * v, variant: (R() * 2) | 0, rate: 1.1 + R() * 0.15 });
        else K.play(room, 'slide', 0, t, { vel: 0.065 * v, variant: 2 + ((R() * 2) | 0), rate: 0.95 + R() * 0.1 });
      },
      stinger: (t, v) => shimmer(t, v, 5),
    },
  };
};

// ── Tiny Planet: playful, whimsical C major. A bouncy marimba/pizzicato ostinato over a warm ukulele-and-glockenspiel
// pad with shaker and woodblock; it grows into a little toy-orchestra march as you explore.
ENGINES['tiny-planet'] = (K) => {
  const { W, R, ramp } = K;
  const P = [
    { b: 48, v: [60, 64, 67, 72], u: [67, 60, 64, 72] }, { b: 47, v: [59, 62, 67, 71], u: [67, 62, 67, 71] }, { b: 45, v: [57, 60, 64, 69], u: [69, 60, 64, 69] }, { b: 41, v: [57, 60, 65, 69], u: [69, 60, 65, 69] },
    { b: 48, v: [60, 64, 67, 72], u: [67, 60, 64, 72] }, { b: 40, v: [59, 64, 67, 71], u: [67, 59, 64, 71] }, { b: 41, v: [57, 60, 65, 69], u: [69, 60, 65, 69] }, { b: 43, v: [60, 62, 67, 72], v2: [59, 62, 67, 71], u: [67, 60, 62, 67] },
  ]; // C G/B Am F | C Em F Gsus4→G  (u = re-entrant ukulele voicing)
  const MEL = [[[0, 76, 2], [3, 79, 2], [6, 84, 4], [12, 79, 4]], [[0, 74, 2], [3, 79, 2], [6, 83, 6], [12, 79, 2]], [[0, 72, 2], [3, 76, 2], [6, 81, 4], [12, 76, 4]], [[0, 77, 4], [6, 76, 2], [8, 72, 6]],
    [[0, 76, 2], [3, 79, 2], [6, 84, 4], [12, 86, 4]], [[0, 83, 2], [3, 79, 2], [6, 76, 6], [12, 79, 2]], [[0, 81, 4], [6, 79, 2], [8, 77, 4], [12, 76, 4]], [[0, 74, 8], [8, 79, 8]]];
  const OST = [0, 2, 1, 2, 3, 2, 1, 2]; // marimba ostinato over chord tones, in eighths
  const STRUM = { 0: 1, 6: -1, 8: 1, 10: -1, 14: -1 }, BASS = { 0: 0, 6: 7, 8: 12, 12: 7 };
  const uke = K.ch({ pan: -0.2, send: 0.25, eq: [['highpass', 180, 0.7], ['peaking', 900, 1, 2]] }), mar = K.ch({ pan: 0.3, send: 0.3 }), glk = K.ch({ pan: 0.35, send: 0.5 });
  const pad = K.ch({ pan: 0.1, send: 0.45 }), bass = K.ch({ send: 0.12 }), perc = K.ch({ send: 0.18 }), hrn = K.ch({ pan: -0.3, send: 0.45 });
  const dry = K.sfxCh({ send: 0.06 }), room = K.sfxCh({ send: 0.3 }), wet = K.sfxCh({ send: 0.6 });
  K.warm([...new Set(P.flatMap((c) => c.u))].map((n) => ['uke', n]).concat([...new Set(MEL.flat().map((m) => m[1]).concat(P.flatMap((c) => c.v.map((n) => n + 12))))].map((n) => ['marimba', n]), [72, 76, 79, 84, 88, 91, 96].map((n) => ['glock', n]), [84, 91, 88, 93].map((n) => ['musicbox', n]), [['wood', 76], ['wood', 86], ['xylo', 84], ['xylo', 79]], P.map((c) => ['pizz', c.b - 12])));
  const swing = (t, s, sd) => t + (s % 4 === 2 ? sd * 0.18 : s % 2 === 1 ? sd * 0.1 : 0);
  const strum = (t, notes, dir, vel) => { const ns = dir > 0 ? notes : [...notes].reverse(); ns.forEach((n, k) => K.play(uke, 'uke', n, t + k * 0.012, { vel: K.hv(vel * (k ? 0.85 : 1)) })); };
  const snare = (t, v) => { K.hit(perc, t, { f: 2600, q: 0.8, vel: 0.1 * v, dec: 0.09 }); K.thump(perc, t, { f0: 330, f1: 220, vel: 0.08 * v, dec: 0.06 }); };
  const chord = (t, v) => {
    K.timp(room, t, 36, 0.55 * v);
    K.sustain(wet, t, [48, 55, 60, 64, 67, 72, 76], 2.0, { vel: 0.13 * v, a: 0.15, r: 1.4, cut: 2400, cutTo: 4200, cutTime: 0.6 });
    K.brass(wet, t + 0.02, [48, 55, 60, 64], 1.4, { vel: 0.08 * v, a: 0.25, r: 0.9, bright: 0.65 });
    K.arp(wet, 'glock', [72, 76, 79, 84], t + 0.1, 0.06, 0.1 * v);
  };
  return {
    spb: 16,
    mix: { verb: { dur: 2.2, decay: 3, tone: 0.6, pre: 0.012 }, verbLevel: 0.42, level: 0.9, sfxLevel: 1 },
    trim: { hover: 0.7, select: 0.5, back: 0.5, complete: 1.8, riser: 1.8, spin: 1.3 },
    stepDur: (i) => 60 / (100 + 20 * i) / 4,
    step(t0, s, bar, i, sd) {
      const t = swing(t0, s, sd), ph = bar % 8, c = P[ph], barDur = sd * 16, v = c.v2 && s >= 8 ? c.v2 : c.v;
      if (s === 0 || (s === 8 && c.v2)) K.sustain(pad, t0, v, (c.v2 ? barDur / 2 : barDur) * 1.06, { wave: W.soft, vel: 0.03 + 0.05 * i, a: 0.5, r: 0.9, cut: 1200 + 1500 * i, vib: 0.05, det: 9 });
      // ukulele: sparse at rest, a full island strum once the march gets going
      if (i < 0.6 ? (s === 0 || s === 8) : STRUM[s] != null) strum(t, c.u, STRUM[s] ?? 1, (0.13 + 0.1 * i) * (s % 8 === 0 ? 1 : 0.75));
      // glockenspiel glints as part of the pad
      if (i > 0.12 && (s === 4 || s === 12) && R() < 0.5 + 0.3 * i) K.play(glk, 'glock', v[1 + ((R() * 3) | 0)] + 24, t, { vel: 0.05 + 0.03 * i });
      // bouncy marimba ostinato + pizzicato bass
      const os = ramp(0.24, 0.34, i);
      if (os && s % 2 === 0) K.play(mar, 'marimba', v[OST[s >> 1]] + 12, K.jit(t, 0.004), { vel: K.hv((s % 4 === 0 ? 0.13 : 0.09) * os) });
      if (os && BASS[s] != null && (i > 0.55 || s === 0 || s === 8)) K.play(bass, 'pizz', c.b - 12 + BASS[s], t, { vel: K.hv(0.42 * os) });
      // shaker + woodblock
      const pc = ramp(0.34, 0.44, i);
      if (pc) {
        if (s % 2 === 0) K.shaker(perc, K.jit(t, 0.004), (s % 4 === 2 ? 0.6 : 0.35) * pc);
        if (s === 4 || s === 12) K.play(perc, 'wood', 86, t, { vel: 0.09 * pc });
      }
      // marimba tune
      const mr = ramp(0.48, 0.58, i);
      if (mr) for (const [st, n] of MEL[ph]) if (st === s) K.play(mar, 'marimba', n, K.jit(t, 0.004), { vel: K.hv(0.18 * mr) });
      // toy-orchestra march
      const mc = ramp(0.62, 0.72, i);
      if (mc) {
        if (s === 0 || s === 8) K.kick(perc, t, 0.55 * mc);
        if (s === 4 || s === 12) snare(t, mc);
        if (i > 0.75 && (s === 14 || s === 15)) snare(t, 0.5 * mc);
        if (s === 0) K.brass(hrn, t0, v.slice(0, 3).map((n) => n - 12), barDur * 0.5, { vel: 0.05 * mc, a: 0.05, r: 0.3, bright: 0.55 });
        for (const [st, n] of MEL[ph]) if (st === s) K.play(glk, 'glock', n + 12, t, { vel: 0.06 * mc });
      }
      if (i > 0.82 && ph % 4 === 3 && s >= 12) K.tom(perc, t, 0.3 + 0.06 * (s - 12), 1.8 - 0.15 * (s - 12));
    },
    sfx: {
      hover: (t, v) => K.play(dry, 'wood', 76, t, { vel: 0.05 * v, rate: 0.96 + R() * 0.08 }),
      select: (t, v) => K.play(room, 'xylo', 84, t, { vel: 0.14 * v }),
      back: (t, v) => K.play(room, 'xylo', 79, t, { vel: 0.1 * v }),
      zoomIn: (t, v) => { K.nsweep(room, t, { dur: 0.4, f0: 500, f1: 3000, q: 1.1, peak: 0.11 * v, at: 0.65, pan0: -0.4, pan1: 0.4 }); K.tsweep(room, t + 0.05, { f0: 700, f1: 1300, dur: 0.32, peak: 0.018 * v, wave: 'sine', glide: 0.9 }); },
      zoomOut: (t, v) => { K.nsweep(room, t, { dur: 0.42, f0: 3000, f1: 450, q: 1.1, peak: 0.1 * v, at: 0.35, pan0: 0.4, pan1: -0.4 }); K.tsweep(room, t + 0.05, { f0: 1200, f1: 650, dur: 0.32, peak: 0.016 * v, wave: 'sine', glide: 0.9 }); },
      whoosh: (t, v, o) => K.nsweep(room, t, { dur: 0.38, f0: o.up === false ? 3000 : 500, f1: o.up === false ? 500 : 3200, q: 1.1, peak: 0.12 * v, at: 0.6, pan0: -0.5, pan1: 0.5 }),
      spin: (t, v) => K.nsweep(room, t, { dur: 0.45, f0: 700, f1: 2600, q: 1.4, peak: 0.1 * v, at: 0.5, pan0: -0.7, pan1: 0.7 }),
      start: (t, v) => { K.roll(t, 0.75, 10, 18, (x, u) => K.play(dry, 'wood', 86 + Math.round(u * 5), x, { vel: (0.05 + 0.03 * u) * v, rate: 1.4 })); K.play(room, 'uke', 72, t + 0.8, { vel: 0.14 * v, bend: 2, bendTime: 0.15 }); },
      complete: (t, v) => {
        K.thump(room, t, { f0: 640, f1: 260, fdec: 0.02, dec: 0.06, vel: 0.12 * v }); K.hit(room, t, { f: 1800, q: 1.4, vel: 0.06 * v, dec: 0.02 });
        K.arp(wet, 'glock', [72, 76, 79, 84, 88, 91], t + 0.06, 0.055, 0.1 * v);
        K.nsweep(wet, t + 0.06, { dur: 0.9, kind: 'white', type: 'highpass', f0: 4000, f1: 9000, peak: 0.02 * v, at: 0.4 });
      },
      unlock: (t, v) => { K.play(room, 'musicbox', 84, t, { vel: 0.12 * v }); K.play(room, 'musicbox', 91, t + 0.12, { vel: 0.11 * v }); },
      intro: (t, v) => chord(t, v),
      impact: (t, v) => chord(t, v),
      riser: (t, v, o) => {
        const d = o.dur || 2.2;
        K.nsweep(room, t, { dur: d, f0: 300, f1: 3500, q: 1.6, peak: 0.08 * v, rev: true, pan0: -0.8, pan1: 0.8 });
        K.nsweep(room, t + d * 0.15, { dur: d * 0.85, f0: 2500, f1: 600, q: 1.6, peak: 0.05 * v, rev: true, pan0: 0.8, pan1: -0.8 });
        K.riseTones(room, t, [60, 67, 72], d, { vel: 0.1 * v, mult: 2, trem: [7, 14], cut: [700, 4500] });
      },
      step: (t, v, o) => K.play(dry, 'marimba', 84, t, { vel: 0.06 * v, rate: o.rate || 0.94 + R() * 0.12 }),
      stinger: (t, v) => K.arp(wet, 'glock', [72, 76, 79, 84, 88, 91], t, 0.05, 0.1 * v),
    },
  };
};

// ═════════════════════ The score ═════════════════════
export function createScore() {
  let ctx = null, master, out, music, sfx, verb, verbIn, verbOut, musicSend, sfxSend, drone = null, timer = null;
  let started = false, musicOn = true, voiceOn = false;
  let intensity = 0, target = 0, rampPerSec = 0.25;
  let step = 0, bar = 0, nextTime = 0;
  let duck = 1;
  let engine = null, kit = null, engStep = 0, ticks = 0;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state()));
  const state = () => ({ started, musicOn, voiceOn, intensity });

  function impulse(seconds = 2.8, decay = 3) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }
  /** Engine reverbs: early reflections + a tail that darkens over time, energy-matched to the generic hall. */
  function impulseCfg({ dur = 2.8, decay = 3, tone = 0.5, pre = 0.02 } = {}) {
    const sr = ctx.sampleRate, n = Math.floor(sr * (dur + pre)), p = Math.floor(sr * pre), buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0, e = 0;
      for (let k = 0; k < 10; k++) { const at = p + Math.floor(sr * (0.003 + Math.random() * 0.08)); if (at < n) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.6 - k * 0.045); }
      for (let i = p; i < n; i++) {
        const u = (i - p) / (n - p), a = Math.max(0.025, (0.35 + 0.6 * tone) * Math.pow(1 - u, 1.4));
        lp += a * (Math.random() * 2 - 1 - lp);
        d[i] += lp * Math.pow(1 - u, decay) * Math.min(1, (i - p) / (sr * 0.01));
      }
      for (let i = 0; i < n; i++) e += d[i] * d[i];
      const k = Math.sqrt((sr * 0.12) / Math.max(1e-9, e));
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    return buf;
  }
  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s;
  }
  function setVerb(buf) {
    const nv = ctx.createConvolver(); nv.buffer = buf;
    verbIn.disconnect(); verbIn.connect(nv); nv.connect(verbOut);
    if (verb) { try { verb.disconnect(); } catch { /* gone */ } }
    verb = nv;
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Glue compressor → brick-wall limiter → soft clipper, so drums + impacts never clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.12;
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(1.4 * x) / Math.tanh(1.4); }
    clip.curve = curve;
    master = ctx.createGain(); master.gain.value = 0;
    master.connect(comp).connect(limiter).connect(clip).connect(ctx.destination);
    out = comp; // narration joins here, so muting the music never silences the voice
    verbIn = ctx.createGain();
    verbOut = ctx.createGain(); verbOut.gain.value = 0.55; verbOut.connect(master);
    setVerb(impulse());
    music = ctx.createGain(); music.gain.value = 1; music.connect(master);
    musicSend = ctx.createGain(); musicSend.gain.value = 0.28; music.connect(musicSend).connect(verbIn);
    sfx = ctx.createGain(); sfx.gain.value = 1; sfx.connect(master);
    sfxSend = ctx.createGain(); sfxSend.gain.value = 0.4; sfx.connect(sfxSend).connect(verbIn);

    // Drone: a D pedal (sub sine + two detuned saws) under a moving low-pass.
    const dGain = ctx.createGain(); dGain.gain.value = 0.0;
    const dFilt = ctx.createBiquadFilter(); dFilt.type = 'lowpass'; dFilt.frequency.value = 140; dFilt.Q.value = 0.7;
    dFilt.connect(dGain).connect(music);
    const oscs = [
      ['sine', midi(26), 0], ['sawtooth', midi(38), -7], ['sawtooth', midi(38), 7], ['sawtooth', midi(45), 4],
    ].map(([type, f, det]) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.connect(dFilt); o.start(); return o; });
    drone = { gain: dGain, filt: dFilt, oscs };
    setupEngine();
  }

  /** Switch to the theme's synth engine (or back to the generic score). */
  function setupEngine() {
    if (!ctx) return;
    const name = theme?.synth && ENGINES[theme.synth] ? theme.synth : null;
    const key = name ? name + '/' + (theme.variant || '') : null;
    if (engine?.key === key) return;
    if (kit) { kit.destroy(); kit = null; engine = null; }
    if (!name) {
      setVerb(impulse()); verbOut.gain.value = 0.55; musicSend.gain.value = 0.28;
      return;
    }
    kit = createKit(ctx, { music, sfxOut: master, verbIn, white: () => noiseBuf || (noise(), noiseBuf) });
    engine = ENGINES[name](kit, theme);
    engine.key = key;
    const mx = engine.mix || {};
    setVerb(impulseCfg(mx.verb)); verbOut.gain.value = mx.verbLevel ?? 0.5;
    musicSend.gain.value = 0; // engine channels carry their own reverb sends
    kit.bus.gain.value = (mx.level ?? 1) * (theme.synthLevel ?? 1);
    kit.sfxBus.gain.value = (mx.sfxLevel ?? 1) * (theme.synthSfxLevel ?? 1);
    engStep = 0; nextTime = ctx.currentTime + 0.1;
    drone.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
  }

  // ── voices ──────────────────────────────────────────────
  function env(g, t, a, peak, d, sustain = 0.0001) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + a + d);
  }
  function kick(t, vel = 1, heart = false) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(heart ? 95 : 140, t);
    o.frequency.exponentialRampToValueAtTime(heart ? 38 : 42, t + (heart ? 0.16 : 0.12));
    env(g, t, 0.004, 0.7 * vel, heart ? 0.32 : 0.42);
    o.connect(g).connect(music); o.start(t); o.stop(t + 0.6);
  }
  function tom(t, vel = 1, pitch = 1) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(110 * pitch, t); o.frequency.exponentialRampToValueAtTime(62 * pitch, t + 0.25);
    env(g, t, 0.003, 0.42 * vel, 0.5);
    o.connect(g).connect(music); o.start(t); o.stop(t + 0.7);
    const n = noise(), f = ctx.createBiquadFilter(), ng = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 900 * pitch; f.Q.value = 1.2;
    env(ng, t, 0.002, 0.22 * vel, 0.08);
    n.connect(f).connect(ng).connect(music); n.start(t, Math.random()); n.stop(t + 0.15);
  }
  function clap(t, vel = 1) {
    const n = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.frequency.value = 1700; f.Q.value = 0.9;
    env(g, t, 0.002, 0.38 * vel, 0.16);
    n.connect(f).connect(g).connect(music); n.start(t, Math.random()); n.stop(t + 0.25);
  }
  function hat(t, vel = 1) {
    const n = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass'; f.frequency.value = 7500;
    env(g, t, 0.001, 0.12 * vel, 0.04);
    n.connect(f).connect(g).connect(music); n.start(t, Math.random()); n.stop(t + 0.08);
  }
  function pluck(t, note, vel, bright) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = midi(note);
    f.type = 'lowpass'; f.frequency.value = bright; f.Q.value = 2;
    env(g, t, 0.004, vel, 0.16);
    o.connect(f).connect(g).connect(music); o.start(t); o.stop(t + 0.25);
  }
  function padChord(t, chord, dur, lvl, bright) {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = bright; f.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + Math.min(1.6, dur * 0.4));
    g.gain.setValueAtTime(lvl, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
    f.connect(g).connect(music);
    for (const n of chord.pad) for (const det of [-9, 9]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.7);
    }
    const b = ctx.createOscillator(), bg = ctx.createGain();
    b.type = 'triangle'; b.frequency.value = midi(chord.bass);
    bg.gain.setValueAtTime(0.0001, t); bg.gain.exponentialRampToValueAtTime(lvl * 1.6, t + 0.3);
    bg.gain.setValueAtTime(lvl * 1.6, t + dur * 0.85); bg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
    b.connect(bg).connect(music); b.start(t); b.stop(t + dur + 0.5);
  }

  // ── sequencer (lookahead scheduling) ─────────────────────
  const bpm = () => 68 + 64 * intensity;
  function scheduleStep(t) {
    const i = intensity, s = step % 16, chord = CHORDS[bar % 4];
    if (s === 0) {
      const barDur = (60 / bpm()) * 4;
      padChord(t, chord, barDur, 0.018 + 0.05 * i, 500 + 2600 * i);
      if (i > 0.62 && bar % 2 === 0) kick(t, 1.1);
    }
    // heartbeat → kick
    if (i < 0.38) { if (s === 0 || s === 8) kick(t, 0.75, true); if (s === 2 || s === 10) kick(t, 0.45, true); }
    else {
      const k = i > 0.82 ? [0, 4, 8, 12, 14] : i > 0.6 ? [0, 4, 8, 12] : [0, 8];
      if (k.includes(s)) kick(t, 0.85);
    }
    if (i > 0.45 && [0, 3, 6, 8, 11, 14].includes(s)) tom(t, s % 8 === 0 ? 1 : 0.6, s >= 11 ? 1.3 : 1);
    if (i > 0.7 && (s === 4 || s === 12)) clap(t);
    if (i > 0.55 && (i > 0.82 || s % 2 === 0)) hat(t, s % 4 === 2 ? 1 : 0.6);
    if (i > 0.26) {
      const tone = chord.pad[OSTINATO[s % 8]] + (s >= 8 && i > 0.75 ? 12 : 0);
      pluck(t, tone - 12, 0.025 + 0.06 * i, 900 + 2600 * i);
    }
    step++;
    if (step % 16 === 0) bar++;
  }
  function tickLoop() {
    if (!ctx) return;
    // Glide intensity toward its target.
    const dt = 0.025;
    if (intensity !== target) {
      const d = target - intensity, mv = rampPerSec * dt;
      intensity = Math.abs(d) <= mv ? target : intensity + Math.sign(d) * mv;
    }
    const now = ctx.currentTime;
    music.gain.setTargetAtTime(duck, now, 0.15);
    if (bed) {
      // Sampled bed: intensity opens the filter (muffled → full) and brings it forward.
      drone.gain.gain.setTargetAtTime(0, now, 0.4);
      if (kit) kit.bus.gain.setTargetAtTime(0, now, 0.3);
      bed.filter.frequency.setTargetAtTime(500 * Math.pow(2, intensity * 5.2), now, 0.35);
      bed.gain.gain.setTargetAtTime((theme.bedLevel ?? 0.8) * (0.42 + 0.58 * intensity), now, 0.5);
      nextTime = now + 0.1;
      return;
    }
    // A long stall (background tab, heavy frame): skip ahead rather than bursting the missed notes.
    if (nextTime < now - 0.08) nextTime = now + 0.03;
    if (engine) {
      if (ticks++ % 4 === 0) engine.update?.(now, intensity);
      while (nextTime < now + 0.2) {
        const sd = engine.stepDur(intensity);
        engine.step(Math.max(nextTime, now), engStep % engine.spb, Math.floor(engStep / engine.spb), intensity, sd);
        nextTime += sd; engStep++;
      }
      return;
    }
    drone.filt.frequency.setTargetAtTime(110 + 700 * intensity, now, 0.3);
    drone.gain.gain.setTargetAtTime((0.09 + 0.07 * intensity) * duck, now, 0.4);
    while (nextTime < now + 0.12) {
      scheduleStep(nextTime);
      nextTime += 60 / bpm() / 4;
    }
  }

  // ── generic one-shots ──────────────────────────────────────────
  function gRiser(seconds = 2.5) {
    const t = ctx.currentTime, n = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(250, t); f.frequency.exponentialRampToValueAtTime(7000, t + seconds);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32, t + seconds);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.08);
    n.connect(f).connect(g).connect(sfx); n.start(t); n.stop(t + seconds + 0.1);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(midi(38), t); o.frequency.exponentialRampToValueAtTime(midi(62), t + seconds);
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.05, t + seconds);
    og.gain.exponentialRampToValueAtTime(0.0001, t + seconds + 0.06);
    o.connect(og).connect(sfx); o.start(t); o.stop(t + seconds + 0.1);
  }
  /** The trailer "BRAAM": sub drop + noise crash + brass stab. */
  function gImpact(strength = 1) {
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(75, t); o.frequency.exponentialRampToValueAtTime(27, t + 1.6);
    env(g, t, 0.005, 1.0 * strength, 2.2);
    o.connect(g).connect(sfx); o.start(t); o.stop(t + 2.4);
    const n = noise(), f = ctx.createBiquadFilter(), ng = ctx.createGain();
    f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(300, t + 1.2);
    env(ng, t, 0.003, 0.5 * strength, 1.3);
    n.connect(f).connect(ng).connect(sfx); n.start(t); n.stop(t + 1.5);
    const bf = ctx.createBiquadFilter(), bg = ctx.createGain();
    bf.type = 'lowpass'; bf.frequency.setValueAtTime(1800, t); bf.frequency.exponentialRampToValueAtTime(260, t + 1.8);
    env(bg, t, 0.02, 0.09 * strength, 2.0);
    bf.connect(bg).connect(sfx);
    for (const m of [26, 38, 45, 50]) for (const det of [-12, 12]) {
      const b = ctx.createOscillator(); b.type = 'sawtooth'; b.frequency.value = midi(m); b.detune.value = det;
      b.connect(bf); b.start(t); b.stop(t + 2.2);
    }
  }
  /** Bright rising arpeggio — a lesson was mastered. */
  function gStinger() {
    const t = ctx.currentTime;
    [62, 65, 69, 74, 77].forEach((m, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = midi(m);
      env(g, t + i * 0.07, 0.005, 0.16, 0.9);
      o.connect(g).connect(sfx); o.start(t + i * 0.07); o.stop(t + i * 0.07 + 1);
    });
  }
  /** Short air sweep for camera moves. */
  function gWhoosh(up = true) {
    const t = ctx.currentTime, n = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(up ? 400 : 3000, t); f.frequency.exponentialRampToValueAtTime(up ? 3000 : 400, t + 0.35);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    n.connect(f).connect(g).connect(sfx); n.start(t, Math.random()); n.stop(t + 0.45);
  }
  /** Tiny UI tick for hovers. */
  function gTick(pitch = 1) {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 1320 * pitch;
    env(g, t, 0.002, 0.05, 0.06);
    o.connect(g).connect(sfx); o.start(t); o.stop(t + 0.1);
  }
  /** Public one-shots follow the active engine, falling back to the generic sound. */
  function viaEngine(name, vol, o, generic) {
    if (!ctx || !musicOn) return;
    const fn = engine?.sfx?.[name];
    if (fn) fn(ctx.currentTime + 0.01, vol * (engine.trim?.[name] ?? 1), o); else generic();
  }
  const riser = (seconds = 2.5) => viaEngine('riser', 1, { dur: seconds }, () => gRiser(seconds));
  const impact = (strength = 1) => viaEngine(engine?.sfx?.impact ? 'impact' : 'intro', strength, {}, () => gImpact(strength));
  const stinger = () => viaEngine('stinger', 1, {}, gStinger);
  const whoosh = (up = true) => viaEngine(engine?.sfx?.whoosh ? 'whoosh' : up ? 'zoomIn' : 'zoomOut', 1, { up }, () => gWhoosh(up));
  const tick = (pitch = 1) => viaEngine('hover', 1, { rate: pitch }, () => gTick(pitch));

  // ── narration: pre-recorded voice clips ─────────────────
  // Lines are recorded ahead of time with a studio TTS model (see setVoiceClips). A line with no
  // clip is skipped rather than read by the browser's robotic speech engine.
  const clips = new Map();     // normalized text → url
  const decoded = new Map();   // url → Promise<AudioBuffer>
  let voiceSrc = null;
  const norm = (t) => String(t).replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  function loadClip(url) {
    if (!decoded.has(url)) decoded.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null));
    return decoded.get(url);
  }
  function setVoiceClips(map) {
    for (const [text, url] of Object.entries(map)) clips.set(norm(text), url);
    if (ctx) for (const url of clips.values()) loadClip(url);
  }
  async function narrate(text, { interrupt = true } = {}) {
    const url = clips.get(norm(text || ''));
    if (!voiceOn || !ctx || !url) return;
    const buf = await loadClip(url);
    if (!buf || !voiceOn) return;
    if (interrupt && voiceSrc) { try { voiceSrc.stop(); } catch { /* already stopped */ } }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; g.gain.value = 0.95;
    src.connect(g).connect(out);
    voiceSrc = src; duck = 0.4;
    await new Promise((resolve) => {
      src.onended = () => { if (voiceSrc === src) { voiceSrc = null; duck = 1; } resolve(); };
      src.start();
    });
  }

  // ── sampled theme: music bed + SFX files per variant (synth fallback) ──
  let theme = null, bed = null;
  function prepareTheme() {
    if (!theme || !ctx) return;
    if (theme.music) loadClip(theme.music);
    for (const v of Object.values(theme.sfx || {})) (Array.isArray(v) ? v : [v]).forEach(loadClip);
  }
  async function startBed() {
    if (!theme?.music || bed || !ctx) return;
    const buf = await loadClip(theme.music);
    if (!buf || bed) return;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    src.buffer = buf; src.loop = true;
    filter.type = 'lowpass'; filter.frequency.value = 500; filter.Q.value = 0.4;
    gain.gain.value = 0.0001;
    src.connect(filter).connect(gain).connect(music);
    src.start();
    bed = { src, filter, gain };
  }
  const FALLBACK = {
    hover: () => gTick(1), select: () => gTick(1.25), back: () => gTick(0.8),
    zoomIn: () => gWhoosh(true), zoomOut: () => gWhoosh(false), whoosh: () => gWhoosh(true),
    start: () => gRiser(0.9), complete: () => { gImpact(0.7); gStinger(); }, unlock: () => gStinger(),
    intro: () => gImpact(1), impact: () => gImpact(1), riser: () => gRiser(2.2), step: () => gTick(0.6),
  };
  const lastPlayed = new Map();
  /**
   * Semantic sound effect. Events: hover, select, back, zoomIn, zoomOut, start, complete, unlock,
   * intro, riser, step, impact, whoosh — plus any extra name an engine defines (peek, sonar, footstep…).
   * Uses the theme's sample when present, else the engine's synthesized recipe, else the generic
   * fallback. Rapid repeats of the same event are throttled.
   */
  async function sfxPlay(name, { volume = 1, rate } = {}) {
    if (!ctx || !musicOn) return;
    const now = performance.now(), gap = name === 'hover' ? 70 : 40;
    if (now - (lastPlayed.get(name) || 0) < gap) return;
    lastPlayed.set(name, now);
    const ref = theme?.sfx?.[name];
    const url = Array.isArray(ref) ? ref[Math.floor(Math.random() * ref.length)] : ref;
    if (url) {
      const buf = await loadClip(url);
      if (buf) {
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = buf;
        src.playbackRate.value = rate ?? 1 + (Math.random() - 0.5) * 0.05;
        g.gain.value = volume * (theme.sfxLevel ?? 0.9);
        src.connect(g).connect(sfx); src.start();
        return;
      }
    }
    if (engine) {
      const key = engine.sfx[name] ? name : ALIAS[name];
      const fn = key && engine.sfx[key];
      if (fn) {
        // Long effects (stone grinds, glides) never stack: each gets its own minimum spacing.
        const g = engine.gap?.[key];
        if (g && now - (lastPlayed.get('#' + key) || -1e9) < g * 1000) return;
        lastPlayed.set('#' + key, now);
        fn(ctx.currentTime + 0.01, volume * (engine.trim?.[key] ?? 1), { rate });
        return;
      }
    }
    FALLBACK[name]?.();
  }

  return {
    /** Must be called from a user gesture (click/key). Safe to call twice. */
    async start({ music: m = true, voice: v = false } = {}) {
      musicOn = m; voiceOn = v;
      if (!ctx) { build(); for (const url of clips.values()) loadClip(url); prepareTheme(); }
      if (ctx.state === 'suspended') await ctx.resume();
      if (!started) {
        started = true; nextTime = ctx.currentTime + 0.1;
        timer = setInterval(tickLoop, 25);
        startBed();
      }
      master.gain.setTargetAtTime(musicOn ? 0.7 : 0, ctx.currentTime, 0.8);
      emit();
    },
    stop() { if (timer) clearInterval(timer); timer = null; started = false; if (ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.2); emit(); },
    /** 0…1. `seconds` = how long the ramp should take from 0 to 1 (default 4s). */
    setIntensity(v, seconds = 4) { target = Math.max(0, Math.min(1, v)); rampPerSec = 1 / Math.max(0.05, seconds); },
    get intensity() { return intensity; },
    setMusic(on) { musicOn = on; if (ctx) master.gain.setTargetAtTime(on ? 0.7 : 0, ctx.currentTime, 0.3); emit(); },
    setVoice(on) { voiceOn = on; if (!on && voiceSrc) { try { voiceSrc.stop(); } catch { /* already stopped */ } } emit(); },
    get musicOn() { return musicOn; },
    get voiceOn() { return voiceOn; },
    get started() { return started; },
    onState(fn) { listeners.add(fn); fn(state()); return () => listeners.delete(fn); },
    /** Per-variant audio: { synth?: engine name, variant?, music?: url, bedLevel?, sfxLevel?, sfx?: { event: url | url[] } }. */
    useTheme(t) { theme = t || null; prepareTheme(); setupEngine(); if (started) startBed(); },
    sfx: sfxPlay,
    riser, impact, stinger, whoosh, tick, narrate, setVoiceClips,
    /** QA only: internals for offline rendering / metering. */
    get _debug() { return { ctx, master, engine: engine?.key || null }; },
  };
}
