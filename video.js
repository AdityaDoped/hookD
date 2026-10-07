"use strict";
/* ---------- Video editor ----------
   Video mode: cut, trim, reorder and join MP4/MOV videos, then export one MP4.
   Sound and picture are always cut at the same source times, and on export every
   frame is placed by its own timestamp, so phone videos recorded at a changing
   frame rate don't drift out of lip sync. Uses $, fmt, clamp, toast, audio,
   saveFile and esdsConfig from app.js. */

const V = {
  sources: [], clips: [], sel: -1, T: 0, playing: false,
  undo: [], redo: [], zoom: 1, exporting: false, cancel: false, nextId: 1,
};
const MIN_CLIP = 0.1;     // shortest piece a split or trim may leave, in seconds
const PEAKS_PER_SEC = 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Export waits use these instead of timers, which browsers slow to a crawl in background tabs.
const nextTask = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
async function roomIn(codec, max) {
  while (codec.state === "configured" && (codec.decodeQueueSize ?? codec.encodeQueueSize) > max) {
    if ("ondequeue" in codec) await new Promise(r => { codec.addEventListener("dequeue", r, { once: true }); setTimeout(r, 250); });
    else await nextTask();
  }
}

/* ---------- Reading MP4/MOV from disk in pieces ---------- */
// Phone videos can run past 1 GB, so a file is never loaded whole: we read its
// 'moov' index, then fetch sample bytes on demand through an 8 MB window.
function fileReader(file) {
  const WIN = 8 << 20;
  let s0 = 0, buf = null;
  return async (off, size) => {
    if (!buf || off < s0 || off + size > s0 + buf.length) {
      s0 = off; buf = new Uint8Array(await file.slice(off, off + Math.max(WIN, size)).arrayBuffer());
    }
    return buf.subarray(off - s0, off - s0 + size);
  };
}

async function readMoov(file) {
  const FIRST = ["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"];
  let off = 0;
  while (off + 8 <= file.size) {
    const h = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    // not an MP4/MOV: the file must open with a known box, and every box needs a printable name
    // (apps add their own boxes, like WhatsApp's 'beam')
    if ((off === 0 && !FIRST.includes(type)) || !/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (size === 1) size = Number(h.getBigUint64(8)); else if (size === 0) size = file.size - off;
    if (size < 8) return null;
    if (type === "moov") return new Uint8Array(await file.slice(off, off + size).arrayBuffer());
    off += size;
  }
  return null;
}

// Tracks of a moov box: kind, codec, timing, rotation and every sample's
// file offset, size, decode/presentation time and keyframe flag.
function parseMoov(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fourcc = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const kids = (s, e) => {
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
  const mvhd = child(moov, "mvhd");
  const movieScale = mvhd ? dv.getUint32(mvhd.s + (b[mvhd.s] === 1 ? 20 : 12)) : 1000;
  const tracks = [];
  for (const trak of kids(moov.s, moov.e).filter(k => k.type === "trak")) {
    const hdlr = child(trak, "mdia", "hdlr"), mdhd = child(trak, "mdia", "mdhd"), stbl = child(trak, "mdia", "minf", "stbl");
    const tkhd = child(trak, "tkhd");
    if (!hdlr || !mdhd || !stbl) continue;
    const kind = fourcc(hdlr.s + 8);
    if (kind !== "vide" && kind !== "soun") continue;
    const scale = dv.getUint32(mdhd.s + (b[mdhd.s] === 1 ? 20 : 12));
    const stsd = child(stbl, "stsd"), entry = stsd && kids(stsd.s + 8, stsd.e)[0];
    if (!entry || !scale) continue;
    const t = { kind, codec: entry.type, scale, offset: 0, rot: 0, w: 0, h: 0, samples: [] };
    // edit list: an empty edit delays the track, a media time skips its start
    const elst = child(trak, "edts", "elst");
    if (elst) {
      const v1 = b[elst.s] === 1, n = dv.getUint32(elst.s + 4), sz = v1 ? 20 : 12;
      let delay = 0;
      for (let i = 0, o = elst.s + 8; i < n && o + sz <= elst.e; i++, o += sz) {
        const dur = v1 ? Number(dv.getBigUint64(o)) : dv.getUint32(o);
        const mt = v1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
        if (mt === -1) delay += dur / movieScale;
        else { t.offset = delay - mt / scale; break; }
      }
    }
    if (kind === "vide") {
      if (tkhd) {
        const m = tkhd.s + (b[tkhd.s] === 1 ? 52 : 40);
        t.rot = (Math.round(Math.atan2(dv.getInt32(m + 4), dv.getInt32(m)) * 180 / Math.PI) + 360) % 360;
        t.w = dv.getUint32(m + 36) / 65536; t.h = dv.getUint32(m + 40) / 65536;
      }
      t.config = videoConfig(b, dv, entry, kids);
      if (!t.w || !t.h) { t.w = dv.getUint16(entry.s + 24); t.h = dv.getUint16(entry.s + 26); }
    } else if (t.codec === "mp4a") {
      t.asc = esdsConfig(b, dv, entry);
    }
    try { t.samples = sampleTimes(dv, n => child(stbl, n)); } catch (e) { t.samples = []; }
    tracks.push(t);
  }
  return tracks;
}

// Decoder settings for the browser's VideoDecoder, from the sample entry.
const CODEC_LABEL = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC (H.265)", hev1: "HEVC (H.265)", av01: "AV1", vp09: "VP9" };
function videoConfig(b, dv, entry, kids) {
  const sub = kids(entry.s + 78, entry.e), box = t => sub.find(k => k.type === t);
  const hex = n => n.toString(16).padStart(2, "0"), two = n => String(n).padStart(2, "0");
  const base = { codedWidth: dv.getUint16(entry.s + 24), codedHeight: dv.getUint16(entry.s + 26) };
  const type = entry.type;
  if (type === "avc1" || type === "avc3") {
    const c = box("avcC"); if (!c) return null;
    const d = b.slice(c.s, c.e);
    return { ...base, codec: `avc1.${hex(d[1])}${hex(d[2])}${hex(d[3])}`, description: d };
  }
  if (type === "hvc1" || type === "hev1") {
    const c = box("hvcC"); if (!c) return null;
    const d = b.slice(c.s, c.e);
    let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0, rev = 0;
    for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = [...d.slice(6, 12)];
    while (cons.length && !cons.at(-1)) cons.pop();
    const codec = `${type}.${["", "A", "B", "C"][d[1] >> 6]}${d[1] & 31}.${rev.toString(16)}.${(d[1] >> 5) & 1 ? "H" : "L"}${d[12]}` +
      cons.map(x => "." + x.toString(16)).join("");
    return { ...base, codec, description: d };
  }
  if (type === "av01") {
    const c = box("av1C"); if (!c) return null;
    const d = b.slice(c.s, c.e), bits = (d[2] >> 6) & 1 ? ((d[2] >> 5) & 1 ? 12 : 10) : 8;
    return { ...base, codec: `av01.${d[1] >> 5}.${two(d[1] & 31)}${d[2] >> 7 ? "H" : "M"}.${two(bits)}`, description: d };
  }
  if (type === "vp09") {
    const c = box("vpcC"); if (!c) return null;
    return { ...base, codec: `vp09.${two(b[c.s + 4])}.${two(b[c.s + 5])}.${two(b[c.s + 6] >> 4)}` };
  }
  return null;
}

function sampleTimes(dv, box) {
  const stsz = box("stsz"), stsc = box("stsc"), stts = box("stts"), stco = box("stco"), co64 = box("co64");
  const ctts = box("ctts"), stss = box("stss");
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
        out.push({ off, size, dts: 0, cts: 0, dur: 0, sync: !stss }); off += size;
      }
    }
  }
  for (let r = 0, i = 0, t = 0, nr = dv.getUint32(stts.s + 4); r < nr; r++) {
    const count = dv.getUint32(stts.s + 8 + 8 * r), d = dv.getUint32(stts.s + 12 + 8 * r);
    for (let k = 0; k < count && i < out.length; k++, i++) { out[i].dts = out[i].cts = t; out[i].dur = d; t += d; }
  }
  if (ctts) {
    for (let r = 0, i = 0, nr = dv.getUint32(ctts.s + 4); r < nr; r++) {
      const count = dv.getUint32(ctts.s + 8 + 8 * r), d = dv.getInt32(ctts.s + 12 + 8 * r);
      for (let k = 0; k < count && i < out.length; k++, i++) out[i].cts = out[i].dts + d;
    }
  }
  if (stss) {
    for (let i = 0, nn = dv.getUint32(stss.s + 4); i < nn; i++) {
      const j = dv.getUint32(stss.s + 8 + 4 * i) - 1;
      if (out[j]) out[j].sync = true;
    }
  }
  return out;
}

