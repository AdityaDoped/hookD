"use strict";
const $ = (s, r = document) => r.querySelector(s);

/* ---------- Constants ---------- */
const VIBES = {
  original: { rate: 1, wet: 0 },
  slowed: { rate: 0.85, wet: 0.38 },
  sped: { rate: 1.22, wet: 0 },
};
const STYLES = { crossfade: "Crossfade", filter: "Filter sweep", echo: "Echo out", riser: "Riser", cut: "Hard cut" };
const TARGET_RMS = Math.pow(10, -17 / 20);
const CURVE_IN = new Float32Array(64).map((_, i) => Math.sin((i / 63) * Math.PI / 2));
const CURVE_OUT = new Float32Array(64).map((_, i) => Math.cos((i / 63) * Math.PI / 2));

// Cuts that fill themselves in when a dropped file's name matches.
const RECIPES = [{
  name: "Madhuri set",
  cuts: [
    ["Aaja Nachle", ["nachle", "nach le"], "0:00", "1:30"],
    ["Ek Do Teen", ["123", "1 2 3", "ek do teen", "ekdoteen"], "0:54", "1:57"],
    ["Ghagra", ["ghagra"], "0:28", "1:48"],
    ["Dola Re Dola", ["dola"], "1:25", "2:24"],
    ["Badi Mushkil", ["mushkil", "whatsapp"], "0:06", "1:12"],
  ],
}];

/* ---------- State ---------- */
const state = {
  tracks: [], xf: 3, fadeOut: 3, level: true, snap: true, sync: true, vibe: "original",
  defStyle: "crossfade", mode: "build",
  liveStyle: "filter", liveLen: 2, quant: true, auto: true,
};
let nextId = 1;
let actx = null;
let mix = { buffer: null, key: "" };
let playing = null;    // { kind: 'cut' | 'mix', ... }
let liveBus = null;

function audio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === "suspended") actx.resume();
  return actx;
}

/* ---------- Helpers ---------- */
function fmt(sec, dec = 1) {
  if (!isFinite(sec)) return "–";
  const p = Math.pow(10, dec);
  const t = Math.round(Math.max(0, sec) * p) / p;
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = dec ? s.toFixed(dec).padStart(3 + dec, "0") : String(Math.round(s)).padStart(2, "0");
  return `${m}:${ss}`;
}
function parseTime(str) {
  str = String(str).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return +str;
  let m = str.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (m && +m[2] < 60) return +m[1] * 60 + +m[2];
  m = str.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (m && +m[2] < 60 && +m[3] < 60) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  return NaN;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const tick = () => new Promise(r => setTimeout(r, 0));
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
function cleanName(file) {
  return file.replace(/\.[^.]+$/, "").replace(/\b\d+\s*kbps\b/ig, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || file;
}
let toastT;
function toast(msg, undo) {
  const t = $("#toast"); t.replaceChildren(document.createTextNode(msg));
  if (undo) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = "Undo";
    b.addEventListener("click", () => { undo(); t.hidden = true; });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), undo ? 8000 : 3200);
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function colorVar(tr) { return `var(--t${(tr.color % 6) + 1})`; }
const coarse = matchMedia("(pointer: coarse)").matches;

/* ---------- Saved session (this browser only) ---------- */
// Song files and the whole setup live in IndexedDB, so a refresh or a
// later visit picks up where the user left off. If storage is blocked
// the page still works, it just can't remember.
const store = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open("mashup-mela", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("files"); r.result.createObjectStore("session"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("blocked"));
    } catch (e) { rej(e); }
  }));
  const tx = async (name, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode), req = fn(t.objectStore(name));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    putFile: (id, f) => tx("files", "readwrite", s => s.put(f, id)),
    getFile: id => tx("files", "readonly", s => s.get(id)),
    fileKeys: () => tx("files", "readonly", s => s.getAllKeys()),
    delFile: id => tx("files", "readwrite", s => s.delete(id)),
    putSession: v => tx("session", "readwrite", s => s.put(v, "current")),
    getSession: () => tx("session", "readonly", s => s.get("current")),
    clear: () => Promise.all([tx("files", "readwrite", s => s.clear()), tx("session", "readwrite", s => s.clear())]),
  };
})();
let saveT = 0, restoring = true, storageOK = true;   // nothing saves until the old session is read back
let restoreDone = Promise.resolve();
function storageFail() {
  if (!storageOK) return;
  storageOK = false;
  toast("This browser isn't letting the page save, so a refresh will clear your songs.");
}
function persist() {
  if (restoring || !storageOK) return;
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (!restoring) store.putSession(sessionData()).catch(storageFail); }, 400);
}
const SAVED_SETTINGS = ["xf", "fadeOut", "level", "snap", "sync", "vibe", "defStyle", "liveStyle", "liveLen", "quant", "auto"];
function sessionData() {
  const settings = {};
  SAVED_SETTINGS.forEach(k => (settings[k] = state[k]));
  Object.assign(settings, { mixName: $("#mixName").value, vidShape: $("#vidShape").value, vidLen: $("#vidLen").value });
  return {
    v: 1, nextId, settings,
    tracks: state.tracks.map(t => ({ id: t.id, name: t.name, fileName: t.fileName, start: t.start, end: t.end,
      trans: t.trans, recipe: t.recipe, order: t.order, color: t.color, beat: t.beat })),
  };
}
function applySettings(s) {
  if (!s) return;
  SAVED_SETTINGS.forEach(k => { if (k in s) state[k] = s[k]; });
  $("#xf").value = state.xf; $("#xfOut").textContent = state.xf.toFixed(1) + " s";
  $("#fo").value = state.fadeOut; $("#foOut").textContent = state.fadeOut.toFixed(1) + " s";
  $("#defStyle").value = state.defStyle; $("#level").checked = state.level; $("#snap").checked = state.snap;
  $("#liveStyle").value = state.liveStyle; $("#liveLen").value = state.liveLen; $("#liveLenOut").textContent = state.liveLen.toFixed(1) + " s";
  $("#quant").checked = state.quant; $("#auto").checked = state.auto;
  setSync(state.sync);
  document.querySelectorAll("#vibeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.vibe === state.vibe));
  if (s.mixName) $("#mixName").value = s.mixName;
  if (s.vidShape) $("#vidShape").value = s.vidShape;
  if (s.vidLen) $("#vidLen").value = s.vidLen;
}
async function restoreSession() {
  try { await restoreInner(); } finally { restoring = false; renderAll(); }
}
async function restoreInner() {
  let s;
  try { s = await store.getSession(); } catch (e) { storageOK = false; return; }
  if (!s || s.v !== 1) return;
  applySettings(s.settings);
  const saved = s.tracks || [];
  if (saved.length) {
    const c = audio(); let failed = 0;
    for (let i = 0; i < saved.length; i++) {
      const t = saved[i];
      setStatus(`Restoring your last session: ${t.name} (${i + 1} of ${saved.length})…`);
      await tick();
      try {
        const file = await store.getFile(t.id);
        const buffer = await decodeFile(c, file);
        state.tracks.push({ ...t, buffer, duration: buffer.duration, peaks: computePeaks(buffer),
          energy: energyEnv(buffer), beat: t.beat || detectBeats(buffer) });
      } catch (e) { failed++; }
    }
    nextId = Math.max(s.nextId || 1, ...state.tracks.map(t => t.id + 1));
    setStatus(failed ? `Restored ${saved.length - failed} songs. ${failed} couldn't be restored. Add ${failed > 1 ? "them" : "it"} again.` : "Picked up where you left off.", failed > 0);
    if (!failed) setTimeout(() => { if ($("#status").textContent === "Picked up where you left off.") setStatus(""); }, 4000);
  }
  // drop stored files nothing refers to any more (removed songs)
  try {
    const keep = new Set(state.tracks.map(t => t.id));
    for (const k of await store.fileKeys()) if (!keep.has(k)) await store.delFile(k);
  } catch (e) {}
}

/* ---------- Analysis ---------- */
function computePeaks(buf, n = 3000) {
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const peaks = new Float32Array(n), step = buf.length / n;
  let top = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = Math.floor(i * step), e = Math.min(buf.length, Math.floor((i + 1) * step));
    for (let j = s; j < e; j += 4) { const v = Math.abs(a[j]) + Math.abs(b[j]); if (v > m) m = v; }
    peaks[i] = m; if (m > top) top = m;
  }
  if (top > 0) for (let i = 0; i < n; i++) peaks[i] /= top;
  return peaks;
}

// Tempo + beat grid from an onset-energy envelope: autocorrelation for the
// rough period, then a comb search over period and phase to lock the grid.
function detectBeats(buf) {
  const sr = buf.sampleRate, hop = Math.round(sr * 0.01), win = hop * 2;
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const len = Math.min(buf.length, sr * 180);
  const n = Math.floor((len - win) / hop);
  if (n < 400) return { bpm: 120, period: 0.5, phase: 0 };
  const le = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0; const s = k * hop;
    for (let j = s; j < s + win; j += 2) { const v = a[j] + b[j]; e += v * v; }
    le[k] = Math.log(1e-6 + e);
  }
  const on = new Float32Array(n);
  for (let k = 1; k < n; k++) on[k] = Math.max(0, le[k] - le[k - 1]);
  // subtract a local mean so sustained loud passages don't dominate
  const w = 25, o2 = new Float32Array(n); let acc = 0;
  for (let k = 0; k < n; k++) {
    acc += on[k]; if (k >= 2 * w) acc -= on[k - 2 * w];
    const c = k - w; if (c >= 0) o2[c] = Math.max(0, on[c] - acc / (2 * w));
  }
  const minLag = Math.floor(6000 / 180), maxLag = Math.ceil(6000 / 70);
  let best = minLag, bestS = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let k = 0; k + lag < n; k++) s += o2[k] * o2[k + lag];
    s /= (n - lag);
    const bpm = 6000 / lag, prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.55, 2));
    s *= prior;
    if (s > bestS) { bestS = s; best = lag; }
  }
  let bestP = best, bestPh = 0; bestS = -1;
  for (let P = best - 1.2; P <= best + 1.2; P += 0.04) {
    for (let ph = 0; ph < P; ph += 1) {
      let s = 0, c = 0;
      for (let t = ph; t < n; t += P) { const i = Math.round(t); s += (o2[i] || 0) + 0.5 * ((o2[i - 1] || 0) + (o2[i + 1] || 0)); c++; }
      s /= c;
      if (s > bestS) { bestS = s; bestP = P; bestPh = ph; }
    }
  }
  const period = bestP * hop / sr;
  return { bpm: 60 / period, period, phase: (bestPh * hop + win / 2) / sr };
}

