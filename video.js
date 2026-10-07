"use strict";
/* ---------- Video editor ----------
   Video mode: cut, trim, reorder and join MP4/MOV videos, then export one MP4.
   Sound and picture are always cut at the same source times, and on export every
   frame is placed by its own timestamp, so phone videos recorded at a changing
   frame rate don't drift out of lip sync. Uses $, fmt, clamp, toast, audio,
   saveFile and esdsConfig from app.js. */

const V = {
  sources: [], clips: [], sel: -1, selJoin: -1, T: 0, playing: false,
  undo: [], redo: [], zoom: 1, exporting: false, cancel: false, nextId: 1, version: 0,
  title: { on: false, text: "", sub: "", dur: 3 },
  shape: "original", fit: "fit",
  music: null,   // { name, buffer, vol, duck }
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

// Loudness every 20 ms, and the level above which someone is talking: well
// above the quietest stretches (room noise), so music can dip under the voice.
const LEVELS_PER_SEC = 50;
function levelsOf(buf) {
  const n = Math.ceil(buf.duration * LEVELS_PER_SEC), per = buf.sampleRate / LEVELS_PER_SEC, levels = new Float32Array(n);
  const chs = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (const d of chs) for (let j = Math.floor(i * per), e = Math.min(d.length, Math.floor((i + 1) * per)); j < e; j += 2) { sum += d[j] * d[j]; cnt++; }
    levels[i] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(sorted.length * 0.15)] || 0;
  return { levels, voiceThr: clamp(floor * 4, 0.006, 0.06) };
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
    audio: buf, aOff, peaks: buf ? peaksOf(buf) : null, ...(buf ? levelsOf(buf) : { levels: null, voiceThr: 1 }), noSound, color: V.sources.length % 6,
  };
}

/* ---------- Timeline plan ----------
   The title card (if on) and the clips in order, each with its place on the
   timeline and the transition into it. A crossfade overlaps two clips; fade
   through black and quick zoom happen half before and half after the cut. */
const clipLen = c => c.out - c.in;
const TRANS = { cut: "Cut", crossfade: "Crossfade", black: "Fade through black", zoom: "Quick zoom" };
const MICRO = 0.006;    // tiny fade at every cut so the sound never clicks
const TITLE_TRANS = { type: "black", dur: 0.8 };
function vplan() {
  const items = [];
  if (V.title.on) items.push({ kind: "title", len: V.title.dur, ci: -1 });
  V.clips.forEach((c, ci) => items.push({ kind: "clip", c, ci, len: clipLen(c) }));
  let t = 0;
  items.forEach((it, i) => {
    const prev = items[i - 1];
    const tr = !prev ? null : prev.kind === "title" ? TITLE_TRANS : (it.c.trans || null);
    const type = tr ? tr.type : "cut", dur = tr ? tr.dur : 0;
    const ov = prev && type === "crossfade" ? Math.min(dur, prev.len / 2, it.len / 2) : 0;
    const h = prev && (type === "black" || type === "zoom") ? Math.min(dur / 2, prev.len / 2, it.len / 2) : 0;
    it.inT = prev ? { type, ov, h } : null;
    if (prev) prev.outT = it.inT;
    it.start = t - ov; it.end = it.start + it.len;
    t = it.end;
  });
  return { items, total: t };
}
const vtotal = () => vplan().total;
const clipItem = (P, ci) => P.items.find(it => it.ci === ci);

// Sound level of an item at timeline time t (0 to 1).
function gainOf(it, t) {
  const a = t - it.start, b = it.end - t, I = it.inT, O = it.outT;
  let g = 1;
  if (I && I.ov && a < I.ov) g *= Math.sin(a / I.ov * Math.PI / 2);
  else if (I && I.type === "black" && a < I.h) g *= a / I.h;
  else if (a < MICRO) g *= Math.max(0, a / MICRO);
  if (O && O.ov && b < O.ov) g *= Math.sin(b / O.ov * Math.PI / 2);
  else if (O && O.type === "black" && b < O.h) g *= b / O.h;
  else if (b < MICRO) g *= Math.max(0, b / MICRO);
  return g;
}
// What is on screen at time t: the layers (bottom first) and how dark the picture is.
function layersAt(P, t) {
  const layers = [];
  let black = 0;
  for (const it of P.items) {
    if (t < it.start || t >= it.end) continue;
    const a = t - it.start, b = it.end - t, I = it.inT, O = it.outT;
    let alpha = 1, scale = 1;
    if (I && I.ov && a < I.ov) alpha = a / I.ov;
    if (I && I.type === "black" && a < I.h) black = Math.max(black, 1 - a / I.h);
    if (O && O.type === "black" && b < O.h) black = Math.max(black, 1 - b / O.h);
    if (I && I.type === "zoom" && a < I.h) { const p = 1 - a / I.h; scale *= 1 + 0.35 * p * p; }
    if (O && O.type === "zoom" && b < O.h) { const p = 1 - b / O.h; scale *= 1 + 0.35 * p * p; }
    layers.push({ it, alpha, scale, src: it.kind === "clip" ? clamp(it.c.in + a, it.c.in, it.c.out - 0.001) : 0 });
  }
  if (!layers.length && P.items.length && t >= P.total) {
    const it = P.items.at(-1);
    layers.push({ it, alpha: 1, scale: 1, src: it.kind === "clip" ? it.c.out - 0.001 : 0 });
  }
  return { layers, black };
}
// The clip on top at time T, and the source time in it (for splitting).
function locate(T) {
  const P = vplan(), top = layersAt(P, Math.min(T, P.total)).layers.filter(L => L.it.kind === "clip").at(-1);
  return top ? { i: top.it.ci, s: top.src } : { i: -1, s: 0 };
}

// Cuts land on the nearest frame start, so sound and picture are cut at the same instant.
function frameSnap(src, t) {
  const f = src.frames;
  if (t >= src.end - 1e-6) return src.end;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (f[m] < t) lo = m + 1; else hi = m; }
  return lo > 0 && t - f[lo - 1] < f[lo] - t ? f[lo - 1] : f[lo];
}