// One AAC track decoded to an AudioBuffer, reading only its own samples.
async function decodeAacTrack(file, t) {
  const read = fileReader(file), a = t.asc;
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const fi = ((a[0] & 7) << 1) | (a[1] >> 7);
  const sampleRate = fi === 15 ? ((a[1] & 0x7f) << 17) | (a[2] << 9) | (a[3] << 1) | (a[4] >> 7) : RATES[fi];
  const channels = ((fi === 15 ? a[4] : a[1]) >> 3 & 15) || 2;
  const mux = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), audio: { codec: "aac", numberOfChannels: channels, sampleRate },
    fastStart: "in-memory", firstTimestampBehavior: "offset" });
  const meta = { decoderConfig: { codec: `mp4a.40.${a[0] >> 3}`, numberOfChannels: channels, sampleRate, description: a } };
  let ts = 0;
  for (let i = 0; i < t.samples.length; i++) {
    const s = t.samples[i], bytes = (await read(s.off, s.size)).slice();
    mux.addAudioChunkRaw(bytes, "key", Math.round(ts * 1e6 / t.scale), Math.round(s.dur * 1e6 / t.scale), i ? undefined : meta);
    ts += s.dur;
  }
  mux.finalize();
  return await audio().decodeAudioData(mux.target.buffer);
}

function peaksOf(buf) {
  const n = Math.ceil(buf.duration * PEAKS_PER_SEC), per = buf.sampleRate / PEAKS_PER_SEC, out = new Float32Array(n);
  const chs = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const d of chs) for (let j = Math.floor(i * per), e = Math.min(d.length, Math.floor((i + 1) * per)); j < e; j += 4) { const v = Math.abs(d[j]); if (v > m) m = v; }
    out[i] = m;
  }
  let top = 0; for (const v of out) if (v > top) top = v;
  if (top > 0) for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / top);
  return out;
}