// Loudness (dB) in quarter-second steps, used by the hook finder.
function energyEnv(buf) {
  const sr = buf.sampleRate, hop = Math.floor(sr * 0.25);
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const n = Math.floor(buf.length / hop), db = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let j = k * hop; j < (k + 1) * hop; j += 8) { const v = a[j] + b[j]; s += v * v; c++; }
    db[k] = 10 * Math.log10(s / c + 1e-10);
  }
  return { hop: 0.25, db };
}

// The hook: the loudest phrase-long stretch, preferring one that kicks in
// with a jump in energy (how choruses usually arrive), cut on bar lines.
function findHook(tr, target = 48) {
  const { db, hop } = tr.energy, n = db.length, dur = tr.duration;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + db[i];
  const mean = (s, e) => {
    const a = clamp(Math.floor(s / hop), 0, n), b = clamp(Math.floor(e / hop), 0, n);
    return b > a ? (pre[b] - pre[a]) / (b - a) : -120;
  };
  const bar = 4 * tr.beat.period;
  let bars = Math.max(4, Math.round(target / bar / 4) * 4), W = bars * bar;
  while (W > dur * 0.7 && bars > 4) { bars -= 4; W = bars * bar; }
  let best = null;
  for (let s = tr.beat.phase; s + W <= dur - 4; s += bar) {
    if (s < 6) continue;
    const m = mean(s, s + W), jump = mean(s, s + 4) - mean(s - 6, s);
    const score = m + 0.5 * clamp(jump, -6, 12) - (s < dur * 0.1 ? 3 : 0);
    if (!best || score > best.score) best = { score, start: s, end: s + W, loud: m };
  }
  return best || { start: 0, end: Math.min(dur, W), loud: mean(0, dur) };
}

function snapTime(tr, t) {
  if (!state.snap || !tr.beat) return t;
  const { period, phase } = tr.beat;
  return clamp(phase + Math.round((t - phase) / period) * period, 0, tr.duration);
}

function levelGain(tr) {
  if (!state.level) return 1;
  const key = tr.start.toFixed(2) + "-" + tr.end.toFixed(2);
  if (tr.gainKey === key) return tr.gain;
  const buf = tr.buffer, sr = buf.sampleRate;
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const s = Math.floor(tr.start * sr), e = Math.min(buf.length, Math.floor(tr.end * sr));
  let sum = 0, c = 0;
  for (let i = s; i < e; i += 6) { sum += a[i] * a[i] + b[i] * b[i]; c += 2; }
  const rms = Math.sqrt(sum / Math.max(1, c));
  tr.gain = clamp(TARGET_RMS / Math.max(rms, 1e-4), 0.25, 4);
  tr.gainKey = key;
  return tr.gain;
}

/* ---------- Audio graph (shared by the offline render and live play) ---------- */
// Freeverb: parallel damped combs into series allpasses, one chain per ear
// with slightly different lengths for width.
const FV = { combs: [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps: [556, 441, 341, 225], room: 0.938, damp: 0.2 };

// Offline version: runs straight over the rendered mix in JS. A node graph
// or ConvolverNode made the "Slowed + reverb" render 4-6x slower.
function freeverbInPlace(buf, wet) {
  const n = buf.length, k = buf.sampleRate / 44100;
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const tails = [0, 23].map(spread => {
    const cb = FV.combs.map(d => new Float32Array(Math.round((d + spread) * k)));
    const ci = new Int32Array(cb.length), cf = new Float32Array(cb.length);
    const ab = FV.aps.map(d => new Float32Array(Math.round((d + spread) * k)));
    const ai = new Int32Array(ab.length);
    const out = new Float32Array(n), room = FV.room, d1 = FV.damp, d2 = 1 - FV.damp;
    for (let t = 0; t < n; t++) {
      const x = (L[t] + R[t]) * 0.015;
      let y = 0;
      for (let j = 0; j < cb.length; j++) {
        const b = cb[j], i = ci[j], o = b[i];
        cf[j] = o * d2 + cf[j] * d1;
        b[i] = x + cf[j] * room;
        ci[j] = i + 1 === b.length ? 0 : i + 1;
        y += o;
      }
      for (let j = 0; j < ab.length; j++) {
        const b = ab[j], i = ai[j], bo = b[i];
        b[i] = y + bo * 0.5;
        ai[j] = i + 1 === b.length ? 0 : i + 1;
        y = bo - y;
      }
      out[t] = y;
    }
    return out;
  });
  const g = wet * 3;
  let peak = 0;
  for (let t = 0; t < n; t++) {
    L[t] += g * tails[0][t];
    if (R !== L) R[t] += g * tails[1][t];
    peak = Math.max(peak, Math.abs(L[t]), Math.abs(R[t]));
  }
  if (peak > 0.97) {
    const s = 0.97 / peak;
    for (let t = 0; t < n; t++) { L[t] *= s; if (R !== L) R[t] *= s; }
  }
}

// Live version as audio nodes (real time, so node count doesn't matter).
function makeReverb(c) {
  const input = c.createGain(), output = c.createGain();
  const pre = c.createBiquadFilter(); pre.type = "lowpass"; pre.frequency.value = 7000;
  input.connect(pre);
  const merge = c.createChannelMerger(2);
  [0, 23].forEach((spread, ch) => {
    const sum = c.createGain(); sum.gain.value = 0.015 * 3 * 2;   // Freeverb's input gain and wet scale (input is summed L+R)
    FV.combs.forEach(n => {
      const d = c.createDelay(1); d.delayTime.value = (n + spread) / 44100;
      // one-pole damping (gain never above 1, so the loop can't run away the
      // way a resonant biquad lowpass does)
      const damp = c.createIIRFilter([1 - FV.damp], [1, -FV.damp]);
      const fb = c.createGain(); fb.gain.value = FV.room;
      pre.connect(d); d.connect(damp).connect(fb).connect(d); d.connect(sum);
    });
    let node = sum;
    FV.aps.forEach(n => {   // Schroeder allpass: y = -g*s + delay(s), s = x + g*delay(s)
      const s = c.createGain(), d = c.createDelay(1), g = 0.5;
      d.delayTime.value = (n + spread) / 44100;
      const back = c.createGain(); back.gain.value = g;
      const fwd = c.createGain(); fwd.gain.value = -g;
      const out = c.createGain();
      node.connect(s); s.connect(d); d.connect(back).connect(s);
      s.connect(fwd).connect(out); d.connect(out);
      node = out;
    });
    node.connect(merge, 0, ch);
  });
  merge.connect(output);
  return { input, output };
}
function makeMaster(c, wet, alwaysReverb) {
  const input = c.createGain();
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -4; comp.knee.value = 3; comp.ratio.value = 12;
  comp.attack.value = 0.003; comp.release.value = 0.2;
  input.connect(comp);
  let wetGain = null;
  if (wet > 0 || alwaysReverb) {
    const rv = makeReverb(c);
    wetGain = c.createGain(); wetGain.gain.value = wet;
    input.connect(rv.input); rv.output.connect(wetGain).connect(comp);
  }
  const out = c.createGain();
  comp.connect(out);
  return { input, out, wetGain };
}
function beatSec(tr) { return tr.beat ? tr.beat.period : 0.5; }

function makeVoice(c, tr, dest, rate) {
  const src = c.createBufferSource(); src.buffer = tr.buffer; src.playbackRate.value = rate;
  const lvl = c.createGain(); lvl.gain.value = levelGain(tr);
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 10;
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = Math.min(20000, c.sampleRate / 2 - 100);
  const env = c.createGain();
  src.connect(lvl).connect(hp).connect(lp).connect(env).connect(dest);
  // echo send taps before the envelope so repeats ring on after the dry cut
  const send = c.createGain(); send.gain.value = 0;
  const delay = c.createDelay(3); delay.delayTime.value = Math.min(2.5, beatSec(tr) * 0.75 / rate);
  const fb = c.createGain(); fb.gain.value = 0.5;
  lp.connect(send).connect(delay); delay.connect(fb).connect(delay); delay.connect(dest);
  return { src, lvl, hp, lp, env, send, tr, rate };
}

// Transition timing: styles with overlap blend the two songs over L seconds.
const overlapOf = (style, L) => (style === "crossfade" || style === "filter" || style === "riser") ? L : 0;
const inFadeOf = (style, L) => style === "cut" ? 0.015 : style === "echo" ? Math.min(L, 1.5) : L;

function holdAt(p, T) {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(T); else p.cancelScheduledValues(T);
}
function fadeOut(c, v, T, L, live) {
  const p = v.env.gain;
  try {
    if (live) { holdAt(p, T); p.setTargetAtTime(0, T, L / 4); }
    else p.setValueCurveAtTime(CURVE_OUT, T, L);
  } catch (e) { /* overlapping ramps on rapid live taps: the stop() below still ends it */ }
}
function applyOut(c, v, style, T, L, live) {
  const nyq = c.sampleRate / 2 - 100;
  if (style === "cut") { fadeOut(c, v, T, 0.015, live); v.src.stop(T + 0.1); return; }
  if (style === "echo") {
    const beat = beatSec(v.tr) / v.rate, s0 = Math.max(live ? c.currentTime : 0, T - beat);
    v.send.gain.setValueAtTime(0, s0);
    v.send.gain.linearRampToValueAtTime(0.85, s0 + 0.03);
    v.send.gain.setValueAtTime(0.85, T);
    v.send.gain.linearRampToValueAtTime(0, T + 0.03);
    fadeOut(c, v, T, 0.03, live);
    v.src.stop(T + 0.1);
    return;
  }
  if (style === "filter") {
    v.hp.frequency.setValueAtTime(10, T);
    v.hp.frequency.exponentialRampToValueAtTime(Math.min(3000, nyq), T + L);
  }
  fadeOut(c, v, T, L, live);
  v.src.stop(T + L + 0.1);
}
function applyIn(c, v, style, T, L, live) {
  const p = v.env.gain, F = inFadeOf(style, L);
  p.value = 0;
  if (style === "filter") {
    v.lp.frequency.setValueAtTime(250, T);
    v.lp.frequency.exponentialRampToValueAtTime(Math.min(20000, c.sampleRate / 2 - 100), T + L);
  }
  if (live) { p.setValueAtTime(0, T); p.setTargetAtTime(1, T, F / 4); }
  else p.setValueCurveAtTime(CURVE_IN, T, F);
}
function riser(c, dest, T, L, from) {
  const s0 = Math.max(from, T - L), dur = T - s0 + 0.3;
  if (T - s0 < 0.2) return;
  const n = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = n.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = n;
  const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(350, s0); bp.frequency.exponentialRampToValueAtTime(7500, T);
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, s0);
  g.gain.exponentialRampToValueAtTime(0.22, T); g.gain.exponentialRampToValueAtTime(0.0001, T + 0.3);
  src.connect(bp).connect(g).connect(dest); src.start(s0); src.stop(T + 0.3);
}