/* ---------- Music under the voice ---------- */
const DUCK = 0.3, DUCK_RATE = 50;
let duckCache = { key: "", curve: null };
// Music level multiplier through the video: 1, or 0.3 while someone is talking.
function duckCurve(P) {
  const key = V.version + ":" + (V.music && V.music.duck);
  if (duckCache.key === key) return duckCache.curve;
  const n = Math.ceil(P.total * DUCK_RATE) + 1, talk = new Uint8Array(n), curve = new Float32Array(n).fill(1);
  if (V.music && V.music.duck) {
    for (const it of P.items) {
      if (it.kind !== "clip" || !it.c.src.levels) continue;
      const s = it.c.src;
      for (let k = Math.max(0, Math.ceil(it.start * DUCK_RATE)); k < Math.min(n, it.end * DUCK_RATE); k++) {
        const li = Math.floor((it.c.in + k / DUCK_RATE - it.start - s.aOff) * LEVELS_PER_SEC);
        if (s.levels[li] > s.voiceThr) talk[k] = 1;
      }
    }
    // dip quickly when talking starts, come back up slowly so short pauses don't pump
    let d = 1;
    const down = 1 - Math.exp(-1 / (DUCK_RATE * 0.08)), up = 1 - Math.exp(-1 / (DUCK_RATE * 0.6));
    for (let k = 0; k < n; k++) { const target = talk[k] ? DUCK : 1; d += (target - d) * (target < d ? down : up); curve[k] = d; }
    // start dipping a little before the first word
    for (let k = 0; k < n - 5; k++) curve[k] = Math.min(curve[k], curve[k + 5]);
  }
  duckCache = { key, curve };
  return curve;
}
function musicGain(P, t) {
  if (!V.music) return 0;
  const c = duckCurve(P), d = c[clamp(Math.round(t * DUCK_RATE), 0, c.length - 1)];
  const fadeIn = Math.min(1, t / 0.5), fadeOut = P.total > 4 ? Math.min(1, (P.total - t) / 2) : 1;
  return V.music.vol * d * Math.max(0, Math.min(fadeIn, fadeOut));
}