async function openSource(file) {
  const moov = await readMoov(file);
  if (!moov) throw new Error("for now Hookd can edit MP4 and MOV videos");
  const tracks = parseMoov(moov) || [];
  const vt = tracks.find(t => t.kind === "vide" && t.samples.length);
  if (!vt) throw new Error("it has no video in it");
  const label = CODEC_LABEL[vt.codec] || vt.codec.toUpperCase();
  if (!vt.config) throw new Error(`its video is in ${label} format, which Hookd can't edit yet`);
  if (typeof VideoDecoder !== "undefined") {
    const ok = await VideoDecoder.isConfigSupported(vt.config).then(r => r.supported, () => false);
    if (!ok) throw new Error(vt.codec.startsWith("h") ?
      "its video is HEVC, which this browser can't open. On iPhone, set Settings > Camera > Formats to Most Compatible, or try Edge" :
      `its video is in ${label} format, which this browser can't open`);
  }
  for (const s of vt.samples) s.pts = s.cts / vt.scale + vt.offset;
  let start = Infinity, end = 0;
  for (const s of vt.samples) { start = Math.min(start, s.pts); end = Math.max(end, s.pts + s.dur / vt.scale); }
  start = Math.max(0, start);
  // the usual gap between frames gives the camera's rate; dropped frames would drag an average down
  const pts = vt.samples.map(s => s.pts).sort((a, b) => a - b), gaps = [];
  for (let i = 1; i < pts.length; i++) if (pts[i] > pts[i - 1]) gaps.push(pts[i] - pts[i - 1]);
  gaps.sort((a, b) => a - b);
  const fps = gaps.length ? clamp(1 / gaps[gaps.length >> 1], 1, 120) : 30;

  let buf = null, aOff = 0, noSound = false;
  const at = tracks.find(t => t.kind === "soun" && t.codec === "mp4a" && t.asc && t.samples.length);
  if (at) {
    try { buf = await decodeAacTrack(file, at); aOff = at.offset; } catch (e) { buf = null; }
  }
  if (!buf) noSound = true;
  const rot = vt.rot % 180 ? 90 : 0;
  return {
    id: V.nextId++, file, name: cleanName(file.name), url: URL.createObjectURL(file), read: fileReader(file),
    vt, frames: pts, start, end, fps, rot: vt.rot, w: rot ? vt.h : vt.w, h: rot ? vt.w : vt.h,
    audio: buf, aOff, peaks: buf ? peaksOf(buf) : null, noSound, color: V.sources.length % 6,
  };
}

/* ---------- Timeline maths ---------- */
const clipLen = c => c.out - c.in;
function starts() { let t = 0; return V.clips.map(c => { const s = t; t += clipLen(c); return s; }); }
function total() { return V.clips.reduce((a, c) => a + clipLen(c), 0); }
// Which clip plays at timeline time T, and the source time in it.
function locate(T) {
  let t = 0;
  for (let i = 0; i < V.clips.length; i++) {
    const c = V.clips[i], L = clipLen(c);
    if (T < t + L || i === V.clips.length - 1) return { i, s: clamp(c.in + T - t, c.in, c.out - 0.001), t0: t };
    t += L;
  }
  return { i: -1, s: 0, t0: 0 };
}

// Cuts land on the nearest frame start, so sound and picture are cut at the same instant.
function frameSnap(src, t) {
  const f = src.frames;
  if (t >= src.end - 1e-6) return src.end;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (f[m] < t) lo = m + 1; else hi = m; }
  return lo > 0 && t - f[lo - 1] < f[lo] - t ? f[lo - 1] : f[lo];
}

/* ---------- Undo ---------- */
const snap = () => V.clips.map(c => ({ ...c }));
function commit(before) {
  V.undo.push(before); if (V.undo.length > 200) V.undo.shift();
  V.redo = [];
  changed();
}
function undoEdit() { if (!V.undo.length || V.exporting) return; V.redo.push(snap()); V.clips = V.undo.pop(); changed(); }
function redoEdit() { if (!V.redo.length || V.exporting) return; V.undo.push(snap()); V.clips = V.redo.pop(); changed(); }
function changed() {
  vPause();
  V.T = clamp(V.T, 0, total());
  V.sel = V.clips.length ? clamp(V.sel, 0, V.clips.length - 1) : -1;
  sizeTimeline(); showFrame(); updateUi();
}

/* ---------- Editing ---------- */
function splitAtPlayhead() {
  if (!V.clips.length || V.exporting) return;
  const { i } = locate(V.T), c = V.clips[i], s = frameSnap(c.src, locate(V.T).s);
  if (s - c.in < MIN_CLIP || c.out - s < MIN_CLIP) { vStatus("Move the playhead a little away from the edge of the clip to split it."); return; }
  const before = snap();
  V.clips.splice(i, 1, { ...c, id: V.nextId++, out: s }, { ...c, id: V.nextId++, in: s });
  V.sel = i + 1;
  commit(before);
  vStatus("Split. Select a piece and press Delete to remove it.");
}
function deleteSelected() {
  if (V.sel < 0 || !V.clips[V.sel] || V.exporting) return;
  const before = snap(), at = starts()[V.sel];
  V.clips.splice(V.sel, 1);
  V.T = at;
  commit(before);
  vStatus(V.clips.length ? "Removed. Press Ctrl+Z to bring it back." : "Removed the last clip. Press Ctrl+Z to bring it back.");
}