/* ---------- Tempo sync ---------- */
const MAX_NUDGE = 1.12;   // furthest we'll speed up or slow a song to lock tempos
const SYNC_RAMP = 4;      // seconds to ease back to the song's own tempo

// Rate for the incoming song so its beat lands on the outgoing one's
// (allowing half/double time), or null when they're too far apart.
function syncRatio(outTr, inTr) {
  if (!outTr.beat || !inTr.beat) return null;
  let best = null;
  for (const m of [0.5, 1, 2]) {
    const r = outTr.beat.bpm * m / inTr.beat.bpm;
    if (!best || Math.abs(Math.log(r)) < Math.abs(Math.log(best))) best = r;
  }
  return Math.abs(Math.log(best)) <= Math.log(MAX_NUDGE) ? best : null;
}
function beatLen(L, tr, rate) {
  const beat = tr.beat.period / rate;
  return Math.max(2, Math.round(L / beat)) * beat;
}
// Buffer position of a live voice at context time t (handles the sync ramp).
function voicePos(v, t) {
  const dt = Math.max(0, t - v.startT), b = v.rate;
  if (!v.ramp) return v.offset + dt * b;
  const { L, R, r } = v.ramp;
  if (dt <= L) return v.offset + dt * b * r;
  if (dt <= L + R) { const x = dt - L; return v.offset + b * (r * L + r * x + (1 - r) * x * x / (2 * R)); }
  return v.offset + b * (r * L + (r + 1) / 2 * R + (dt - L - R));
}
// Inverse of voicePos: the context time at which buffer position p plays.
function timeAtPos(v, p) {
  const q = (p - v.offset) / v.rate;
  if (!v.ramp) return v.startT + q;
  const { L, R, r } = v.ramp, a = r * L, b = (r + 1) / 2 * R;
  if (q <= a) return v.startT + q / r;
  if (q <= a + b) {
    const k = (1 - r) / (2 * R), rest = q - a;
    const x = Math.abs(k) < 1e-9 ? rest / r : (-r + Math.sqrt(Math.max(0, r * r + 4 * k * rest))) / (2 * k);
    return v.startT + L + x;
  }
  return v.startT + L + R + (q - a - b);
}

/* ---------- Mix plan ---------- */
function styleOf(tr) { return tr.trans || state.defStyle; }
function junction(outTr, inTr, style, rate) {
  let L = state.xf, r = null;
  if (state.sync && overlapOf(style, 1) > 0) {
    r = syncRatio(outTr, inTr);
    if (r) L = beatLen(L, outTr, rate);
  }
  return { L, r, ov: overlapOf(style, L) };
}
function plan() {
  const rate = VIBES[state.vibe].rate, n = state.tracks.length;
  const segs = []; let t = 0, prevJ = null;
  state.tracks.forEach((tr, i) => {
    const B = tr.end - tr.start;
    let len = B / rate, ramp = null;
    if (prevJ && prevJ.r) {
      const { r, L } = prevJ, left = B - rate * r * L;
      const R = clamp(left / (rate * (r + 1) / 2) * 0.5, 0, SYNC_RAMP);
      ramp = { r, L, R };
      len = L + R + (left - rate * (r + 1) / 2 * R) / rate;
    }
    const style = i < n - 1 ? styleOf(tr) : null;
    const j = style ? junction(tr, state.tracks[i + 1], style, rate) : null;
    segs.push({ tr, at: t, len, style, ov: j ? j.ov : 0, L: j ? j.L : state.xf, j, ramp, prevJ });
    t += len - (j ? j.ov : 0);
    prevJ = j;
  });
  const last = segs[segs.length - 1];
  return { segs, total: last ? last.at + last.len : 0, rate };
}
function problems(tr, i, P) {
  if (!(tr.end > tr.start)) return "The end has to come after the start.";
  if (tr.end > tr.duration + 0.05) return `The end is past the song's length (${fmt(tr.duration)}).`;
  const s = P.segs[i], prev = P.segs[i - 1];
  const need = (prev ? inFadeOf(prev.style, prev.L) : 0) +
    (s.style ? Math.max(s.ov, 0.05) : state.fadeOut) + 0.3;
  if (s.len < need || (s.ramp && tr.end - tr.start < P.rate * s.ramp.r * s.ramp.L))
    return `This cut is ${s.len.toFixed(1)} s, but its transitions need ${need.toFixed(1)} s. Make the cut longer or the transitions shorter.`;
  return "";
}
function mixKey() {
  return JSON.stringify([state.xf, state.fadeOut, state.level, state.vibe, state.defStyle, state.sync,
    state.tracks.map(t => [t.id, t.start, t.end, t.trans || "", t.beat.period])]);
}
function allValid() {
  const P = plan();
  return state.tracks.length > 0 && state.tracks.every((t, i) => !problems(t, i, P));
}

async function renderMix() {
  const key = mixKey();
  if (mix.buffer && mix.key === key) return mix.buffer;
  const P = plan(), sr = 48000, vibe = VIBES[state.vibe];
  const c = new OfflineAudioContext(2, Math.ceil((P.total + 0.3) * sr), sr);
  const M = makeMaster(c, 0, false);   // reverb is added after rendering (see freeverbInPlace)
  M.out.connect(c.destination);
  P.segs.forEach((s, i) => {
    const v = makeVoice(c, s.tr, M.input, P.rate);
    if (s.ramp) {
      const { r, L, R } = s.ramp, pr = v.src.playbackRate;
      pr.setValueAtTime(P.rate * r, s.at);
      pr.setValueAtTime(P.rate * r, s.at + L);
      if (R > 0) pr.linearRampToValueAtTime(P.rate, s.at + L + R);
    }
    v.src.start(s.at, s.tr.start);
    const prev = P.segs[i - 1];
    if (prev) applyIn(c, v, prev.style, s.at, prev.L, false);
    if (s.style) {
      const T = s.at + s.len - s.ov;
      applyOut(c, v, s.style, T, s.L, false);
      if (s.style === "riser") riser(c, M.input, T, s.L, 0);
    } else {
      if (state.fadeOut > 0) v.env.gain.setValueCurveAtTime(CURVE_OUT, s.at + s.len - state.fadeOut, state.fadeOut);
      v.src.stop(s.at + s.len + 0.05);
    }
  });
  const buf = await c.startRendering();
  if (vibe.wet > 0) freeverbInPlace(buf, vibe.wet);
  mix = { buffer: buf, key };
  return buf;
}

/* ---------- Decoding ---------- */
// Browsers reject a whole MP4/MOV when its first sound track is in a format
// they can't play, like the Spatial Audio track newer iPhones put first.
// Those videos usually carry a plain AAC track too, so when the direct
// decode fails we find that track, repackage it as an .m4a with mp4-muxer
// and decode that instead. It all happens on the device.
const CODEC_NAMES = { apac: "Apple Spatial Audio", "ac-3": "Dolby Digital", "ec-3": "Dolby Digital Plus", "ac-4": "Dolby AC-4", alac: "Apple Lossless" };

async function decodeFile(c, file) {
  try { return await c.decodeAudioData(await file.arrayBuffer()); }
  catch (e) {
    let bytes, tracks = null;
    try { bytes = new Uint8Array(await file.arrayBuffer()); tracks = mp4SoundTracks(bytes); } catch (_) {}
    if (!tracks || typeof Mp4Muxer === "undefined") throw e;   // not an MP4/MOV we can read
    const aac = tracks.find(t => t.codec === "mp4a" && t.asc && t.samples.length);
    if (!aac) {
      const names = [...new Set(tracks.map(t => CODEC_NAMES[t.codec] || t.codec.toUpperCase()))];
      const err = new Error("no playable sound track");
      err.why = names.length ? `its sound is in ${names.join(" and ")} format, which browsers can't open` : "it has no sound";
      throw err;
    }
    return await c.decodeAudioData(remuxAac(bytes, aac));
  }
}