/* ---------- Picture: shared by the preview and the export ---------- */
const SHAPES = { original: null, wide: [16, 9], square: [1, 1], portrait: [4, 5], vertical: [9, 16] };
const even = x => Math.max(2, Math.round(x / 2) * 2);
function outSize() {
  const first = V.clips[0] && V.clips[0].src;
  if (!first) return [1280, 720];
  const r = SHAPES[V.shape];
  if (!r) {
    const k = Math.min(1, 1920 / Math.max(first.w, first.h), 1080 / Math.min(first.w, first.h));
    return [even(first.w * k), even(first.h * k)];
  }
  // the sharpest clip sets the size; at least 720 so feeds don't show a tiny video
  const short = clamp(Math.max(...V.clips.map(c => Math.min(c.src.w, c.src.h))), 720, 1080);
  return r[0] >= r[1] ? [even(short * r[0] / r[1]), even(short)] : [even(short), even(short * r[1] / r[0])];
}
const blurCv = document.createElement("canvas"), blurG = blurCv.getContext("2d");
const canFilter = "filter" in blurG;
function drawRotated(g, img, iw, ih, rot, cx, cy, k) {
  g.save(); g.translate(cx, cy); g.rotate(rot * Math.PI / 180);
  g.drawImage(img, -iw * k / 2, -ih * k / 2, iw * k, ih * k);
  g.restore();
}
function drawMedia(g, W, H, m, scale, alpha) {
  const turned = m.rot % 180 !== 0, dw = turned ? m.h : m.w, dh = turned ? m.w : m.h;
  if (!dw || !dh) return;
  const fit = Math.min(W / dw, H / dh), cover = Math.max(W / dw, H / dh);
  g.save(); g.globalAlpha = alpha;
  if (V.fit === "fit" && (dw * fit < W - 2 || dh * fit < H - 2)) {
    // the bars show a blurred, darkened copy of the same picture
    const bw = 72, bh = Math.max(1, Math.round(72 * H / W));
    if (blurCv.width !== bw || blurCv.height !== bh) { blurCv.width = bw; blurCv.height = bh; }
    blurG.filter = canFilter ? "blur(3px)" : "none";
    drawRotated(blurG, m.img, m.w, m.h, m.rot, bw / 2, bh / 2, Math.max(bw / dw, bh / dh) * 1.15);
    g.imageSmoothingQuality = "high";
    g.drawImage(blurCv, 0, 0, W, H);
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, 0, W, H);
  }
  drawRotated(g, m.img, m.w, m.h, m.rot, W / 2, H / 2, (V.fit === "fill" ? cover : fit) * scale);
  g.restore();
}
function drawTitle(g, W, H, alpha) {
  const u = Math.min(W, H), fs = Math.round(u * 0.085), sfs = Math.round(u * 0.042), lh = fs * 1.15;
  g.save(); g.globalAlpha = alpha;
  g.fillStyle = "#16111B"; g.fillRect(0, 0, W, H);
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  g.font = `700 ${fs}px Figtree, system-ui, sans-serif`;
  const lines = wrapLines(g, V.title.text.trim() || "Your title here", W * 0.84), sub = V.title.sub.trim();
  const blockH = (lines.length - 1) * lh + fs * 0.75 + fs * 0.5 + Math.max(3, u * 0.008) + (sub ? sfs * 1.7 : 0);
  let y = H / 2 - blockH / 2 + fs * 0.75;
  g.fillStyle = "#F2EAF1";
  lines.forEach((l, i) => g.fillText(l, W / 2, y + i * lh));
  const barY = y + (lines.length - 1) * lh + fs * 0.5;
  g.fillStyle = "#FF5C9A"; g.fillRect(W / 2 - u * 0.06, barY, u * 0.12, Math.max(3, u * 0.008));
  if (sub) { g.font = `500 ${sfs}px Figtree, system-ui, sans-serif`; g.fillStyle = "#C9BAC6"; g.fillText(sub, W / 2, barY + sfs * 1.7); }
  g.restore();
}
// One output picture. getImg(layer) gives the picture for a clip layer, or null.
function compose(g, W, H, st, getImg) {
  g.globalAlpha = 1; g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  for (const L of st.layers) {
    if (L.it.kind === "title") drawTitle(g, W, H, L.alpha);
    else { const m = getImg(L); if (m) drawMedia(g, W, H, m, L.scale, L.alpha); }
  }
  if (st.black > 0) { g.globalAlpha = Math.min(1, st.black); g.fillStyle = "#000"; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
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
  V.version++;
  vPause();
  V.T = clamp(V.T, 0, vtotal());
  V.sel = V.clips.length ? Math.min(V.sel, V.clips.length - 1) : -1;
  if (V.selJoin < 1 || V.selJoin >= V.clips.length) V.selJoin = -1;
  sizeTimeline(); sizePreview(); vtick(); updateUi();
}
// Settings outside the undo history (music, title, shape) just redraw.
function settingsChanged() { V.version++; V.T = clamp(V.T, 0, vtotal()); sizeTimeline(); sizePreview(); vtick(); updateUi(); }

/* ---------- Editing ---------- */
function splitAtPlayhead() {
  if (!V.clips.length || V.exporting) return;
  const L = locate(V.T), c = V.clips[L.i];
  if (!c) { vStatus("Move the playhead onto a clip to split it."); return; }
  const s = frameSnap(c.src, L.s);
  if (s - c.in < MIN_CLIP || c.out - s < MIN_CLIP) { vStatus("Move the playhead a little away from the edge of the clip to split it."); return; }
  const before = snap();
  V.clips.splice(L.i, 1, { ...c, id: V.nextId++, out: s }, { ...c, id: V.nextId++, in: s, trans: null });
  V.sel = L.i + 1; V.selJoin = -1;
  commit(before);
  vStatus("Split. Select a piece and press Delete to remove it.");
}
function deleteSelected() {
  if (V.sel < 0 || !V.clips[V.sel] || V.exporting) return;
  const before = snap(), at = clipItem(vplan(), V.sel).start;
  V.clips.splice(V.sel, 1);
  V.T = Math.max(0, at);
  commit(before);
  vStatus(V.clips.length ? "Removed. Press Ctrl+Z to bring it back." : "Removed the last clip. Press Ctrl+Z to bring it back.");
}
function setTrans(ci, tr) {
  const before = snap();
  V.clips[ci] = { ...V.clips[ci], trans: tr.type === "cut" ? null : tr };
  commit(before);
}

/* ---------- Preview ----------
   A clock runs the timeline; two hidden video players follow it (one per
   clip on screen, or parked on the next clip), and each frame is drawn onto a
   canvas with the same code the export uses. */
const vA = $("#vA"), vB = $("#vB"), els = [vA, vB];
const pv = { cv: $("#vCanvas"), box: $("#vPrevBox"), W: 1280, H: 720, clock: null, map: new Map() };
let mus = null;
function sizePreview() {
  const [W, H] = outSize(), stage = $(".vstage"), ar = W / H;
  pv.W = W; pv.H = H;
  const maxW = stage.clientWidth || 640, maxH = Math.max(220, window.innerHeight * 0.56);
  const w = Math.min(maxW, maxH * ar), h = w / ar, dpr = window.devicePixelRatio || 1;
  pv.box.style.width = Math.round(w) + "px"; pv.box.style.height = Math.round(h) + "px";
  const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
  if (pv.cv.width !== cw || pv.cv.height !== ch) { pv.cv.width = cw; pv.cv.height = ch; }
}
const nowT = () => V.playing && pv.clock ? pv.clock.T + (performance.now() - pv.clock.perf) / 1000 : V.T;
function vPlay() {
  if (!V.clips.length || V.exporting) return;
  const P = vplan();
  if (V.T >= P.total - 0.02) V.T = 0;
  V.playing = true; pv.clock = { perf: performance.now(), T: V.T };
  musicStart();
  vtick(); updateUi();
}
function vPause() {
  if (!V.playing) return;
  V.T = nowT(); V.playing = false;
  els.forEach(e => e.pause()); musicStop();
  updateUi(); vtick();
}
function vToggle() { V.playing ? vPause() : vPlay(); }
function vSeek(T) {
  const was = V.playing;
  if (was) { V.playing = false; els.forEach(e => e.pause()); musicStop(); }
  V.T = clamp(T, 0, vtotal());
  if (was) vPlay(); else vtick();
}
function stepFrames(n) {
  if (!V.clips.length) return;
  const L = locate(V.T), c = V.clips[Math.max(0, L.i)];
  vPause(); vSeek(V.T + n / (c.src.fps || 30));
}
function musicStart() {
  musicStop();
  if (!V.music) return;
  const c = audio(), s = c.createBufferSource(), g = c.createGain();
  s.buffer = V.music.buffer; s.loop = true; g.gain.value = 0;
  s.connect(g).connect(c.destination);
  s.start(0, V.T % s.buffer.duration);
  mus = { s, g };
}
function musicStop() { if (mus) { try { mus.s.stop(); } catch (e) {} mus = null; } }

// Put the players on the clips the timeline needs at time T.
function syncPlayers(P, T) {
  const want = layersAt(P, T).layers.filter(L => L.it.kind === "clip").map(L => ({ it: L.it, t: L.src, on: true }));
  if (want.length < 2) {
    const next = P.items.find(it => it.kind === "clip" && it.start > T);
    if (next) want.push({ it: next, t: next.c.in, on: false });
  }
  const free = els.filter(e => !want.some(w => w.it.c.id === e.itemId));
  for (const w of want) {
    let e = els.find(x => x.itemId === w.it.c.id);
    if (!e) { e = free.shift(); if (!e) continue; e.itemId = w.it.c.id; }
    w.el = e;
  }
  els.forEach(e => { if (!want.some(w => w.el === e)) { e.itemId = null; if (!e.paused) e.pause(); } });
  pv.map.clear();
  for (const w of want) {
    const e = w.el, c = w.it.c;
    if (!e) continue;
    pv.map.set(w.it.c.id, e);
    if (e.dataset.src !== String(c.src.id)) { e.src = c.src.url; e.dataset.src = c.src.id; }
    const off = Math.abs(e.currentTime - w.t);
    if (w.on && V.playing) {
      e.volume = clamp(gainOf(w.it, T), 0, 1);
      if (off > 0.25 || (e.paused && off > 0.04)) e.currentTime = w.t;
      if (e.paused) e.play().catch(() => {});
    } else {
      if (!e.paused) e.pause();
      if (off > 0.02) e.currentTime = w.t;
    }
  }
}
function vtick() {
  const P = vplan();
  if (V.playing) {
    V.T = nowT();
    if (V.T >= P.total) { V.T = P.total; vPause(); return; }
  }
  $("#vEmpty").hidden = V.clips.length > 0;
  if (!V.clips.length) { const g = pv.cv.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, pv.cv.width, pv.cv.height); return; }
  syncPlayers(P, V.T);
  if (mus) mus.g.gain.setTargetAtTime(musicGain(P, V.T), audio().currentTime, 0.03);
  // draw only when every picture on screen is ready, so seeking never flashes black
  const st = layersAt(P, V.T), imgs = new Map();
  for (const L of st.layers) {
    if (L.it.kind !== "clip") continue;
    const e = pv.map.get(L.it.c.id);
    if (!e || e.readyState < 2 || !e.videoWidth) return;
    imgs.set(L.it, { img: e, w: e.videoWidth, h: e.videoHeight, rot: 0 });   // the player has already turned it upright
  }
  const g = pv.cv.getContext("2d"), k = pv.cv.width / pv.W;
  g.setTransform(k, 0, 0, k, 0, 0);
  compose(g, pv.W, pv.H, st, L => imgs.get(L.it));
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/* ---------- Timeline drawing ---------- */
const tl = { box: $("#vtl"), inner: $("#vtlInner"), cv: $("#vtlCanvas"), pad: 16, h: 156, clipY: 30, clipH: 84, musY: 122, musH: 26, drag: null, col: null };
const fitPps = () => (tl.box.clientWidth - 2 * tl.pad) / Math.max(vtotal(), 1);
// the scale holds still during a drag, so a trimmed edge stays under the pointer
const pps = () => (tl.drag && tl.drag.pps) || fitPps() * V.zoom;
function sizeTimeline() {
  const w = tl.box.clientWidth, dpr = window.devicePixelRatio || 1;
  tl.inner.style.width = Math.max(w, vtotal() * pps() + 2 * tl.pad) + "px";
  tl.inner.style.height = tl.h + "px";
  tl.cv.style.width = w + "px"; tl.cv.style.height = tl.h + "px";
  if (tl.cv.width !== Math.round(w * dpr) || tl.cv.height !== Math.round(tl.h * dpr)) { tl.cv.width = Math.round(w * dpr); tl.cv.height = Math.round(tl.h * dpr); }
}
function readColors() {
  tl.col = { ink: cssVar("--ink"), muted: cssVar("--muted"), line: cssVar("--line"), accent: cssVar("--accent"), surface: cssVar("--surface"),
    sunk: cssVar("--sunk"), gold: cssVar("--gold"), t: [1, 2, 3, 4, 5, 6].map(n => cssVar(`--t${n}`)), body: cssVar("--body"), mono: cssVar("--mono") };
}
const xOf = t => tl.pad + t * pps() - tl.box.scrollLeft;
const tOf = x => (x + tl.box.scrollLeft - tl.pad) / pps();
// Items on the timeline, with a gap while a left edge is dragged so the edge follows the pointer.
function boxes() {
  const P = vplan(), d = tl.drag;
  let shift = 0;
  return P.items.map(it => {
    if (d && d.kind === "trim" && d.edge === "l" && it.ci === d.i) shift = it.c.in - d.orig.in;
    return { it, i: it.ci, t0: it.start + shift, t1: it.end + shift };
  });
}
function niceStep(minSec) {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s >= minSec) return s;
  return 1200;
}
const joinX = b => xOf(b.t0 + b.it.inT.ov / 2);
function drawTimeline() {
  if (!tl.col) readColors();
  const g = tl.cv.getContext("2d"), dpr = window.devicePixelRatio || 1, W = tl.cv.width / dpr, C = tl.col;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, tl.h);
  if (!V.clips.length) return;
  const p = pps(), P = vplan(), total = P.total;
  // ruler
  const step = niceStep(70 / p), first = Math.max(0, Math.floor(tOf(0) / step) * step);
  g.font = `11px ${C.mono || "monospace"}`; g.textBaseline = "middle";
  for (let t = first; t <= total + 1e-6; t += step) {
    const x = xOf(t); if (x > W) break;
    g.fillStyle = C.line; g.fillRect(Math.round(x), 16, 1, 8);
    g.fillStyle = C.muted; g.fillText(fmt(t, step < 1 ? 1 : 0), x + 4, 10);
  }
  // clips and title card
  const d = tl.drag, B = boxes();
  for (const b of B) {
    if (d && d.kind === "move" && d.moved && b.i === d.i) continue;
    if (b.it.kind === "title") drawTitleBox(g, xOf(b.t0), xOf(b.t1));
    else drawClip(g, b.it.c, xOf(b.t0), xOf(b.t1), b.i === V.sel, 1);
  }
  // transition markers between clips
  for (const b of B) {
    if (!b.it.inT || b.it.kind !== "clip" || (d && d.kind === "move" && d.moved)) continue;
    if (B[B.indexOf(b) - 1].it.kind === "title") continue;   // the title card always fades through black
    drawJoin(g, joinX(b), b.it.inT.type, b.i === V.selJoin);
  }
  if (d && d.kind === "move" && d.moved) {
    const c = V.clips[d.i], w = clipLen(c) * p, x0 = d.x - d.grab, ins = insertAt(d);
    const cb = B.filter(b => b.it.kind === "clip");
    const at = ins < cb.length ? xOf(cb[ins].t0) : xOf(total);
    g.fillStyle = C.accent; g.fillRect(Math.round(at) - 1, tl.clipY - 4, 3, tl.clipH + 8);
    drawClip(g, c, x0, x0 + w, true, 0.75);
  }
  // music lane
  if (V.music) drawMusic(g, P, W);
  // playhead
  const x = Math.round(xOf(V.T));
  g.fillStyle = C.accent; g.fillRect(x - 1, 14, 2, tl.h - 14);
  g.beginPath(); g.moveTo(x - 6, 12); g.lineTo(x + 6, 12); g.lineTo(x, 20); g.closePath(); g.fill();
}
function roundBox(g, l, y, w, h, fill, stroke, lw) {
  g.beginPath(); g.roundRect(l, y, w, h, 6);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
}
function drawTitleBox(g, x0, x1) {
  const C = tl.col, l = x0 + 1, w = Math.max(2, x1 - x0 - 2);
  g.save();
  roundBox(g, l, tl.clipY, w, tl.clipH, "#16111B", C.accent, 1);
  g.clip();
  g.fillStyle = "#F2EAF1"; g.font = `600 12px ${C.body || "sans-serif"}`; g.textBaseline = "middle";
  g.fillText("Title card", l + 8, tl.clipY + 14, Math.max(0, w - 16));
  g.fillStyle = "#C9BAC6"; g.font = `12px ${C.body || "sans-serif"}`;
  g.fillText(V.title.text.trim() || "Your title here", l + 8, tl.clipY + 44, Math.max(0, w - 16));
  g.restore();
}
function drawClip(g, c, x0, x1, selected, alpha) {
  const C = tl.col, y = tl.clipY, h = tl.clipH, W = tl.cv.width / (window.devicePixelRatio || 1);
  if (x1 < 0 || x0 > W) return;
  const col = C.t[c.src.color];
  g.save(); g.globalAlpha = alpha;
  const l = x0 + 1, w = Math.max(2, x1 - x0 - 2);
  roundBox(g, l, y, w, h, C.surface);
  g.globalAlpha = alpha * 0.16; g.fillStyle = col; g.fill(); g.globalAlpha = alpha;
  g.lineWidth = selected ? 2.5 : 1; g.strokeStyle = selected ? C.ink : col; g.stroke();
  g.clip();
  // sound waveform, so pauses and mistakes are easy to spot
  const s = c.src, mid = y + 54, amp = 22, p = pps();
  if (s.peaks) {
    g.fillStyle = col;
    for (let px = Math.max(Math.floor(l), 0); px < Math.min(l + w, W); px += 2) {
      const st = c.in + (px - x0) / p, en = st + 2 / p;
      const k0 = Math.floor((st - s.aOff) * PEAKS_PER_SEC), k1 = Math.max(k0 + 1, Math.ceil((en - s.aOff) * PEAKS_PER_SEC));
      let m = 0;
      for (let k = Math.max(0, k0); k < Math.min(k1, s.peaks.length); k++) if (s.peaks[k] > m) m = s.peaks[k];
      const hh = Math.max(1, m * amp);
      g.fillRect(px, mid - hh, 1.5, hh * 2);
    }
  } else {
    g.fillStyle = C.muted; g.font = `12px ${C.body || "sans-serif"}`;
    g.fillText("no sound", l + 8, mid);
  }
  if (w > 40) {
    g.fillStyle = C.ink; g.font = `600 12px ${C.body || "sans-serif"}`; g.textBaseline = "middle";
    g.fillText(`${s.name} · ${fmt(clipLen(c), 1)}`, l + 8, y + 14, Math.max(0, w - 16));
  }
  g.restore();
}
function drawJoin(g, x, type, selected) {
  const C = tl.col, y = tl.clipY + tl.clipH - 15, r = 8;
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
  g.fillStyle = type === "cut" ? C.surface : C.accent; g.fill();
  g.lineWidth = selected ? 2.5 : 1.25; g.strokeStyle = selected ? C.ink : (type === "cut" ? C.muted : C.accent); g.stroke();
}
function drawMusic(g, P, W) {
  const C = tl.col, y = tl.musY, h = tl.musH, x0 = xOf(0), x1 = xOf(P.total);
  g.save();
  roundBox(g, x0 + 1, y, Math.max(2, x1 - x0 - 2), h, C.sunk, C.gold, 1);
  g.clip();
  // the music's level, so the dips under the voice show
  g.fillStyle = C.gold; g.globalAlpha = 0.35;
  for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, x1); px += 2) {
    const lv = musicGain(P, tOf(px)) / Math.max(0.01, V.music.vol);
    const hh = Math.max(1, lv * (h - 8));
    g.fillRect(px, y + h - 4 - hh, 2, hh);
  }
  g.globalAlpha = 1; g.fillStyle = C.ink; g.font = `600 11.5px ${C.body || "sans-serif"}`; g.textBaseline = "middle";
  g.fillText(`♪ ${V.music.name}${V.music.duck ? " · lowered while you talk" : ""}`, Math.max(x0, 0) + 8, y + h / 2, Math.max(0, x1 - x0 - 16));
  g.restore();
}