/* ---------- Preview: two video players taking turns ---------- */
const vA = $("#vA"), vB = $("#vB");
let act = vA;
const idle = () => (act === vA ? vB : vA);
function load(el, i, srcT) {
  const c = V.clips[i]; if (!c) return;
  if (el.dataset.src !== String(c.src.id)) { el.src = c.src.url; el.dataset.src = c.src.id; }
  el.clipIdx = i;
  if (Math.abs(el.currentTime - srcT) > 0.0005) el.currentTime = srcT;
}
function show(el) {
  act = el;
  vA.classList.toggle("on", el === vA); vB.classList.toggle("on", el === vB);
}
function showFrame() {
  $("#vEmpty").hidden = V.clips.length > 0;
  if (!V.clips.length) { vA.classList.remove("on"); vB.classList.remove("on"); return; }
  const { i, s } = locate(V.T);
  load(act, i, s); show(act);
}
function vPlay() {
  if (!V.clips.length || V.exporting) return;
  if (V.T >= total() - 0.02) V.T = 0;
  const { i, s } = locate(V.T);
  load(act, i, s); show(act);
  act.play().catch(() => {});
  if (V.clips[i + 1]) { const n = idle(); n.pause(); load(n, i + 1, V.clips[i + 1].in); }
  V.playing = true; updateUi();
}
function vPause() {
  if (!V.playing) return;
  V.playing = false; vA.pause(); vB.pause(); updateUi();
}
function vToggle() { V.playing ? vPause() : vPlay(); }
function vSeek(T) {
  const was = V.playing;
  if (was) { V.playing = false; vA.pause(); vB.pause(); }
  V.T = clamp(T, 0, total());
  if (was) vPlay(); else showFrame();
}
function stepFrames(n) {
  if (!V.clips.length) return;
  const c = V.clips[locate(V.T).i];
  vPause(); vSeek(V.T + n / (c.src.fps || 30));
}

// Follow the playing video; at the end of a clip, swap to the other player,
// which is already parked on the next clip's first frame.
function follow() {
  if (!V.playing) return;
  const i = act.clipIdx, c = V.clips[i];
  if (!c) { vPause(); return; }
  const t = act.currentTime, s0 = starts()[i];
  if (t < c.out - 0.02 && !act.ended) { V.T = s0 + Math.max(0, t - c.in); return; }
  const n = i + 1;
  if (n >= V.clips.length) { V.T = total(); vPause(); return; }
  const old = act, nx = idle();
  if (nx.clipIdx !== n) load(nx, n, V.clips[n].in);
  nx.play().catch(() => {}); show(nx); old.pause();
  if (V.clips[n + 1]) load(old, n + 1, V.clips[n + 1].in);
  V.T = s0 + clipLen(c);
}

/* ---------- Timeline drawing ---------- */
const tl = { box: $("#vtl"), inner: $("#vtlInner"), cv: $("#vtlCanvas"), pad: 16, h: 132, rulerH: 24, clipY: 32, clipH: 88, drag: null, col: null };
const fitPps = () => (tl.box.clientWidth - 2 * tl.pad) / Math.max(total(), 1);
// the scale holds still during a drag, so a trimmed edge stays under the pointer
const pps = () => (tl.drag && tl.drag.pps) || fitPps() * V.zoom;
function sizeTimeline() {
  const w = tl.box.clientWidth, dpr = window.devicePixelRatio || 1;
  tl.inner.style.width = Math.max(w, total() * pps() + 2 * tl.pad) + "px";
  tl.cv.style.width = w + "px"; tl.cv.style.height = tl.h + "px";
  if (tl.cv.width !== Math.round(w * dpr) || tl.cv.height !== Math.round(tl.h * dpr)) { tl.cv.width = Math.round(w * dpr); tl.cv.height = Math.round(tl.h * dpr); }
}
function readColors() {
  tl.col = { ink: cssVar("--ink"), muted: cssVar("--muted"), line: cssVar("--line"), accent: cssVar("--accent"), surface: cssVar("--surface"),
    t: [1, 2, 3, 4, 5, 6].map(n => cssVar(`--t${n}`)) };
}
const xOf = t => tl.pad + t * pps() - tl.box.scrollLeft;
const tOf = x => (x + tl.box.scrollLeft - tl.pad) / pps();
// Clip positions, with a gap while a left edge is being dragged so the edge follows the pointer.
function clipBoxes() {
  const d = tl.drag, out = [];
  let t = 0;
  V.clips.forEach((c, i) => {
    if (d && d.kind === "trim" && d.edge === "l" && i === d.i) t += c.in - d.orig.in;
    out.push({ i, c, t0: t, t1: t + clipLen(c) });
    t += clipLen(c);
  });
  return out;
}
function niceStep(minSec) {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s >= minSec) return s;
  return 1200;
}
function drawTimeline() {
  if (!tl.col) readColors();
  const g = tl.cv.getContext("2d"), dpr = window.devicePixelRatio || 1, W = tl.cv.width / dpr, C = tl.col;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, tl.h);
  if (!V.clips.length) return;
  const p = pps();
  // ruler
  const step = niceStep(70 / p), first = Math.max(0, Math.floor(tOf(0) / step) * step);
  g.font = `11px ${cssVar("--mono") || "monospace"}`; g.textBaseline = "middle";
  for (let t = first; t <= total() + 1e-6; t += step) {
    const x = xOf(t); if (x > W) break;
    g.fillStyle = C.line; g.fillRect(Math.round(x), 16, 1, 8);
    g.fillStyle = C.muted; g.fillText(fmt(t, step < 1 ? 1 : 0), x + 4, 10);
  }
  // clips
  const d = tl.drag;
  for (const b of clipBoxes()) {
    if (d && d.kind === "move" && d.moved && b.i === d.i) continue;
    drawClip(g, b.c, xOf(b.t0), xOf(b.t1), b.i === V.sel, 1);
  }
  if (d && d.kind === "move" && d.moved) {
    const c = V.clips[d.i], w = clipLen(c) * p, x0 = d.x - d.grab;
    const ins = insertAt(d), bx = clipBoxes();
    const at = ins < bx.length ? xOf(bx[ins].t0) : xOf(total());
    g.fillStyle = C.accent; g.fillRect(Math.round(at) - 1, tl.clipY - 4, 3, tl.clipH + 8);
    drawClip(g, c, x0, x0 + w, true, 0.75);
  }
  // playhead
  const x = Math.round(xOf(V.T));
  g.fillStyle = C.accent; g.fillRect(x - 1, 14, 2, tl.h - 14);
  g.beginPath(); g.moveTo(x - 6, 12); g.lineTo(x + 6, 12); g.lineTo(x, 20); g.closePath(); g.fill();
}
function drawClip(g, c, x0, x1, selected, alpha) {
  const C = tl.col, y = tl.clipY, h = tl.clipH, W = tl.cv.width / (window.devicePixelRatio || 1);
  if (x1 < 0 || x0 > W) return;
  const col = C.t[c.src.color];
  g.save(); g.globalAlpha = alpha;
  const l = x0 + 1, w = Math.max(2, x1 - x0 - 2);
  g.beginPath(); g.roundRect(l, y, w, h, 6);
  g.fillStyle = C.surface; g.fill();
  g.globalAlpha = alpha * 0.16; g.fillStyle = col; g.fill(); g.globalAlpha = alpha;
  g.lineWidth = selected ? 2.5 : 1; g.strokeStyle = selected ? C.ink : col; g.stroke();
  g.clip();
  // sound waveform, so pauses and mistakes are easy to spot
  const s = c.src, mid = y + 58, amp = 24, p = pps();
  if (s.peaks) {
    g.fillStyle = col;
    for (let px = Math.max(Math.floor(l), 0); px < Math.min(l + w, W); px += 2) {
      const st = c.in + (px - x0) / p, en = st + 2 / p;
      let k0 = Math.floor((st - s.aOff) * PEAKS_PER_SEC), k1 = Math.max(k0 + 1, Math.ceil((en - s.aOff) * PEAKS_PER_SEC)), m = 0;
      for (let k = Math.max(0, k0); k < Math.min(k1, s.peaks.length); k++) if (s.peaks[k] > m) m = s.peaks[k];
      const hh = Math.max(1, m * amp);
      g.fillRect(px, mid - hh, 1.5, hh * 2);
    }
  } else {
    g.fillStyle = C.muted; g.font = "12px " + (cssVar("--body") || "sans-serif");
    g.fillText("no sound", l + 8, mid);
  }
  if (w > 40) {
    g.fillStyle = C.ink; g.font = "600 12px " + (cssVar("--body") || "sans-serif"); g.textBaseline = "middle";
    g.fillText(`${s.name} · ${fmt(clipLen(c), 1)}`, l + 8, y + 14, Math.max(0, w - 16));
  }
  g.restore();
}