// The sound tracks of an MP4/MOV: codec, AAC config and sample table.
// Returns null when the bytes aren't an MP4/MOV file.
function mp4SoundTracks(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fourcc = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const kids = (s, e) => {   // child boxes of the range [s, e), with s/e marking each payload
    const out = [];
    while (s + 8 <= e) {
      let size = dv.getUint32(s), h = 8;
      if (size === 1) { size = Number(dv.getBigUint64(s + 8)); h = 16; }
      else if (size === 0) size = e - s;
      if (size < h || s + size > e) break;
      out.push({ type: fourcc(s + 4), s: s + h, e: s + size });
      s += size;
    }
    return out;
  };
  const child = (box, ...path) => { for (const t of path) box = box && kids(box.s, box.e).find(k => k.type === t); return box; };
  const moov = kids(0, b.length).find(k => k.type === "moov");
  if (!moov) return null;
  const tracks = [];
  for (const trak of kids(moov.s, moov.e).filter(k => k.type === "trak")) {
    const hdlr = child(trak, "mdia", "hdlr"), mdhd = child(trak, "mdia", "mdhd"), stbl = child(trak, "mdia", "minf", "stbl");
    if (!hdlr || !mdhd || !stbl || fourcc(hdlr.s + 8) !== "soun") continue;
    const stsd = child(stbl, "stsd"), entry = stsd && kids(stsd.s + 8, stsd.e)[0];
    if (!entry) continue;
    const t = { codec: entry.type.trim().toLowerCase(), scale: dv.getUint32(mdhd.s + (b[mdhd.s] === 1 ? 20 : 12)), asc: null, samples: [] };
    if (t.codec === "mp4a") {
      t.asc = esdsConfig(b, dv, entry);
      try { t.samples = sampleTable(dv, n => child(stbl, n)); } catch (e) { t.samples = []; }
    }
    tracks.push(t);
  }
  return tracks;
}
// AudioSpecificConfig from the esds box, which MOV files tuck inside a
// 'wave' box after a version-dependent header, so we scan for it.
function esdsConfig(b, dv, entry) {
  for (let o = entry.s + 4; o + 8 <= entry.e; o++) {
    if (b[o] !== 0x65 || b[o + 1] !== 0x73 || b[o + 2] !== 0x64 || b[o + 3] !== 0x73) continue;   // "esds"
    return descConfig(b, o + 8, Math.min(entry.e, o - 4 + dv.getUint32(o - 4)));
  }
  return null;
}
function descConfig(b, o, end) {
  while (o + 2 <= end) {
    const tag = b[o++]; let len = 0, k = 0;
    do len = (len << 7) | (b[o] & 0x7f); while ((b[o++] & 0x80) && ++k < 4);
    if (tag === 3) {   // ES descriptor: skip id, flags and optional fields
      const f = b[o + 2]; let p = o + 3;
      if (f & 0x80) p += 2;
      if (f & 0x40) p += 1 + b[p];
      if (f & 0x20) p += 2;
      return descConfig(b, p, o + len);
    }
    if (tag === 4) return descConfig(b, o + 13, o + len);   // decoder config: skip fixed fields
    if (tag === 5) return b.slice(o, o + len);               // decoder-specific info
    o += len;
  }
  return null;
}
// File offset, size and duration of every sample, from stsz/stsc/stco/stts.
function sampleTable(dv, box) {
  const stsz = box("stsz"), stsc = box("stsc"), stts = box("stts"), stco = box("stco"), co64 = box("co64");
  if (!stsz || !stsc || !stts || !(stco || co64)) return [];
  const fixed = dv.getUint32(stsz.s + 4), n = dv.getUint32(stsz.s + 8);
  const nChunks = dv.getUint32((stco || co64).s + 4), runs = dv.getUint32(stsc.s + 4);
  const chunkAt = i => stco ? dv.getUint32(stco.s + 8 + 4 * i) : Number(dv.getBigUint64(co64.s + 8 + 8 * i));
  const out = [];
  for (let r = 0, si = 0; r < runs; r++) {
    const first = dv.getUint32(stsc.s + 8 + 12 * r) - 1, per = dv.getUint32(stsc.s + 12 + 12 * r);
    const last = r + 1 < runs ? dv.getUint32(stsc.s + 20 + 12 * r) - 1 : nChunks;
    for (let ch = first; ch < last; ch++) {
      let off = chunkAt(ch);
      for (let k = 0; k < per && si < n; k++, si++) {
        const size = fixed || dv.getUint32(stsz.s + 12 + 4 * si);
        out.push({ off, size, dur: 1024 }); off += size;
      }
    }
  }
  for (let r = 0, i = 0, runsT = dv.getUint32(stts.s + 4); r < runsT; r++) {
    const count = dv.getUint32(stts.s + 8 + 8 * r), d = dv.getUint32(stts.s + 12 + 8 * r);
    for (let k = 0; k < count && i < out.length; k++) out[i++].dur = d;
  }
  return out;
}
// One AAC track as a standalone .m4a that every browser can decode.
function remuxAac(b, t) {
  const a = t.asc, RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const fi = ((a[0] & 7) << 1) | (a[1] >> 7);
  const sampleRate = fi === 15 ? ((a[1] & 0x7f) << 17) | (a[2] << 9) | (a[3] << 1) | (a[4] >> 7) : RATES[fi];
  const channels = ((fi === 15 ? a[4] : a[1]) >> 3 & 15) || 2;
  const mux = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), audio: { codec: "aac", numberOfChannels: channels, sampleRate },
    fastStart: "in-memory", firstTimestampBehavior: "offset" });
  const meta = { decoderConfig: { codec: `mp4a.40.${a[0] >> 3}`, numberOfChannels: channels, sampleRate, description: a } };
  let ts = 0;
  t.samples.forEach((s, i) => {
    mux.addAudioChunkRaw(b.subarray(s.off, s.off + s.size), "key", Math.round(ts * 1e6 / t.scale), Math.round(s.dur * 1e6 / t.scale), i ? undefined : meta);
    ts += s.dur;
  });
  mux.finalize();
  return mux.target.buffer;
}

/* ---------- Adding files ---------- */
function matchRecipe(fileName) {
  const n = norm(fileName), nn = n.replace(/ /g, "");
  for (const r of RECIPES) {
    for (let i = 0; i < r.cuts.length; i++) {
      const [label, keys, s, e] = r.cuts[i];
      if (keys.some(k => n.includes(k) || nn.includes(k.replace(/ /g, "")))) return { recipe: r.name, order: i, label, s: parseTime(s), e: parseTime(e) };
    }
  }
  return null;
}

async function addFiles(files) {
  files = [...files].filter(f => /^(audio|video)\//.test(f.type) || /\.(mp3|m4a|aac|wav|ogg|opus|flac|mp4|webm|mov|mkv)$/i.test(f.name));
  if (!files.length) { setStatus("Those files don't look like audio or video. Try MP3, M4A, WAV or MP4.", true); return; }
  // new songs take ids after the restored ones, so a saved file is never overwritten
  if (restoring) await restoreDone;
  const c = audio();
  let matched = false, failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setStatus(`Reading ${f.name} (${i + 1} of ${files.length})…`);
    await tick();
    let buffer;
    try { buffer = await decodeFile(c, f); }
    catch (e) { failed.push({ name: f.name, why: e.why }); continue; }
    setStatus(`Finding the beat in ${f.name}…`);
    await tick();
    const tr = {
      id: nextId, color: (nextId - 1) % 6, name: cleanName(f.name), fileName: f.name,
      buffer, duration: buffer.duration, peaks: computePeaks(buffer), beat: detectBeats(buffer), energy: energyEnv(buffer),
      start: 0, end: buffer.duration, trans: null, recipe: null, order: 999,
    };
    nextId++;
    const m = matchRecipe(f.name);
    if (m && m.e <= buffer.duration + 0.5) {
      Object.assign(tr, { name: m.label, start: m.s, end: Math.min(m.e, buffer.duration), recipe: m.recipe, order: m.order });
      matched = true;
    }
    state.tracks.push(tr);
    if (storageOK) store.putFile(tr.id, f).catch(storageFail);
  }
  if (matched) {
    const idx = new Map(state.tracks.map((t, i) => [t, i]));
    state.tracks.sort((a, b) => (a.order - b.order) || (idx.get(a) - idx.get(b)));
  }
  setStatus(failed.map(x => x.why ? `Couldn't use ${x.name}: ${x.why}. Try a screen recording or an MP3 copy.`
    : `Couldn't read ${x.name}. Your browser can't decode that format. Try an MP3 or M4A copy.`).join(" "), failed.length > 0);
  renderAll();
}
function setStatus(msg, err) { const s = $("#status"); s.textContent = msg; s.classList.toggle("err", !!err); }

/* ---------- Hooks, Auto mashup, undo ---------- */
function snapshot() {
  const s = { order: state.tracks.slice(), sync: state.sync,
    cuts: state.tracks.map(t => ({ t, start: t.start, end: t.end, trans: t.trans, recipe: t.recipe })) };
  return () => {
    state.tracks = s.order.slice();
    s.cuts.forEach(c => Object.assign(c.t, { start: c.start, end: c.end, trans: c.trans, recipe: c.recipe }));
    setSync(s.sync);
    renderAll();
  };
}
function hookTrack(tr) {
  const undo = snapshot(), h = findHook(tr);
  tr.start = h.start; tr.end = h.end; tr.recipe = "Hook";
  renderAll();
  toast(`Found the hook in ${tr.name}: ${fmt(h.start, 0)}–${fmt(h.end, 0)}`, undo);
}
function normBpm(b) { while (b < 78) b *= 2; while (b >= 156) b /= 2; return b; }
function autoMashup() {
  if (!state.tracks.length) return;
  const undo = snapshot(), n = state.tracks.length;
  const target = n <= 4 ? 50 : n <= 6 ? 42 : 34;
  const loud = new Map();
  state.tracks.forEach(t => { const h = findHook(t, target); t.start = h.start; t.end = h.end; t.recipe = "Auto"; loud.set(t, h.loud); });
  // Build energy by climbing in tempo.
  state.tracks.sort((a, b) => normBpm(a.beat.bpm) - normBpm(b.beat.bpm));
  setSync(true);
  const peak = state.tracks.reduce((m, t) => (loud.get(t) > loud.get(m) ? t : m), state.tracks[0]);
  state.tracks.forEach((t, i) => {
    const nx = state.tracks[i + 1];
    if (!nx) { t.trans = null; return; }
    const r = syncRatio(t, nx);
    t.trans = nx === peak ? "riser" : r && Math.abs(r - 1) < 0.03 ? "crossfade" : r ? "filter" : "echo";
  });
  renderAll();
  toast(`Auto mashup ready: ${n} hooks, ${fmt(plan().total, 0)} long. Press play.`, undo);
}
function setSync(on) {
  state.sync = on;
  $("#sync").checked = on; $("#liveSync").checked = on;
}

/* ---------- Track cards ---------- */
const ICON = {
  up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

function buildCard(tr) {
  const li = document.createElement("li");
  li.className = "track";
  li.innerHTML = `
    <div class="thead">
      <span class="num"></span>
      <input class="tname" id="name-${tr.id}" aria-label="Song name" spellcheck="false">
      <span class="tmeta"><span class="mono dur"></span>
        <span class="bpm" title="Detected tempo. If it looks off, halve or double it."><span class="bv"></span><button type="button" data-bpm="0.5" aria-label="Halve tempo">&frac12;</button><button type="button" data-bpm="2" aria-label="Double tempo">&times;2</button></span>
      </span>
      <span class="actions">
        <button type="button" class="icon-btn" data-act="up" aria-label="Move up">${ICON.up}</button>
        <button type="button" class="icon-btn" data-act="down" aria-label="Move down">${ICON.down}</button>
        <button type="button" class="icon-btn" data-act="rm" aria-label="Remove">${ICON.x}</button>
      </span>
    </div>
    <div class="wave"><canvas aria-label="Waveform: drag to choose the cut, click to listen"></canvas><div class="playhead" hidden></div></div>
    <div class="cut">
      <label for="start-${tr.id}">From <input id="start-${tr.id}" data-edge="start" inputmode="decimal"></label>
      <label for="end-${tr.id}">To <input id="end-${tr.id}" data-edge="end" inputmode="decimal"></label>
      <span class="cutlen"></span>
      <span class="spacer"></span>
      <button type="button" class="btn quiet" data-act="hook">Find the hook</button>
      <button type="button" class="btn" data-act="play">Play cut</button>
    </div>
    <p class="warn" hidden></p>`;
  tr.el = li;
  tr.canvas = $("canvas", li);
  tr.headEl = $(".playhead", li);
  const nameIn = $(".tname", li);
  nameIn.value = tr.name;
  nameIn.addEventListener("input", () => { tr.name = nameIn.value || tr.fileName; refreshMixPanel(); renderPads(); });

  li.addEventListener("click", e => {
    const b = e.target.closest("[data-act],[data-bpm]"); if (!b) return;
    if (b.dataset.bpm) {
      const f = +b.dataset.bpm; tr.beat.period /= f; tr.beat.bpm *= f;
      refreshMixPanel(); renderPads(); return;
    }
    const i = state.tracks.indexOf(tr), act = b.dataset.act;
    if (act === "play") { togglePreview(tr, tr.start); return; }
    if (act === "hook") { stopAll(); hookTrack(tr); return; }
    if (act === "rm") {
      stopAll();
      const undo = snapshot();
      state.tracks.splice(i, 1);
      renderAll();
      toast(`Removed ${tr.name}`, undo);
      return;
    } else {
      const j = act === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= state.tracks.length) return;
      [state.tracks[i], state.tracks[j]] = [state.tracks[j], state.tracks[i]];
    }
    renderAll();
  });

  li.querySelectorAll("[data-edge]").forEach(inp => {
    inp.addEventListener("change", () => {
      const t = parseTime(inp.value);
      if (isNaN(t)) { inp.classList.add("invalid"); return; }
      inp.classList.remove("invalid");
      tr[inp.dataset.edge] = snapTime(tr, clamp(t, 0, tr.duration));
      updateCard(tr); refreshMixPanel();
    });
  });
  bindWave(tr);
  return li;
}