/* ---------- Timeline pointer: select, scrub, trim, reorder, transitions ---------- */
const EDGE = 7;
function hit(x, y) {
  const B = boxes();
  if (y >= tl.clipY + tl.clipH - 26 && y <= tl.clipY + tl.clipH - 4) {
    for (const b of B) if (b.it.kind === "clip" && b.it.inT && B[B.indexOf(b) - 1].it.kind === "clip" && Math.abs(x - joinX(b)) <= 10) return { join: b.i };
  }
  if (y < tl.clipY || y > tl.clipY + tl.clipH) return null;
  for (const b of B) {
    if (b.it.kind !== "clip") continue;
    const x0 = xOf(b.t0), x1 = xOf(b.t1);
    if (x < x0 - EDGE || x > x1 + EDGE) continue;
    if (Math.abs(x - x0) <= EDGE && x1 - x0 > 3 * EDGE) return { i: b.i, edge: "l" };
    if (Math.abs(x - x1) <= EDGE && x1 - x0 > 3 * EDGE) return { i: b.i, edge: "r" };
  }
  // on top wins where a crossfade overlaps two clips
  for (const b of [...B].reverse()) if (b.it.kind === "clip" && x >= xOf(b.t0) && x <= xOf(b.t1)) return { i: b.i, edge: null };
  return null;
}
function insertAt(d) {
  const t = tOf(d.x - d.grab + clipLen(V.clips[d.i]) * pps() / 2);
  let k = 0;
  for (const b of boxes()) { if (b.it.kind !== "clip" || b.i === d.i) continue; if (t > (b.t0 + b.t1) / 2) k++; }
  return k >= d.i ? k + 1 : k;   // index in the current list, before the dragged clip is taken out
}
tl.cv.addEventListener("pointerdown", e => {
  if (!V.clips.length || V.exporting || e.button !== 0) return;
  const x = e.offsetX, y = e.offsetY, h = hit(x, y);
  tl.cv.setPointerCapture(e.pointerId);
  if (h && h.join != null) {
    V.selJoin = h.join; V.sel = -1;
    showTab("trans"); tl.drag = null;
  } else if (h && h.edge) {
    vPause();
    const c = V.clips[h.i];
    tl.drag = { kind: "trim", i: h.i, edge: h.edge, x0: x, orig: { in: c.in, out: c.out }, before: snap(), pps: pps() };
    V.sel = h.i; V.selJoin = -1;
  } else if (h) {
    V.sel = h.i; V.selJoin = -1;
    const b = boxes().find(b => b.i === h.i);
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
    tl.cv.style.cursor = h ? (h.join != null ? "pointer" : h.edge ? "ew-resize" : "grab") : "pointer";
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
  if (d.edge === "l") c.in = frameSnap(c.src, clamp(d.orig.in + dt, c.src.start, c.out - MIN_CLIP));
  else c.out = frameSnap(c.src, clamp(d.orig.out + dt, c.in + MIN_CLIP, c.src.end));
  V.version++;
  const it = clipItem(vplan(), d.i);
  V.T = d.edge === "l" ? it.start + (it.inT ? it.inT.ov : 0) : it.end - 0.001;
  sizeTimeline(); vtick(); updateUi();
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
      V.clips.splice(k, 0, c); V.sel = k;
      V.T = clipItem(vplan(), k).start;
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
// Decodes one clip in order and hands back the frame showing at a given source time.
// Each reader has its own file window, so two pieces of one video can crossfade without thrashing.
class ClipReader {
  constructor(c) {
    const smp = c.src.vt.samples;
    let first = 0;
    for (let j = 0; j < smp.length; j++) if (smp[j].sync && smp[j].pts <= c.in + 1e-6) first = j;
    Object.assign(this, { c, smp, first, j: first, queue: [], cur: null, err: null, flushing: null, flushed: false, wake: null, read: fileReader(c.src.file) });
    this.dec = new VideoDecoder({ output: f => { this.queue.push(f); this.poke(); }, error: e => { this.err = e; this.poke(); } });
    this.dec.configure(c.src.vt.config);
  }
  poke() { if (this.wake) { this.wake(); this.wake = null; } }
  more() { const sm = this.smp[this.j]; return !!sm && !(this.j > this.first && sm.sync && sm.pts >= this.c.out); }
  async frameAt(t) {
    for (;;) {
      if (this.err) throw this.err;
      while (this.queue.length && this.queue[0].timestamp / 1e6 <= t + 1e-6) { if (this.cur) this.cur.close(); this.cur = this.queue.shift(); }
      if (this.queue.length || this.flushed) return this.cur || this.queue[0] || null;
      if (this.more()) {
        const sm = this.smp[this.j++], data = await this.read(sm.off, sm.size);
        this.dec.decode(new EncodedVideoChunk({ type: sm.sync ? "key" : "delta", timestamp: Math.round(sm.pts * 1e6), data }));
        await roomIn(this.dec, 6);
        await nextTask();   // lets decoded frames arrive
      } else {
        // finish decoding without blocking: hardware decoders only have a few frames to
        // lend, so the frames must keep flowing to the caller while the flush runs
        if (!this.flushing) this.flushing = this.dec.flush().then(() => (this.flushed = true), e => { this.err = e; this.flushed = true; });
        await Promise.race([this.flushing, new Promise(r => (this.wake = r))]);
      }
    }
  }
  close() {
    if (this.cur) this.cur.close();
    this.queue.forEach(f => f.close()); this.queue = [];
    if (this.dec.state !== "closed") this.dec.close();
  }
}
// The finished sound for samples [a, a + n): every clip with its transition
// fades, cut at the same times as the picture, plus the music.
function audioBlock(P, sr, a, n) {
  const L = new Float32Array(n), R = new Float32Array(n), STEP = 16;
  for (const it of P.items) {
    if (it.kind !== "clip" || !it.c.src.audio) continue;
    const s = it.c.src, cS = Math.round(it.start * sr), cE = Math.round(it.end * sr);
    const j0 = Math.max(a, cS), j1 = Math.min(a + n, cE);
    if (j1 <= j0) continue;
    const sl = s.audio.getChannelData(0), sr2 = s.audio.numberOfChannels > 1 ? s.audio.getChannelData(1) : sl;
    const base = Math.round((it.c.in - it.start - s.aOff) * sr);
    let gain = 0;
    for (let j = j0; j < j1; j++) {
      if ((j - j0) % STEP === 0) gain = gainOf(it, (j + STEP / 2) / sr);
      const k = j + base; if (k < 0 || k >= sl.length) continue;
      L[j - a] += sl[k] * gain; R[j - a] += sr2[k] * gain;
    }
  }
  if (V.music) {
    const mb = V.music.buffer, ml = mb.getChannelData(0), mr = mb.numberOfChannels > 1 ? mb.getChannelData(1) : ml, len = ml.length;
    let gain = 0;
    for (let j = a; j < a + n; j++) {
      if ((j - a) % STEP === 0) gain = musicGain(P, (j + STEP / 2) / sr);
      const k = j % len;
      L[j - a] += ml[k] * gain; R[j - a] += mr[k] * gain;
    }
  }
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { data[i] = clamp(L[i], -1, 1); data[n + i] = clamp(R[i], -1, 1); }
  return data;
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
  const readers = new Map();
  try {
    const P = vplan(), [W, H] = outSize(), s0 = V.clips[0].src;
    const fps = [24, 25, 30, 50, 60].reduce((a, b) => Math.abs(b - s0.fps) < Math.abs(a - s0.fps) ? b : a);
    const bitrate = clamp(Math.round(W * H * fps * 0.14), 2e6, 16e6);
    const vcfg = await pickEncoder(W, H, fps, bitrate);
    if (!vcfg) throw new Error("this browser can't make MP4 video at this size. Try Chrome or Edge");
    const sr = audio().sampleRate;
    const acfg = { codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: 2, bitrate: 192000 };
    if (!(await AudioEncoder.isConfigSupported(acfg).then(r => r.supported, () => false))) throw new Error("this browser can't make AAC sound. Try Chrome or Edge");
    if (V.title.on) await Promise.all(["700 40px Figtree", "500 20px Figtree"].map(f => document.fonts.load(f).catch(() => {})));

    const target = writable ? new Mp4Muxer.FileSystemWritableFileStreamTarget(writable) : new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({ target, video: { codec: "avc", width: W, height: H, frameRate: fps }, audio: { codec: "aac", numberOfChannels: 2, sampleRate: sr },
      fastStart: writable ? false : "in-memory", firstTimestampBehavior: "offset" });
    let err = null;
    venc = new VideoEncoder({ output: (ch, m) => muxer.addVideoChunk(ch, m), error: e => (err = e) }); venc.configure(vcfg);
    aenc = new AudioEncoder({ output: (ch, m) => muxer.addAudioChunk(ch, m), error: e => (err = e) }); aenc.configure(acfg);

    const frames = Math.max(1, Math.round(P.total * fps)), AS = Math.round(P.total * sr);
    const cv = new OffscreenCanvas(W, H), g = cv.getContext("2d");
    let ap = 0;
    const feedAudio = upTo => {
      while (ap < upTo) {
        const n = Math.min(Math.round(sr / 2), upTo - ap);
        const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(ap / sr * 1e6), data: audioBlock(P, sr, ap, n) });
        aenc.encode(ad); ad.close(); ap += n;
      }
    };
    const t0 = performance.now();
    note.textContent = "Exporting…";
    for (let k = 0; k < frames; k++) {
      if (V.cancel) throw new Error("cancelled");
      const t = k / fps + 0.0005, st = layersAt(P, t), imgs = new Map();
      for (const [it, r] of readers) if (it.end <= t) { r.close(); readers.delete(it); }
      for (const L of st.layers) {
        if (L.it.kind !== "clip") continue;
        let r = readers.get(L.it);
        if (!r) { r = new ClipReader(L.it.c); readers.set(L.it, r); }
        const f = await r.frameAt(L.src);
        if (f) imgs.set(L.it, { img: f, w: f.displayWidth, h: f.displayHeight, rot: L.it.c.src.rot });
      }
      compose(g, W, H, st, L => imgs.get(L.it));
      const vf = new VideoFrame(cv, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(vf, { keyFrame: k % (fps * 2) === 0 }); vf.close();
      feedAudio(Math.min(AS, Math.round(((k + 1) / fps + 0.5) * sr)));
      await roomIn(venc, 4); await roomIn(aenc, 20);
      if (err) throw err;
      if ((k + 1) % 10 === 0) {
        prog.value = (k + 1) / frames;
        const el = (performance.now() - t0) / 1000;
        note.textContent = `Exporting… about ${fmt(el / (k + 1) * (frames - k - 1), 0)} left. Keep this tab open.`;
        await nextTask();
      }
    }
    feedAudio(AS);
    await venc.flush(); await aenc.flush();
    if (err) throw err;
    venc.close(); aenc.close(); venc = aenc = null;
    muxer.finalize();
    prog.value = 1;
    if (writable) { await writable.close(); writable = null; toast(`Saved ${name}`); }
    else await saveFile(new Blob([target.buffer], { type: "video/mp4" }), name);
    vStatus(`Exported ${name}: ${W}×${H}, ${fps} fps, ${fmt(P.total, 0)} long.`);
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch (_) {} }
    if (e && e.message === "cancelled") vStatus("Export cancelled.");
    else vStatus("Export failed: " + ((e && e.message) || e), true);
  } finally {
    readers.forEach(r => r.close());
    try { if (venc && venc.state !== "closed") venc.close(); } catch (_) {}
    try { if (aenc && aenc.state !== "closed") aenc.close(); } catch (_) {}
    V.exporting = false; V.cancel = false;
    prog.hidden = true; note.textContent = "Exports at your video's own size, up to 1080p.";
    updateUi();
  }
}

/* ---------- Adding videos and music ---------- */
async function addVideos(files) {
  files = [...files].filter(f => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name));
  if (!files.length) { vStatus("Add MP4 or MOV videos.", true); return; }
  if (V.exporting) { vStatus("Wait for the export to finish first.", true); return; }
  vPause();
  const before = snap(), failed = [], added = [];
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    vStatus(`Reading ${f.name} (${n + 1} of ${files.length})…`);
    await sleep(0);
    try {
      const s = await openSource(f);
      V.sources.push(s); added.push(s);
      V.clips.push({ id: V.nextId++, src: s, in: s.start, out: s.end, trans: null });
      if (!$("#vName").value.trim()) $("#vName").value = s.name;
    } catch (e) { failed.push(`${f.name}: ${(e && e.message) || "it couldn't be read"}`); }
  }
  if (added.length) {
    if (V.sel < 0) V.sel = 0;
    commit(before);
    requestAnimationFrame(() => { sizeTimeline(); sizePreview(); vtick(); });
  }
  const msg = (added.length ? `Added ${added.length} video${added.length > 1 ? "s" : ""}. ` : "") + (failed.length ? `Couldn't open ${failed.join("; ")}.` : "");
  vStatus(msg.trim(), failed.length > 0);
  const silent = added.filter(s => s.noSound);
  if (silent.length) toast(`${silent.map(s => s.name).join(", ")} has no sound Hookd can read, so it will be silent.`);
}
async function addMusic(file) {
  if (!file) return;
  vPause();
  vStatus(`Reading ${file.name}…`);
  try {
    const buffer = await decodeFile(audio(), file);
    V.music = { name: cleanName(file.name), buffer, vol: +$("#vMusicVol").value / 100, duck: $("#vDuck").checked };
    vStatus(`Added music: ${V.music.name}.`);
  } catch (e) {
    vStatus(`Couldn't read ${file.name}${e && e.why ? ": " + e.why : ". Try an MP3 or M4A file"}.`, true);
  }
  settingsChanged();
}