/* ---------- Timeline pointer: select, scrub, trim, reorder ---------- */
const EDGE = 7;
function hit(x, y) {
  if (y < tl.clipY || y > tl.clipY + tl.clipH) return null;
  for (const b of clipBoxes()) {
    const x0 = xOf(b.t0), x1 = xOf(b.t1);
    if (x < x0 - EDGE || x > x1 + EDGE) continue;
    if (Math.abs(x - x0) <= EDGE && x1 - x0 > 3 * EDGE) return { i: b.i, edge: "l" };
    if (Math.abs(x - x1) <= EDGE && x1 - x0 > 3 * EDGE) return { i: b.i, edge: "r" };
    if (x >= x0 && x <= x1) return { i: b.i, edge: null };
  }
  return null;
}
function insertAt(d) {
  const t = tOf(d.x - d.grab + clipLen(V.clips[d.i]) * pps() / 2);
  let k = 0;
  for (const b of clipBoxes()) { if (b.i === d.i) continue; if (t > (b.t0 + b.t1) / 2) k++; }
  return k >= d.i ? k + 1 : k;   // index in the current list, before the dragged clip is taken out
}
tl.cv.addEventListener("pointerdown", e => {
  if (!V.clips.length || V.exporting || e.button !== 0) return;
  const x = e.offsetX, y = e.offsetY, h = hit(x, y);
  tl.cv.setPointerCapture(e.pointerId);
  if (h && h.edge) {
    vPause();
    const c = V.clips[h.i];
    tl.drag = { kind: "trim", i: h.i, edge: h.edge, x0: x, orig: { in: c.in, out: c.out }, before: snap(), pps: pps() };
    V.sel = h.i;
  } else if (h) {
    V.sel = h.i;
    const b = clipBoxes()[h.i];
    tl.drag = { kind: "move", i: h.i, x0: x, x, grab: x - xOf(b.t0), moved: false };
    vSeek(tOf(x));
  } else {
    tl.drag = { kind: "scrub" };
    vSeek(tOf(x));
  }
  updateUi();
});
tl.cv.addEventListener("pointermove", e => {
  const x = e.offsetX, d = tl.drag;
  if (!d) {
    const h = V.clips.length && !V.exporting ? hit(x, e.offsetY) : null;
    tl.cv.style.cursor = h ? (h.edge ? "ew-resize" : "grab") : "pointer";
    return;
  }
  if (d.kind === "scrub") { vSeek(tOf(x)); return; }
  if (d.kind === "move") {
    d.x = x;
    if (!d.moved && Math.abs(x - d.x0) > 5) { d.moved = true; vPause(); tl.cv.style.cursor = "grabbing"; }
    if (!d.moved) vSeek(tOf(x));
    return;
  }
  // trim: the preview shows the frame at the edge being dragged
  const c = V.clips[d.i], dt = (x - d.x0) / pps();
  if (d.edge === "l") {
    c.in = frameSnap(c.src, clamp(d.orig.in + dt, c.src.start, c.out - MIN_CLIP));
    load(act, d.i, c.in); show(act);
    V.T = starts()[d.i];
  } else {
    c.out = frameSnap(c.src, clamp(d.orig.out + dt, c.in + MIN_CLIP, c.src.end));
    load(act, d.i, Math.max(c.in, c.out - 1 / (c.src.fps || 30))); show(act);
    V.T = starts()[d.i] + clipLen(c) - 0.001;
  }
  sizeTimeline(); updateUi();
});
function endDrag() {
  const d = tl.drag; tl.drag = null;
  if (!d) return;
  tl.cv.style.cursor = "";
  sizeTimeline();
  if (d.kind === "move" && d.moved) {
    const to = insertAt(d);
    if (to !== d.i && to !== d.i + 1) {
      const before = snap(), [c] = V.clips.splice(d.i, 1), k = to > d.i ? to - 1 : to;
      V.clips.splice(k, 0, c); V.sel = k; V.T = starts()[k];
      commit(before);
      vStatus("Moved the clip.");
      return;
    }
  }
  if (d.kind === "trim") {
    const c = V.clips[d.i];
    if (c.in !== d.orig.in || c.out !== d.orig.out) { commit(d.before); vStatus(`Trimmed to ${fmt(clipLen(c), 1)}.`); return; }
  }
  updateUi();
}
tl.cv.addEventListener("pointerup", endDrag);
tl.cv.addEventListener("pointercancel", endDrag);
tl.cv.addEventListener("lostpointercapture", endDrag);
tl.box.addEventListener("wheel", e => {
  if (!(e.ctrlKey || e.metaKey) || !V.clips.length) return;
  e.preventDefault();
  const r = tl.box.getBoundingClientRect(), x = e.clientX - r.left, t = tOf(x);
  setZoom(V.zoom * Math.exp(-e.deltaY * 0.002), t, x);
}, { passive: false });
function setZoom(z, anchorT = V.T, anchorX = null) {
  V.zoom = clamp(z, 1, 80);
  $("#vZoom").value = Math.round(Math.log(V.zoom) / Math.log(80) * 100);
  sizeTimeline();
  tl.box.scrollLeft = tl.pad + anchorT * pps() - (anchorX == null ? tl.box.clientWidth / 2 : anchorX);
}