function bindWave(tr) {
  const c = tr.canvas; let drag = null;
  const pos = e => { const r = c.getBoundingClientRect(); const x = clamp(e.clientX - r.left, 0, r.width); return { x, w: r.width, t: x / r.width * tr.duration }; };
  c.addEventListener("pointerdown", e => {
    const p = pos(e), sx = tr.start / tr.duration * p.w, ex = tr.end / tr.duration * p.w;
    const hit = e.pointerType === "mouse" ? 10 : 24;   // fingers need a bigger target
    if (Math.abs(p.x - sx) <= hit && Math.abs(p.x - sx) <= Math.abs(p.x - ex)) drag = { type: "start" };
    else if (Math.abs(p.x - ex) <= hit) drag = { type: "end" };
    else drag = { type: "new", x0: p.x, t0: p.t, moved: false };
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener("pointermove", e => {
    const p = pos(e);
    if (!drag) {
      const sx = tr.start / tr.duration * p.w, ex = tr.end / tr.duration * p.w;
      c.style.cursor = (Math.abs(p.x - sx) <= 10 || Math.abs(p.x - ex) <= 10) ? "ew-resize" : "crosshair";
      return;
    }
    const t = snapTime(tr, p.t);
    if (drag.type === "start") tr.start = Math.min(t, tr.end - 0.5);
    else if (drag.type === "end") tr.end = Math.max(t, tr.start + 0.5);
    else {
      if (Math.abs(p.x - drag.x0) > 4) drag.moved = true;
      if (!drag.moved) return;
      const t0 = snapTime(tr, drag.t0);
      tr.start = Math.min(t0, t); tr.end = Math.max(t0, t);
    }
    updateCard(tr);
  });
  const end = e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.type === "new" && !d.moved) { togglePreview(tr, pos(e).t, true); return; }
    refreshMixPanel();
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", () => { drag = null; refreshMixPanel(); });
}

function drawWave(tr) {
  const c = tr.canvas, w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const col = cssVar(`--t${(tr.color % 6) + 1}`), off = cssVar("--wave"), gold = cssVar("--gold");
  const sx = tr.start / tr.duration * w, ex = tr.end / tr.duration * w;
  g.globalAlpha = 0.14; g.fillStyle = col; g.fillRect(sx, 0, ex - sx, h); g.globalAlpha = 1;
  if (state.snap && tr.beat) {
    const px = tr.beat.period / tr.duration * w;
    if (px >= 4) {
      g.fillStyle = off;
      for (let t = tr.beat.phase; t < tr.duration; t += tr.beat.period) { const x = t / tr.duration * w; g.fillRect(x, 0, 1, 4); g.fillRect(x, h - 4, 1, 4); }
    }
  }
  const bars = Math.floor(w / 3), P = tr.peaks, n = P.length;
  for (let i = 0; i < bars; i++) {
    const a = Math.floor(i / bars * n), b = Math.max(a + 1, Math.floor((i + 1) / bars * n));
    let m = 0; for (let j = a; j < b; j++) if (P[j] > m) m = P[j];
    const bh = Math.max(1.5, m * (h - 14)), x = i * 3 + 0.5;
    g.fillStyle = (x >= sx && x <= ex) ? col : off;
    g.fillRect(x, (h - bh) / 2, 2, bh);
  }
  const tw = coarse ? 12 : 7, th = coarse ? 22 : 14;
  g.fillStyle = gold;
  g.fillRect(sx - 1, 0, 2, h); g.fillRect(sx, 0, tw, th); g.fillRect(sx, h - th, tw, th);
  g.fillRect(ex - 1, 0, 2, h); g.fillRect(ex - tw, 0, tw, th); g.fillRect(ex - tw, h - th, tw, th);
}

function updateCard(tr) {
  const li = tr.el, i = state.tracks.indexOf(tr), P = plan();
  li.style.setProperty("--c", colorVar(tr));
  $(".num", li).textContent = i + 1;
  $(".dur", li).textContent = fmt(tr.duration, 0);
  $(".bv", li).textContent = `${Math.round(tr.beat.bpm)} BPM`;
  const si = $(`#start-${tr.id}`), ei = $(`#end-${tr.id}`);
  if (document.activeElement !== si) { si.value = fmt(tr.start); si.classList.remove("invalid"); }
  if (document.activeElement !== ei) { ei.value = fmt(tr.end); ei.classList.remove("invalid"); }
  $(".cutlen", li).innerHTML = `<span class="mono">${fmt(tr.end - tr.start)}</span> cut` + (tr.recipe ? `<span class="recipe">&middot; ${tr.recipe}</span>` : "");
  $('[data-act="up"]', li).disabled = i === 0;
  $('[data-act="down"]', li).disabled = i === state.tracks.length - 1;
  const prob = problems(tr, i, P), w = $(".warn", li);
  w.textContent = prob; w.hidden = !prob; li.classList.toggle("bad", !!prob);
  drawWave(tr);
}

/* ---------- Render ---------- */
function renderAll() {
  const list = $("#list");
  state.tracks.forEach(tr => { if (!tr.el) buildCard(tr); });
  list.replaceChildren(...state.tracks.map(t => t.el));
  state.tracks.forEach(updateCard);
  const has = state.tracks.length > 0;
  $("#intro").hidden = has;
  $("#drop").classList.toggle("compact", has);
  $("#drop .big").textContent = has ? "Add more songs" : coarse ? "Add songs or videos" : "Drop songs or videos here";
  $("#listHead").hidden = !has;
  const n = state.tracks.length;
  $("#countLabel").textContent = `${n} song${n === 1 ? "" : "s"}${storageOK ? " · saved in this browser" : ""}`;
  updateMbar();
  refreshMixPanel();
  renderPads();
}

function refreshMixPanel() {
  state.tracks.forEach(updateCard);
  const P = plan(), tl = $("#timeline"), has = P.segs.length > 0;
  tl.querySelectorAll(".seg-b").forEach(n => n.remove());
  $("#tlEmpty").hidden = has;
  P.segs.forEach((s, i) => {
    const d = document.createElement("div");
    d.className = `seg-b r${i % 2}`;
    d.style.left = (s.at / P.total * 100) + "%";
    d.style.width = (s.len / P.total * 100) + "%";
    d.style.setProperty("--c", colorVar(s.tr));
    d.title = s.tr.name;
    tl.insertBefore(d, $("#tlHead"));
  });
  $("#tlTotal").textContent = fmt(P.total, 0);

  const ol = $("#order"); ol.replaceChildren();
  P.segs.forEach((s, i) => {
    const li = document.createElement("li");
    li.style.setProperty("--c", colorVar(s.tr));
    li.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="at">at ${fmt(s.at, 0)}</span>`;
    $(".nm", li).textContent = s.tr.name;
    ol.append(li);
    if (s.style) {
      const j = document.createElement("li"); j.className = "join";
      const sel = document.createElement("select");
      sel.id = `trans-${s.tr.id}`;
      sel.setAttribute("aria-label", `Transition after ${s.tr.name}`);
      sel.innerHTML = Object.entries(STYLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
      sel.value = s.style;
      sel.addEventListener("change", () => { s.tr.trans = sel.value === state.defStyle ? null : sel.value; refreshMixPanel(); });
      j.innerHTML = '<span class="ln"></span>'; j.append(sel);
      if (state.sync && overlapOf(s.style, 1) > 0) {
        const note = document.createElement("span"), nx = P.segs[i + 1].tr;
        note.className = "jn" + (s.j.r ? " ok" : "");
        note.textContent = s.j.r ? `Tempo matched · ${Math.round(s.j.L / (s.tr.beat.period / P.rate))} beats`
          : `${Math.round(s.tr.beat.bpm)} → ${Math.round(nx.beat.bpm)} BPM, too far apart to match`;
        j.append(note);
      }
      ol.append(j);
    }
  });
  const ok = allValid();
  const pm = !ok && !(playing && playing.kind === "mix");
  $("#playMix").disabled = pm; $("#mPlay").disabled = pm && !busy;
  $("#dlBtn").disabled = !ok || exporting;
  $("#vidBtn").disabled = !ok || exporting || !videoSupported;
  $("#autoBtn").disabled = !has;
  if (!(playing && playing.kind === "mix") && !busy) {
    $("#playMix").textContent = mix.buffer && mix.key === mixKey() ? "Play mashup" : (has ? "Mix and play" : "Play mashup");
    $("#mPlay").textContent = "Play";
    $("#mixTime").textContent = has ? `${fmt(P.total, 0)} long` : "";
    $("#mTime").textContent = has ? (ok ? `${P.segs.length} songs · ${fmt(P.total, 0)}` : "Fix the cut marked in red") : "";
    $("#mProg").style.width = "0";
  }
  persist();
}
function updateMbar() {
  const show = state.tracks.length > 0 && state.mode === "build";
  $("#mbar").hidden = !show;
  document.body.classList.toggle("has-mbar", show);
}

function renderPads() {
  const pads = $("#pads");
  const canPlay = t => t.end - t.start > 1;
  if (!state.tracks.length) {
    pads.innerHTML = '<p class="hint">Add songs in <b>Build a mashup</b> first. Each cut you pick becomes a pad here.</p>';
    return;
  }
  pads.replaceChildren(...state.tracks.map((tr, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pad"; b.dataset.idx = i;
    b.style.setProperty("--c", colorVar(tr));
    b.disabled = !canPlay(tr);
    b.innerHTML = `<span class="key">${i < 9 ? i + 1 : "&middot;"}</span><span class="pn"></span><span class="pm mono"></span><span class="pbar"><i></i></span>`;
    $(".pn", b).textContent = tr.name;
    $(".pm", b).textContent = `${fmt(tr.start, 0)}–${fmt(tr.end, 0)} · ${Math.round(tr.beat.bpm)} BPM`;
    b.addEventListener("click", () => liveGo(i));
    return b;
  }));
  markPads();
}

/* ---------- Playback: previews and the mix ---------- */
function ensureBus() {
  const c = audio();
  if (!liveBus) { liveBus = makeMaster(c, VIBES[state.vibe].wet, true); liveBus.out.connect(c.destination); }
  return liveBus;
}
function stopAll() {
  if (playing) {
    try { playing.src && playing.src.stop(); } catch (e) {}
    if (playing.kind === "live") liveStopNow();
    if (playing.kind === "cut") { playing.tr.headEl.hidden = true; $('[data-act="play"]', playing.tr.el).textContent = "Play cut"; }
  }
  playing = null;
  $("#tlHead").hidden = true;
  refreshMixPanel();
  markPads();
}

function togglePreview(tr, from, fromClick) {
  if (playing && playing.kind === "cut" && playing.tr === tr && !fromClick) { stopAll(); return; }
  stopAll();
  const c = audio(), bus = ensureBus(), rate = VIBES[state.vibe].rate;
  const until = (from >= tr.start && from < tr.end) ? tr.end : tr.duration;
  const v = makeVoice(c, tr, bus.input, rate);
  const T = c.currentTime + 0.03;
  v.src.start(T, from); v.src.stop(T + (until - from) / rate);
  playing = { kind: "cut", tr, src: v.src, t0: T, from, until, rate };
  v.src.onended = () => { if (playing && playing.src === v.src) stopAll(); };
  tr.headEl.hidden = false;
  $('[data-act="play"]', tr.el).textContent = "Stop";
}

let busy = false;
async function playMix(offset = 0) {
  if (busy) return;
  if (playing && playing.kind === "mix" && offset === 0) { stopAll(); return; }
  if (!allValid()) { toast("Fix the cut marked in red first."); return; }
  stopAll();
  const btn = $("#playMix"), mb = $("#mPlay");
  busy = true; btn.disabled = true; btn.textContent = "Mixing…"; mb.disabled = true; mb.textContent = "Mixing…";
  let buf;
  try { buf = await renderMix(); }
  catch (e) { toast("Couldn't build the mix: " + e.message); busy = false; refreshMixPanel(); return; }
  busy = false;
  mb.disabled = false; mb.textContent = "Stop";
  const c = audio(), src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
  const T = c.currentTime + 0.03;
  src.start(T, offset);
  playing = { kind: "mix", src, t0: T, from: offset, total: buf.duration };
  src.onended = () => { if (playing && playing.src === src) stopAll(); };
  btn.disabled = false; btn.textContent = "Stop";
  $("#tlHead").hidden = false;
}

/* ---------- Live DJ ---------- */
const live = { voice: null, idx: -1, timer: 0, next: -1, rec: null, recDest: null, recStart: 0 };

function liveGo(i, at) {
  const tr = state.tracks[i]; if (!tr || tr.end - tr.start <= 1) return;
  if (playing && playing.kind !== "live") stopAll();
  const c = audio(), bus = ensureBus(), rate = VIBES[state.vibe].rate;
  const style = state.liveStyle, old = live.voice;
  let L = state.liveLen, r = null;
  if (old && state.sync && overlapOf(style, 1) > 0 && old.tr !== tr) {
    r = syncRatio(old.tr, tr);
    if (r) L = beatLen(L, old.tr, rate);
  }
  let T = at != null ? at : c.currentTime + 0.06;
  if (old && at == null) {
    if (style === "riser") T = Math.max(T, c.currentTime + Math.min(L, 2));
    if (state.quant && old.tr.beat) {
      const pos = voicePos(old, T), { period, phase } = old.tr.beat;
      const b = phase + Math.ceil((pos - phase) / period) * period;
      T = Math.max(T, timeAtPos(old, b));
    }
  }
  const v = makeVoice(c, tr, bus.input, rate);
  if (r) {
    const pr = v.src.playbackRate;
    pr.setValueAtTime(rate * r, T); pr.setValueAtTime(rate * r, T + L);
    pr.linearRampToValueAtTime(rate, T + L + SYNC_RAMP);
    v.ramp = { L, R: SYNC_RAMP, r };
  }
  v.src.start(T, tr.start);
  Object.assign(v, { startT: T, offset: tr.start, idx: i });
  if (old) {
    applyOut(c, old, style, T, L, true);
    applyIn(c, v, style, T, L, true);
    if (style === "riser") riser(c, bus.input, T, L, c.currentTime);
  } else {
    applyIn(c, v, "cut", T, 0.05, true);
  }
  live.voice = v; live.idx = i;
  playing = { kind: "live" };
  scheduleAdvance();
  $("#liveStop").disabled = false;
  markPads();
}
function liveEndT(v) { return timeAtPos(v, v.tr.end); }
function scheduleAdvance() {
  clearTimeout(live.timer); live.next = -1;
  const v = live.voice; if (!v) return;
  const c = audio(), end = liveEndT(v), n = state.tracks.length;
  if (state.auto && n > 1) {
    const L = state.liveLen, ov = overlapOf(state.liveStyle, L);
    let j = (v.idx + 1) % n, tries = 0;
    while (state.tracks[j].end - state.tracks[j].start <= 1 && tries++ < n) j = (j + 1) % n;
    live.next = j;
    const at = Math.max(c.currentTime + 0.1, end - ov);
    const lead = state.liveStyle === "riser" ? Math.min(L, 2) + 0.25 : 0.25; // a riser has to start before the drop
    live.timer = setTimeout(() => { if (live.voice === v) liveGo(j, at); }, Math.max(0, (at - c.currentTime - lead) * 1000));
  } else {
    const fo = Math.min(2, (end - v.startT) / 3);
    try { v.env.gain.setTargetAtTime(0, end - fo, fo / 4); } catch (e) {}
    v.src.stop(end + 0.05);
    live.timer = setTimeout(() => { if (live.voice === v) { live.voice = null; stopAll(); } }, Math.max(0, (end - c.currentTime) * 1000));
  }
  markPads();
}
function liveStopNow() {
  clearTimeout(live.timer);
  const v = live.voice; live.voice = null; live.next = -1;
  if (v) { const c = audio(); try { holdAt(v.env.gain, c.currentTime); v.env.gain.setTargetAtTime(0, c.currentTime, 0.08); v.src.stop(c.currentTime + 0.5); } catch (e) {} }
  $("#liveStop").disabled = true;
}
function markPads() {
  document.querySelectorAll(".pad").forEach(p => {
    const i = +p.dataset.idx;
    p.classList.toggle("on", !!live.voice && live.idx === i);
    p.classList.toggle("queued", !!live.voice && live.next === i && live.idx !== i);
    if (!(live.voice && live.idx === i)) $(".pbar i", p).style.width = "0";
  });
}

function recSupported() { return typeof MediaRecorder !== "undefined" && audio().createMediaStreamDestination; }
function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
function toggleRecord() {
  const btn = $("#recBtn");
  if (live.rec) { live.rec.stop(); return; }
  if (!recSupported()) { toast("This browser can't record audio. Try Chrome, Edge or Firefox."); return; }
  const c = audio(), bus = ensureBus();
  if (!live.recDest) { live.recDest = c.createMediaStreamDestination(); bus.out.connect(live.recDest); }
  const mime = pickMime(), chunks = [];
  const rec = new MediaRecorder(live.recDest.stream, mime ? { mimeType: mime } : undefined);
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    live.rec = null; btn.classList.remove("rec-on"); btn.textContent = "Record set";
    const type = rec.mimeType || mime || "audio/webm", ext = type.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(chunks, { type });
    if (blob.size < 1000) { toast("Nothing was recorded. Play some pads while recording."); return; }
    if (await mp3Available()) {
      try {
        btn.disabled = true; btn.textContent = "Saving MP3…";
        const buf = await audio().decodeAudioData(await blob.arrayBuffer());
        await saveFile(await encodeMp3(buf, () => {}), `${safeName()}-live-set.mp3`);
        return;
      } catch (e) { /* fall back to the recording as-is */ }
      finally { btn.disabled = false; btn.textContent = "Record set"; }
    }
    saveFile(blob, `${safeName()}-live-set.${ext}`);
  };
  rec.start(1000);
  live.rec = rec; live.recStart = performance.now();
  btn.classList.add("rec-on");
}

/* ---------- Export ---------- */
let exporting = false;
const downloadsCap = (window.claude && typeof window.claude.use === "function")
  ? window.claude.use("downloads").catch(() => null) : Promise.resolve(null);

function safeName() { return ($("#mixName").value.trim() || "my-mashup").replace(/[\\/:*?"<>|]+/g, "-"); }

async function saveFile(blob, filename) {
  const dl = await downloadsCap;
  if (dl) {
    try { await dl.save({ filename, data: blob }); toast(`Saved ${filename}`); }
    catch (e) {
      if (e && e.code === "declined") toast("Download cancelled.");
      else if (e && e.code === "rate_limited") toast("A save prompt is already open. Finish that one first.");
      else toast("This page can't save files here. Open it in a normal browser tab to download.");
    }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast(`Downloading ${filename}`);
}

async function encodeOpus(buf, onP) {
  const sr = buf.sampleRate, ch = 2;
  const muxer = new WebMMuxer.Muxer({ target: new WebMMuxer.ArrayBufferTarget(), audio: { codec: "A_OPUS", numberOfChannels: ch, sampleRate: sr } });
  let err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => (err = e) });
  enc.configure({ codec: "opus", sampleRate: sr, numberOfChannels: ch, bitrate: 192000 });
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const F = 4800;
  for (let i = 0, k = 0; i < buf.length; i += F, k++) {
    if (err) throw err;
    const n = Math.min(F, buf.length - i), data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(i / sr * 1e6), data });
    enc.encode(ad); ad.close();
    if (k % 40 === 0) { onP(i / buf.length); await tick(); }
    while (enc.encodeQueueSize > 30) await tick();
  }
  await enc.flush(); enc.close();
  if (err) throw err;
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: "audio/webm" });
}
// MP3 via lamejs. Not offered inside the claude.ai viewer, whose save
// prompt doesn't accept .mp3.
async function mp3Available() { return typeof lamejs !== "undefined" && !(await downloadsCap); }
async function encodeMp3(buf, onP) {
  const enc = new lamejs.Mp3Encoder(2, buf.sampleRate, 256);
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const B = 1152 * 20, l16 = new Int16Array(B), r16 = new Int16Array(B), parts = [];
  for (let i = 0, k = 0; i < buf.length; i += B, k++) {
    const n = Math.min(B, buf.length - i);
    for (let j = 0; j < n; j++) {
      l16[j] = clamp(L[i + j], -1, 1) * 32767;
      r16[j] = clamp(R[i + j], -1, 1) * 32767;
    }
    const out = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
    if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
    if (k % 20 === 0) { onP(i / buf.length); await tick(); }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length));
  return new Blob(parts, { type: "audio/mpeg" });
}
mp3Available().then(ok => {
  if (!ok) return;
  $("#dlBtn").textContent = "Download MP3";
  $("#dlNote").textContent = "Audio saves as MP3 and video as MP4 with an animated visualizer.";
});

async function canOpus() {
  try {
    if (typeof AudioEncoder === "undefined" || typeof WebMMuxer === "undefined") return false;
    const r = await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
    return !!r.supported;
  } catch (e) { return false; }
}
function recordRealtime(buf, onP) {
  return new Promise((resolve, reject) => {
    const c = audio(), d = c.createMediaStreamDestination(), mime = pickMime(), chunks = [];
    const rec = new MediaRecorder(d.stream, mime ? { mimeType: mime } : undefined);
    const src = c.createBufferSource(); src.buffer = buf; src.connect(d);
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onerror = e => reject(e.error || new Error("recording failed"));
    const t0 = c.currentTime, iv = setInterval(() => onP((c.currentTime - t0) / buf.duration), 250);
    rec.onstop = () => { clearInterval(iv); resolve(new Blob(chunks, { type: rec.mimeType || mime })); };
    src.onended = () => setTimeout(() => rec.stop(), 200);
    rec.start(1000); src.start();
  });
}
async function exportMix() {
  if (exporting) return;
  exporting = true;
  const btn = $("#dlBtn"), prog = $("#dlProg"), note = $("#dlNote");
  btn.disabled = true; prog.hidden = false; prog.value = 0;
  const oldNote = note.textContent;
  try {
    note.textContent = "Mixing…";
    const buf = await renderMix();
    let blob;
    if (await mp3Available()) {
      note.textContent = "Encoding MP3…";
      blob = await encodeMp3(buf, p => (prog.value = p));
    } else if (await canOpus()) {
      note.textContent = "Encoding…";
      blob = await encodeOpus(buf, p => (prog.value = p));
    } else if (recSupported()) {
      note.textContent = `This browser encodes in real time, so this takes ${fmt(buf.duration, 0)}. Keep this tab open.`;
      blob = await recordRealtime(buf, p => (prog.value = p));
    } else throw new Error("this browser can't encode audio");
    prog.value = 1;
    const ext = blob.type.includes("mpeg") ? "mp3" : blob.type.includes("mp4") ? "mp4" : "webm";
    await saveFile(blob, `${safeName()}.${ext}`);
  } catch (e) {
    toast("Export failed: " + (e.message || e));
  } finally {
    exporting = false; prog.hidden = true; note.textContent = oldNote; refreshMixPanel();
  }
}

/* ---------- Video export ---------- */
const videoSupported = typeof VideoEncoder !== "undefined" && typeof AudioEncoder !== "undefined" && typeof VideoFrame !== "undefined";
const VID = { bg: "#120E17", ink: "#F2EAF1", muted: "#A999AC", track: "#2A2233",
  colors: ["#FF5C9A", "#FFC24A", "#3FD0BD", "#A58BFF", "#FF8A5C", "#7CD67F"] };
const FPS = 30, FFT_N = 1024, BANDS = 40;

async function pickVideoFormat(W, H) {
  const vb = 1_800_000;
  if (typeof Mp4Muxer !== "undefined") {
    const aac = { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
    const aOk = await AudioEncoder.isConfigSupported(aac).then(r => r.supported, () => false);
    if (aOk) for (const codec of ["avc1.42001f", "avc1.4d001f", "avc1.640028"]) {
      const cfg = { codec, width: W, height: H, bitrate: vb, framerate: FPS, avc: { format: "avc" } };
      if (await VideoEncoder.isConfigSupported(cfg).then(r => r.supported, () => false))
        return { ext: "mp4", vcfg: cfg, acfg: aac, muxV: "avc", muxA: "aac" };
    }
  }
  if (typeof WebMMuxer !== "undefined") {
    const opus = { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
    const aOk = await AudioEncoder.isConfigSupported(opus).then(r => r.supported, () => false);
    if (aOk) for (const [codec, muxV] of [["vp09.00.10.08", "V_VP9"], ["vp8", "V_VP8"]]) {
      const cfg = { codec, width: W, height: H, bitrate: vb, framerate: FPS };
      if (await VideoEncoder.isConfigSupported(cfg).then(r => r.supported, () => false))
        return { ext: "webm", vcfg: cfg, acfg: opus, muxV, muxA: "A_OPUS" };
    }
  }
  return null;
}

function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function makeSpectrum(buf) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const hann = new Float32Array(FFT_N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1)));
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.round(2 * Math.pow(360 / 2, i / BANDS)));
  const smooth = new Float32Array(BANDS);
  return t => {
    const s0 = Math.floor(t * buf.sampleRate) - FFT_N / 2;
    for (let i = 0; i < FFT_N; i++) { const j = s0 + i; re[i] = j >= 0 && j < L.length ? (L[j] + R[j]) * 0.5 * hann[i] : 0; im[i] = 0; }
    fftMag(re, im);
    let bass = 0;
    for (let b = 0; b < BANDS; b++) {
      let m = 0;
      for (let k = edges[b]; k <= Math.max(edges[b], edges[b + 1] - 1); k++) m = Math.max(m, Math.hypot(re[k], im[k]));
      const v = clamp((20 * Math.log10(m / (FFT_N / 4) + 1e-9) + 50) / 50, 0, 1);
      smooth[b] = v > smooth[b] ? v : smooth[b] * 0.82 + v * 0.18;
      if (b < 4) bass += smooth[b] / 4;
    }
    return { bands: smooth, bass };
  };
}
function hexMix(a, b, w) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * w).toString(16).padStart(2, "0")).join("");
}
function wrapLines(g, text, maxW) {
  const words = text.split(/\s+/), lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (g.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawVideoFrame(g, W, H, t, dur, P, spec, title) {
  const sq = W === H, u = W / 720;
  // which song is playing (the newer one wins inside a blend)
  let cur = 0;
  P.segs.forEach((s, i) => { if (t >= s.at) cur = i; });
  const s = P.segs[cur], prev = P.segs[cur - 1];
  let col = VID.colors[s.tr.color % 6];
  if (prev && prev.ov > 0 && t < s.at + prev.ov) col = hexMix(VID.colors[prev.tr.color % 6], col, (t - s.at) / prev.ov);
  const { bands, bass } = spec(t);

  g.fillStyle = VID.bg; g.fillRect(0, 0, W, H);
  const cx = W / 2, cy = sq ? H * 0.40 : H * 0.40;
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, W * 0.85);
  glow.addColorStop(0, col + "55"); glow.addColorStop(0.55, col + "14"); glow.addColorStop(1, VID.bg + "00");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  // brand + title
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  g.fillStyle = VID.muted; g.font = `600 ${Math.round(20 * u)}px Figtree, sans-serif`;
  if ("letterSpacing" in g) g.letterSpacing = `${Math.round(5 * u)}px`;
  g.fillText("HOOKD", cx, H * (sq ? 0.075 : 0.07));
  if ("letterSpacing" in g) g.letterSpacing = "0px";
  g.fillStyle = VID.ink; g.font = `600 ${Math.round(26 * u)}px Figtree, sans-serif`;
  g.fillText(title, cx, H * (sq ? 0.075 : 0.07) + 38 * u);

  // spectrum ring
  const R0 = W * (sq ? 0.17 : 0.2) * (1 + 0.1 * bass), bars = BANDS * 2;
  g.strokeStyle = col; g.lineCap = "round"; g.lineWidth = Math.max(3, W * 0.011);
  for (let i = 0; i < bars; i++) {
    const v = bands[i < BANDS ? i : bars - 1 - i];
    const a = -Math.PI / 2 + i / bars * Math.PI * 2, len = 6 * u + v * W * (sq ? 0.12 : 0.16);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R0, cy + Math.sin(a) * R0);
    g.lineTo(cx + Math.cos(a) * (R0 + len), cy + Math.sin(a) * (R0 + len));
    g.stroke();
  }
  g.fillStyle = col + "22"; g.beginPath(); g.arc(cx, cy, R0 - 10 * u, 0, Math.PI * 2); g.fill();
  g.fillStyle = VID.ink; g.font = `${Math.round(R0 * 0.9)}px "Yatra One", Georgia, serif`; g.textBaseline = "middle";
  g.fillText(String(cur + 1), cx, cy + R0 * 0.06);
  g.textBaseline = "alphabetic";

  // song name + next
  const nameSize = Math.round((sq ? 54 : 64) * u);
  g.font = `${nameSize}px "Yatra One", Georgia, serif`; g.fillStyle = VID.ink;
  const lines = wrapLines(g, s.tr.name, W * 0.84);
  let y = sq ? H * 0.75 : H * 0.66;
  lines.forEach((ln, i) => g.fillText(ln, cx, y + i * nameSize * 1.1));
  y += lines.length * nameSize * 1.1 + 4 * u;
  const nx = P.segs[cur + 1];
  if (nx && nx.at < dur) {
    g.font = `500 ${Math.round(24 * u)}px Figtree, sans-serif`; g.fillStyle = VID.muted;
    g.fillText(`Next: ${nx.tr.name}`, cx, y);
  }

  // timeline
  const tx = W * 0.08, tw = W * 0.84, ty = sq ? H * 0.91 : H * 0.9, th = 10 * u;
  g.fillStyle = VID.track; g.fillRect(tx, ty, tw, th);
  P.segs.forEach(sg => {
    if (sg.at >= dur) return;
    const x0 = tx + sg.at / dur * tw, x1 = tx + Math.min(dur, sg.at + sg.len) / dur * tw;
    g.fillStyle = VID.colors[sg.tr.color % 6] + (sg === s ? "" : "66");
    g.fillRect(x0, ty, Math.max(1, x1 - x0 - 2 * u), th);
  });
  g.fillStyle = VID.ink; g.fillRect(tx + t / dur * tw - 1.5 * u, ty - 8 * u, 3 * u, th + 16 * u);
  g.font = `500 ${Math.round(20 * u)}px "JetBrains Mono", monospace`; g.fillStyle = VID.muted;
  g.textAlign = "left"; g.fillText(fmt(t, 0), tx, ty + th + 32 * u);
  g.textAlign = "right"; g.fillText(fmt(dur, 0), tx + tw, ty + th + 32 * u);
}

async function exportVideo() {
  if (exporting) return;
  exporting = true; refreshMixPanel();
  stopAll();
  const prog = $("#dlProg"), note = $("#dlNote"), oldNote = note.textContent;
  prog.hidden = false; prog.value = 0;
  try {
    note.textContent = "Mixing…";
    const buf = await renderMix(), P = plan();
    const clip = +$("#vidLen").value, dur = clip ? Math.min(clip, buf.duration) : buf.duration;
    const [W, H] = $("#vidShape").value === "s" ? [720, 720] : [720, 1280];
    const F = await pickVideoFormat(W, H);
    if (!F) throw new Error("this browser can't encode video. Try Chrome or Edge on a computer");
    await Promise.all(['64px "Yatra One"', '600 24px Figtree', '500 20px "JetBrains Mono"'].map(f => document.fonts.load(f).catch(() => {})));

    const Mux = F.ext === "mp4" ? Mp4Muxer : WebMMuxer;
    const muxer = new Mux.Muxer({
      target: new Mux.ArrayBufferTarget(),
      video: { codec: F.muxV, width: W, height: H, ...(F.ext === "webm" ? { frameRate: FPS } : {}) },
      audio: { codec: F.muxA, numberOfChannels: 2, sampleRate: 48000 },
      ...(F.ext === "mp4" ? { fastStart: "in-memory" } : {}),
      firstTimestampBehavior: "offset",
    });
    let err = null;
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => (err = e) });
    venc.configure(F.vcfg);
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => (err = e) });
    aenc.configure(F.acfg);

    const canvas = $("#vidCanvas"); canvas.width = W; canvas.height = H;
    $("#vidPreview").hidden = false;
    const g = canvas.getContext("2d"), spec = makeSpectrum(buf), title = $("#mixName").value.trim() || "my mashup";
    const sr = buf.sampleRate, S = Math.floor(dur * sr), fadeS = clip && clip < buf.duration ? Math.floor(1.5 * sr) : 0;
    const Lc = buf.getChannelData(0), Rc = buf.numberOfChannels > 1 ? buf.getChannelData(1) : Lc;
    let ap = 0;
    const feedAudio = upTo => {
      while (ap < upTo) {
        const n = Math.min(4800, upTo - ap), data = new Float32Array(n * 2);
        data.set(Lc.subarray(ap, ap + n), 0); data.set(Rc.subarray(ap, ap + n), n);
        if (fadeS) for (let i = 0; i < n; i++) { const k = S - (ap + i); if (k < fadeS) { const f = k / fadeS; data[i] *= f; data[n + i] *= f; } }
        const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(ap / sr * 1e6), data });
        aenc.encode(ad); ad.close(); ap += n;
      }
    };
    const frames = Math.ceil(dur * FPS), t0 = performance.now();
    note.textContent = "Rendering video…";
    for (let i = 0; i < frames; i++) {
      if (err) throw err;
      const t = i / FPS;
      feedAudio(Math.min(S, Math.floor((t + 1) * sr)));
      drawVideoFrame(g, W, H, t, dur, P, spec, title);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
      while (venc.encodeQueueSize > 6 || aenc.encodeQueueSize > 30) await new Promise(r => setTimeout(r, 1));
      if (i % 15 === 0) {
        prog.value = i / frames;
        const el = (performance.now() - t0) / 1000, left = i ? el / i * (frames - i) : 0;
        note.textContent = `Rendering video… about ${fmt(left, 0)} left`;
        await tick();
      }
    }
    feedAudio(S);
    await venc.flush(); await aenc.flush();
    if (err) throw err;
    venc.close(); aenc.close();
    muxer.finalize();
    prog.value = 1;
    const blob = new Blob([muxer.target.buffer], { type: F.ext === "mp4" ? "video/mp4" : "video/webm" });
    await saveFile(blob, `${safeName()}.${F.ext}`);
  } catch (e) {
    toast("Video export failed: " + (e.message || e));
  } finally {
    exporting = false; prog.hidden = true; note.textContent = oldNote; refreshMixPanel();
  }
}

/* ---------- Animation loop ---------- */
function frame() {
  if (playing && actx) {
    const now = actx.currentTime;
    if (playing.kind === "cut") {
      const t = playing.from + Math.max(0, now - playing.t0) * playing.rate;
      playing.tr.headEl.style.left = (t / playing.tr.duration * 100) + "%";
    } else if (playing.kind === "mix") {
      const t = Math.min(playing.total, playing.from + Math.max(0, now - playing.t0));
      $("#tlHead").style.left = (t / playing.total * 100) + "%";
      $("#mixTime").textContent = `${fmt(t, 0)} / ${fmt(playing.total, 0)}`;
      $("#mTime").textContent = `${fmt(t, 0)} / ${fmt(playing.total, 0)}`;
      $("#mProg").style.width = (t / playing.total * 100) + "%";
    }
  }
  const v = live.voice;
  if (v && actx) {
    const pos = voicePos(v, actx.currentTime);
    const p = document.querySelector(`.pad[data-idx="${live.idx}"] .pbar i`);
    if (p) p.style.width = clamp((pos - v.tr.start) / (v.tr.end - v.tr.start) * 100, 0, 100) + "%";
  }
  if (live.rec) {
    const s = (performance.now() - live.recStart) / 1000;
    $("#recBtn").textContent = `Stop recording ${fmt(s, 0)}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- Wiring ---------- */
function setMode(m) {
  state.mode = m;
  $("#modeBuild").setAttribute("aria-pressed", m === "build");
  $("#modeLive").setAttribute("aria-pressed", m === "live");
  $("#buildView").hidden = m !== "build";
  $("#liveView").hidden = m !== "live";
  if (m === "build" && playing && playing.kind === "live") stopAll();
  if (m === "live" && playing && playing.kind !== "live") stopAll();
  if (m === "build") requestAnimationFrame(() => state.tracks.forEach(drawWave));
  updateMbar();
}
$("#modeBuild").addEventListener("click", () => setMode("build"));
$("#modeLive").addEventListener("click", () => setMode("live"));

$("#vibeSeg").addEventListener("click", e => {
  const b = e.target.closest("[data-vibe]"); if (!b) return;
  state.vibe = b.dataset.vibe;
  document.querySelectorAll("#vibeSeg button").forEach(x => x.setAttribute("aria-pressed", x === b));
  const vibe = VIBES[state.vibe];
  if (liveBus && actx) liveBus.wetGain.gain.setTargetAtTime(vibe.wet, actx.currentTime, 0.1);
  // re-base the live voice so its position math and auto-advance stay right
  const v = live.voice;
  if (v && actx) {
    const now = actx.currentTime;
    v.offset = voicePos(v, now); v.startT = now; v.rate = vibe.rate; v.ramp = null;
    v.src.playbackRate.cancelScheduledValues(now);
    v.src.playbackRate.setValueAtTime(vibe.rate, now);
    scheduleAdvance();
  }
  if (playing && playing.kind === "cut") stopAll();
  refreshMixPanel();
});

const drop = $("#drop");
$("#fileIn").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); drop.classList.add("over"); } }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { if (ev === "dragleave" && e.relatedTarget) return; drop.classList.remove("over"); }));
document.addEventListener("drop", e => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); if (state.mode !== "build") setMode("build"); addFiles(e.dataTransfer.files); } });