/* ---------- UI ---------- */
function vStatus(msg, err) { const s = $("#vStatus"); s.textContent = msg; s.classList.toggle("err", !!err); }
function showTab(name) {
  document.querySelectorAll("#vTabs [data-tab]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tab === name));
  document.querySelectorAll(".vtab").forEach(p => (p.hidden = p.dataset.panel !== name));
  updateUi();
}
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
  // transitions
  const j = V.selJoin, c = V.clips[j], tr = c && c.trans;
  $("#vTransEdit").hidden = !c || j < 1;
  $("#vTransHelp").hidden = !!c && j >= 1;
  if (c && j >= 1) {
    $("#vTransType").value = tr ? tr.type : "cut";
    $("#vTransDur").value = String(tr ? tr.dur : 0.6);
    $("#vTransDur").disabled = !tr;
    $("#vTransWhich").textContent = `Between clip ${j} and clip ${j + 1}`;
  }
  $("#vTransAll").disabled = V.clips.length < 2 || busy;
  // music
  $("#vMusicSet").hidden = !V.music;
  $("#vMusicAdd").textContent = V.music ? "Change music" : "Add music";
  if (V.music) $("#vMusicName").textContent = V.music.name;
  // shape
  document.querySelectorAll("#vShapes [data-shape]").forEach(b => b.setAttribute("aria-pressed", b.dataset.shape === V.shape));
  document.querySelectorAll("#vFitSeg [data-fit]").forEach(b => b.setAttribute("aria-pressed", b.dataset.fit === V.fit));
  const [W, H] = outSize();
  $("#vShapeOut").textContent = has ? `Exports at ${W}×${H}.` : "";
  if (!busy) $("#vNote").textContent = has ? `Exports an MP4 at ${W}×${H}.` : "Exports at your video's own size, up to 1080p.";
  ["#vTitleText", "#vTitleSub", "#vTitleDur"].forEach(s => ($(s).disabled = !V.title.on));
}
let vRaf = 0;
function vLoop() {
  vtick();
  if (V.playing) {   // keep the playhead in view
    const x = xOf(V.T), w = tl.box.clientWidth;
    if (x > w - 40 || x < 0) tl.box.scrollLeft += x - 60;
  }
  drawTimeline();
  $("#vTime").textContent = `${fmt(V.T, 1)} / ${fmt(vtotal(), 1)}`;
  vRaf = requestAnimationFrame(vLoop);
}
// Called by setMode in app.js.
function videoShown(on) {
  cancelAnimationFrame(vRaf);
  if (!on) { vPause(); return; }
  readColors();
  requestAnimationFrame(() => { sizeTimeline(); sizePreview(); vtick(); updateUi(); vLoop(); });
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
$("#vTabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
// transitions
function transFromForm() { const type = $("#vTransType").value; return { type, dur: +$("#vTransDur").value }; }
$("#vTransType").addEventListener("change", () => { if (V.selJoin >= 1) setTrans(V.selJoin, transFromForm()); });
$("#vTransDur").addEventListener("change", () => { if (V.selJoin >= 1) setTrans(V.selJoin, transFromForm()); });
$("#vTransAll").addEventListener("click", () => {
  const tr = V.selJoin >= 1 ? transFromForm() : { type: "crossfade", dur: 0.6 }, before = snap();
  V.clips = V.clips.map((c, i) => i ? { ...c, trans: tr.type === "cut" ? null : tr } : c);
  commit(before);
  vStatus(`${TRANS[tr.type]} on every cut.`);
});
// music
$("#vMusicAdd").addEventListener("click", () => $("#vMusicIn").click());
$("#vMusicIn").addEventListener("change", e => { addMusic(e.target.files[0]); e.target.value = ""; });
$("#vMusicDel").addEventListener("click", () => { vPause(); V.music = null; settingsChanged(); vStatus("Removed the music."); });
$("#vMusicVol").addEventListener("input", e => { if (V.music) { V.music.vol = e.target.value / 100; V.version++; } });
$("#vDuck").addEventListener("change", e => { if (V.music) { V.music.duck = e.target.checked; V.version++; } });
// title card
$("#vTitleOn").addEventListener("change", e => { V.title.on = e.target.checked; settingsChanged(); if (V.title.on) vSeek(0); });
$("#vTitleText").addEventListener("input", e => { V.title.text = e.target.value; vtick(); });
$("#vTitleSub").addEventListener("input", e => { V.title.sub = e.target.value; vtick(); });
$("#vTitleDur").addEventListener("change", e => { V.title.dur = +e.target.value; settingsChanged(); });
// shape
$("#vShapes").addEventListener("click", e => { const b = e.target.closest("[data-shape]"); if (b) { V.shape = b.dataset.shape; settingsChanged(); } });
$("#vFitSeg").addEventListener("click", e => { const b = e.target.closest("[data-fit]"); if (b) { V.fit = b.dataset.fit; settingsChanged(); } });
// backup for when the page isn't drawing (another tab in front): still honour the cuts
els.forEach(el => el.addEventListener("timeupdate", () => { if (V.playing && document.hidden) vtick(); }));
els.forEach(el => el.addEventListener("error", () => {
  if (el.dataset.src) vStatus("This browser can't play one of the videos in the preview. Export may still work.", true);
}));
new ResizeObserver(() => { if (state.mode === "video") { sizeTimeline(); sizePreview(); vtick(); } }).observe($(".vstage"));
window.addEventListener("resize", () => { if (state.mode === "video") { sizePreview(); vtick(); } });
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
  else if (k === "End") { e.preventDefault(); vSeek(vtotal()); }
});
window.addEventListener("beforeunload", e => { if (V.exporting || V.clips.length) { e.preventDefault(); e.returnValue = ""; } });
updateUi();