/* ---------- Export ---------- */
async function pickEncoder(W, H, fps, bitrate) {
  for (const codec of ["avc1.640033", "avc1.64002a", "avc1.640028", "avc1.4d0033", "avc1.4d0028", "avc1.42e033", "avc1.42e028"]) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: "avc" }, latencyMode: "quality" };
    if (await VideoEncoder.isConfigSupported(cfg).then(r => r.supported, () => false)) return cfg;
  }
  return null;
}
function drawSourceFrame(g, W, H, f, rot) {
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  if (!f) return;
  const fw = f.displayWidth, fh = f.displayHeight, turned = rot % 180 !== 0;
  const sc = Math.min(W / (turned ? fh : fw), H / (turned ? fw : fh));
  g.save(); g.translate(W / 2, H / 2); g.rotate(rot * Math.PI / 180);
  g.drawImage(f, -fw * sc / 2, -fh * sc / 2, fw * sc, fh * sc);
  g.restore();
}
// The timeline's sound for samples [a, a + n), cut at exactly the same source
// times as the picture, with a 6 ms fade at each join so cuts don't click.
function audioBlock(lay, sr, a, n) {
  const L = new Float32Array(n), R = new Float32Array(n), fade = Math.round(0.006 * sr);
  V.clips.forEach((c, i) => {
    const s = c.src; if (!s.audio) return;
    const cS = Math.round(lay[i] * sr), cE = Math.round((lay[i] + clipLen(c)) * sr);
    const j0 = Math.max(a, cS), j1 = Math.min(a + n, cE);
    if (j1 <= j0) return;
    const sl = s.audio.getChannelData(0), sr2 = s.audio.numberOfChannels > 1 ? s.audio.getChannelData(1) : sl;
    const base = Math.round((c.in - lay[i] - s.aOff) * sr);
    for (let j = j0; j < j1; j++) {
      const k = j + base; if (k < 0 || k >= sl.length) continue;
      const gain = Math.min(1, (j - cS) / fade, (cE - j) / fade);
      L[j - a] = sl[k] * gain; R[j - a] = sr2[k] * gain;
    }
  });
  const data = new Float32Array(n * 2); data.set(L, 0); data.set(R, n);
  return data;
}
// Decode one clip's frames in presentation order and emit an output frame for
// every tick of the export clock, holding the frame shown at that source time.
async function exportClip(c, kEnd, srcAt, emitter) {
  const s = c.src, smp = s.vt.samples;
  let first = 0;
  for (let j = 0; j < smp.length; j++) if (smp[j].sync && smp[j].pts <= c.in + 1e-6) first = j;
  const queue = []; let err = null, prev = null;
  const dec = new VideoDecoder({ output: f => queue.push(f), error: e => (err = e) });
  dec.configure(s.vt.config);
  const take = async f => {
    const p = f.timestamp / 1e6;
    while (emitter.k < kEnd && srcAt(emitter.k) < p) await emitter.emit(prev || f, s.rot);
    if (prev) prev.close();
    prev = f;
  };
  const drain = async () => { while (queue.length) await take(queue.shift()); };
  try {
    for (let j = first; j < smp.length && emitter.k < kEnd; j++) {
      const sm = smp[j];
      if (j > first && sm.sync && sm.pts >= c.out) break;
      const data = await s.read(sm.off, sm.size);
      dec.decode(new EncodedVideoChunk({ type: sm.sync ? "key" : "delta", timestamp: Math.round(sm.pts * 1e6), data }));
      await drain();
      while (dec.decodeQueueSize > 4) { await roomIn(dec, 4); await drain(); if (err) throw err; }
      if (err) throw err;
    }
    await dec.flush(); await drain();
    if (err) throw err;
    while (emitter.k < kEnd) await emitter.emit(prev, s.rot);
  } finally {
    if (prev) prev.close();
    queue.forEach(f => f.close());
    if (dec.state !== "closed") dec.close();
  }
}
function exportName() { return ($("#vName").value.trim() || "my-video").replace(/[\\/:*?"<>|]+/g, "-"); }
async function vExport() {
  if (V.exporting) { V.cancel = true; return; }
  if (!V.clips.length) return;
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") { vStatus("Exporting video needs Chrome or Edge on a computer.", true); return; }
  vPause();
  const name = exportName() + ".mp4";
  // ask where to save first, while the click still counts as a user action
  let writable = null;
  if (window.showSaveFilePicker && window.self === window.top) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
      writable = await fh.createWritable();
    } catch (e) { if (e && e.name === "AbortError") return; writable = null; }
  }
  V.exporting = true; V.cancel = false; updateUi();
  const prog = $("#vProg"), note = $("#vNote");
  prog.hidden = false; prog.value = 0;
  let venc = null, aenc = null;
  try {
    const s0 = V.clips[0].src;
    const k = Math.min(1, 1920 / Math.max(s0.w, s0.h), 1080 / Math.min(s0.w, s0.h));
    const W = Math.round(s0.w * k / 2) * 2, H = Math.round(s0.h * k / 2) * 2;
    const fps = [24, 25, 30, 50, 60].reduce((a, b) => Math.abs(b - s0.fps) < Math.abs(a - s0.fps) ? b : a);
    const bitrate = clamp(Math.round(W * H * fps * 0.14), 2e6, 16e6);
    const vcfg = await pickEncoder(W, H, fps, bitrate);
    if (!vcfg) throw new Error("this browser can't make MP4 video at this size. Try Chrome or Edge");
    const sr = audio().sampleRate;
    const acfg = { codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: 2, bitrate: 192000 };
    if (!(await AudioEncoder.isConfigSupported(acfg).then(r => r.supported, () => false))) throw new Error("this browser can't make AAC sound. Try Chrome or Edge");

    const target = writable ? new Mp4Muxer.FileSystemWritableFileStreamTarget(writable) : new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({ target, video: { codec: "avc", width: W, height: H, frameRate: fps }, audio: { codec: "aac", numberOfChannels: 2, sampleRate: sr },
      fastStart: writable ? false : "in-memory", firstTimestampBehavior: "offset" });
    let err = null;
    venc = new VideoEncoder({ output: (ch, m) => muxer.addVideoChunk(ch, m), error: e => (err = e) }); venc.configure(vcfg);
    aenc = new AudioEncoder({ output: (ch, m) => muxer.addAudioChunk(ch, m), error: e => (err = e) }); aenc.configure(acfg);

    const lay = starts(), TT = total(), frames = Math.max(1, Math.round(TT * fps)), AS = Math.round(TT * sr);
    const cv = new OffscreenCanvas(W, H), g = cv.getContext("2d");
    let ap = 0;
    const feedAudio = upTo => {
      while (ap < upTo) {
        const n = Math.min(Math.round(sr / 2), upTo - ap);
        const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(ap / sr * 1e6), data: audioBlock(lay, sr, ap, n) });
        aenc.encode(ad); ad.close(); ap += n;
      }
    };
    const t0 = performance.now();
    const emitter = {
      k: 0,
      async emit(f, rot) {
        if (V.cancel) throw new Error("cancelled");
        drawSourceFrame(g, W, H, f, rot);
        const vf = new VideoFrame(cv, { timestamp: Math.round(this.k * 1e6 / fps), duration: Math.round(1e6 / fps) });
        venc.encode(vf, { keyFrame: this.k % (fps * 2) === 0 }); vf.close();
        this.k++;
        feedAudio(Math.min(AS, Math.round((this.k / fps + 0.5) * sr)));
        await roomIn(venc, 4); await roomIn(aenc, 20);
        if (err) throw err;
        if (this.k % 10 === 0) {
          prog.value = this.k / frames;
          const el = (performance.now() - t0) / 1000;
          note.textContent = `Exporting… about ${fmt(el / this.k * (frames - this.k), 0)} left. Keep this tab open.`;
          await nextTask();
        }
      },
    };
    note.textContent = "Exporting…";
    for (let i = 0; i < V.clips.length; i++) {
      const c = V.clips[i], cs = lay[i], kEnd = Math.min(frames, Math.round((cs + clipLen(c)) * fps));
      await exportClip(c, kEnd, k => c.in + (k / fps - cs) + 0.0005, emitter);
    }
    while (emitter.k < frames) await emitter.emit(null, 0);
    feedAudio(AS);
    await venc.flush(); await aenc.flush();
    if (err) throw err;
    venc.close(); aenc.close(); venc = aenc = null;
    muxer.finalize();
    prog.value = 1;
    if (writable) { await writable.close(); writable = null; toast(`Saved ${name}`); }
    else await saveFile(new Blob([target.buffer], { type: "video/mp4" }), name);
    vStatus(`Exported ${name}: ${W}×${H}, ${fps} fps, ${fmt(TT, 0)} long.`);
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch (_) {} }
    if (e && e.message === "cancelled") vStatus("Export cancelled.");
    else vStatus("Export failed: " + ((e && e.message) || e), true);
  } finally {
    try { if (venc && venc.state !== "closed") venc.close(); } catch (_) {}
    try { if (aenc && aenc.state !== "closed") aenc.close(); } catch (_) {}
    V.exporting = false; V.cancel = false;
    prog.hidden = true; note.textContent = "Exports at your video's own size, up to 1080p.";
    updateUi();
  }
}