$("#xf").addEventListener("input", e => { state.xf = +e.target.value; $("#xfOut").textContent = state.xf.toFixed(1) + " s"; refreshMixPanel(); });
$("#fo").addEventListener("input", e => { state.fadeOut = +e.target.value; $("#foOut").textContent = state.fadeOut.toFixed(1) + " s"; refreshMixPanel(); });
$("#defStyle").addEventListener("change", e => { state.defStyle = e.target.value; state.tracks.forEach(t => (t.trans = null)); refreshMixPanel(); });
$("#level").addEventListener("change", e => { state.level = e.target.checked; refreshMixPanel(); });
$("#snap").addEventListener("change", e => { state.snap = e.target.checked; state.tracks.forEach(drawWave); persist(); });
["#mixName", "#vidShape", "#vidLen", "#liveStyle", "#liveLen", "#quant", "#auto"].forEach(s => $(s).addEventListener("change", persist));
$("#playMix").addEventListener("click", () => playMix(0));
$("#timeline").addEventListener("click", e => {
  if (!state.tracks.length || !allValid()) return;
  const r = e.currentTarget.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 0.999);
  const P = plan();
  if (playing && playing.kind === "mix") stopAll();
  playMix(f * P.total).catch(() => {});
});
$("#dlBtn").addEventListener("click", exportMix);
$("#vidBtn").addEventListener("click", exportVideo);
$("#autoBtn").addEventListener("click", () => { stopAll(); autoMashup(); });
$("#sync").addEventListener("change", e => { setSync(e.target.checked); refreshMixPanel(); });
$("#liveSync").addEventListener("change", e => { setSync(e.target.checked); refreshMixPanel(); });
if (!videoSupported) $("#vidBtn").title = "Video export needs Chrome or Edge on a computer.";

$("#mPlay").addEventListener("click", () => playMix(0));
$("#mMix").addEventListener("click", () => {
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("#mix").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
});

// Start over: a second tap within 4 s confirms.
let clearArmed = 0;
$("#clearBtn").addEventListener("click", async () => {
  const b = $("#clearBtn");
  if (!clearArmed) {
    b.textContent = "Tap again to remove all songs"; b.classList.add("danger");
    clearArmed = setTimeout(() => { clearArmed = 0; b.textContent = "Start over"; b.classList.remove("danger"); }, 4000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = 0; b.textContent = "Start over"; b.classList.remove("danger");
  stopAll();
  state.tracks = []; mix = { buffer: null, key: "" };
  try { await store.clear(); } catch (e) {}
  renderAll();
  toast("Cleared. Add songs to start a new mashup.");
});

// Space plays or stops the mashup in Build mode.
document.addEventListener("keydown", e => {
  if (state.mode !== "build" || e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, select, textarea, button, [contenteditable]")) return;
  if (!state.tracks.length) return;
  e.preventDefault(); playMix(0);
});

// iPhone: without this, Web Audio stays silent when the ringer switch is off.
try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}

window.addEventListener("beforeunload", e => { if (exporting) { e.preventDefault(); e.returnValue = ""; } });

$("#liveStyle").addEventListener("change", e => { state.liveStyle = e.target.value; if (live.voice) scheduleAdvance(); });
$("#liveLen").addEventListener("input", e => { state.liveLen = +e.target.value; $("#liveLenOut").textContent = state.liveLen.toFixed(1) + " s"; });
$("#quant").addEventListener("change", e => (state.quant = e.target.checked));
$("#auto").addEventListener("change", e => { state.auto = e.target.checked; if (live.voice) scheduleAdvance(); });
$("#liveStop").addEventListener("click", stopAll);
$("#recBtn").addEventListener("click", toggleRecord);

document.addEventListener("keydown", e => {
  if (state.mode !== "live" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, select, textarea")) return;
  if (/^[1-9]$/.test(e.key)) { const i = +e.key - 1; if (state.tracks[i]) { e.preventDefault(); liveGo(i); } }
  else if (e.key === " ") { e.preventDefault(); stopAll(); }
});

// Redraw waveforms on resize and theme changes (canvas colors come from tokens).
new ResizeObserver(() => state.tracks.forEach(drawWave)).observe($("#list"));
new MutationObserver(() => state.tracks.forEach(drawWave)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.tracks.forEach(drawWave));

renderAll();
restoreDone = restoreSession();