/* ---------- Adding videos ---------- */
async function addVideos(files) {
  files = [...files].filter(f => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name));
  if (!files.length) { vStatus("Add MP4 or MOV videos.", true); return; }
  if (V.exporting) { vStatus("Wait for the export to finish first.", true); return; }
  vPause();
  const before = snap(), failed = [];
  let added = 0;
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    vStatus(`Reading ${f.name} (${n + 1} of ${files.length})…`);
    await sleep(0);
    try {
      const s = await openSource(f);
      V.sources.push(s);
      V.clips.push({ id: V.nextId++, src: s, in: s.start, out: s.end });
      if (!$("#vName").value.trim()) $("#vName").value = s.name;
      added++;
    } catch (e) { failed.push(`${f.name}: ${(e && e.message) || "it couldn't be read"}`); }
  }
  if (added) {
    if (V.sel < 0) V.sel = 0;
    commit(before);
    requestAnimationFrame(() => { sizeTimeline(); showFrame(); });
  }
  const msg = (added ? `Added ${added} video${added > 1 ? "s" : ""}. ` : "") + (failed.length ? `Couldn't open ${failed.join("; ")}.` : "");
  vStatus(msg.trim(), failed.length > 0);
  const silent = V.sources.slice(-added).filter(s => s.noSound);
  if (added && silent.length) toast(`${silent.map(s => s.name).join(", ")} has no sound Hookd can read, so it will be silent.`);
}

/* ---------- UI ---------- */
function vStatus(msg, err) { const s = $("#vStatus"); s.textContent = msg; s.classList.toggle("err", !!err); }
function updateUi() {
  const has = V.clips.length > 0, busy = V.exporting;
  $("#vPlay").disabled = !has || busy;
  $("#vPlay").textContent = V.playing ? "Pause" : "Play";
  $("#vSplit").disabled = !has || busy;
  $("#vDelete").disabled = V.sel < 0 || busy;
  $("#vUndo").disabled = !V.undo.length || busy;
  $("#vRedo").disabled = !V.redo.length || busy;
  $("#vBack").disabled = $("#vFwd").disabled = !has || busy;
  $("#vExport").disabled = !has;
  $("#vExport").textContent = busy ? "Cancel export" : "Export MP4";
  $("#vExport").classList.toggle("primary", !busy);
  $("#vAdd").classList.toggle("primary", !has);
  $("#vZoom").disabled = !has;
}
let vRaf = 0;
function vLoop() {
  follow();
  if (V.playing) {   // keep the playhead in view
    const x = xOf(V.T), w = tl.box.clientWidth;
    if (x > w - 40 || x < 0) tl.box.scrollLeft += x - 60;
  }
  drawTimeline();
  $("#vTime").textContent = `${fmt(V.T, 1)} / ${fmt(total(), 1)}`;
  vRaf = requestAnimationFrame(vLoop);
}
// Called by setMode in app.js.
function videoShown(on) {
  cancelAnimationFrame(vRaf);
  if (!on) { vPause(); return; }
  readColors();
  requestAnimationFrame(() => { sizeTimeline(); showFrame(); updateUi(); vLoop(); });
}

$("#vFileIn").addEventListener("change", e => { addVideos(e.target.files); e.target.value = ""; });
$("#vAdd").addEventListener("click", () => $("#vFileIn").click());
$("#vPlay").addEventListener("click", vToggle);
$("#vSplit").addEventListener("click", splitAtPlayhead);
$("#vDelete").addEventListener("click", deleteSelected);
$("#vUndo").addEventListener("click", undoEdit);
$("#vRedo").addEventListener("click", redoEdit);
$("#vBack").addEventListener("click", () => stepFrames(-1));
$("#vFwd").addEventListener("click", () => stepFrames(1));
$("#vExport").addEventListener("click", vExport);
$("#vZoom").addEventListener("input", e => setZoom(Math.pow(80, e.target.value / 100)));
// backup for when the page isn't drawing (another tab in front): still honour the cuts
[vA, vB].forEach(el => el.addEventListener("timeupdate", () => { if (el === act) follow(); }));
[vA, vB].forEach(el => el.addEventListener("error", () => {
  if (el.dataset.src) vStatus("This browser can't play one of the videos in the preview. Export may still work.", true);
}));
new ResizeObserver(() => { if (state.mode === "video") sizeTimeline(); }).observe(tl.box);
new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);

document.addEventListener("keydown", e => {
  if (state.mode !== "video" || e.altKey) return;
  if (e.target.closest("input, select, textarea, [contenteditable]")) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (mod && (k === "z" || k === "Z")) { e.preventDefault(); e.shiftKey ? redoEdit() : undoEdit(); return; }
  if (mod && (k === "y" || k === "Y")) { e.preventDefault(); redoEdit(); return; }
  if (mod) return;
  if (k === " " && !e.target.closest("button")) { e.preventDefault(); vToggle(); }
  else if (k === "s" || k === "S") { e.preventDefault(); splitAtPlayhead(); }
  else if (k === "Delete" || k === "Backspace") { e.preventDefault(); deleteSelected(); }
  else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? vSeek(V.T - 1) : stepFrames(-1); }
  else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? vSeek(V.T + 1) : stepFrames(1); }
  else if (k === "Home") { e.preventDefault(); vSeek(0); }
  else if (k === "End") { e.preventDefault(); vSeek(total()); }
});
window.addEventListener("beforeunload", e => { if (V.exporting || V.clips.length) { e.preventDefault(); e.returnValue = ""; } });
updateUi();
