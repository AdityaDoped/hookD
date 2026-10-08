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
  // style "card" plays before the video; "cover" lays a poster over the opening seconds
  title: { on: false, text: "", sub: "", dur: 3, style: "card" },
  cover: null,   // { name, bmp }: the picture on a cover title
  banner: { on: false, text: "", dur: 5 },   // dur 0 = the whole video
  shape: "original", fit: "fit",
  music: null,   // { name, buffer, vol, duck }
  // captions live in source time ({ id, src, s, e, text }), so cuts and moves carry them along
  caps: [], selCap: null, capLook: { style: "bar", size: "m", pos: "bottom", burn: true },
  // chapter headings, also in source time: { id, src, s, text, sub, icon, card, hold }
  chapters: [],
  look: null,    // colours and font of titles, banner, chapters and highlight captions (set below)
  // voice and colour tools, all off until chosen
  enh: { noise: 0, level: false, bright: 0, contrast: 0, sat: 0, warm: 0 },
};
// Ready-made looks; every colour and the font can be changed afterwards.
const THEMES = {
  playbook: { name: "Playbook", bg: "#FBF7EA", ink: "#1F1F1F", accent: "#2F6DB5", hiBox: "#D9FF3F", hiInk: "#111111", font: "lato", caps: true },
  midnight: { name: "Midnight", bg: "#16111B", ink: "#F2EAF1", accent: "#FF5C9A", hiBox: "#FF5C9A", hiInk: "#FFFFFF", font: "figtree", caps: false },
  sunny: { name: "Sunny", bg: "#FFD84D", ink: "#1A1A1A", accent: "#1A1A1A", hiBox: "#1A1A1A", hiInk: "#FFD84D", font: "poppins", caps: true },
  clean: { name: "Clean", bg: "#FFFFFF", ink: "#111827", accent: "#2563EB", hiBox: "#FFFFFF", hiInk: "#111827", font: "figtree", caps: false },
};
const FONTS = { lato: "Lato", figtree: "Figtree", poppins: "Poppins", serif: "Playfair Display" };
const lookOf = id => { const { name, ...l } = THEMES[id]; return { theme: id, ...l }; };
V.look = lookOf("midnight");   // matches the title card from before themes existed
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
const TRANS = { cut: "Cut", crossfade: "Crossfade", black: "Fade through black", zoom: "Quick zoom", panels: "Slide in panels" };
const OVERLAP = { crossfade: true, panels: true };   // the next clip arrives over the last one
const MICRO = 0.006;    // tiny fade at every cut so the sound never clicks
const TITLE_TRANS = { type: "black", dur: 0.8 };
const titleCard = () => V.title.on && V.title.style !== "cover";
function vplan() {
  const items = [];
  if (titleCard()) items.push({ kind: "title", len: V.title.dur, ci: -1 });
  V.clips.forEach((c, ci) => items.push({ kind: "clip", c, ci, len: clipLen(c) }));
  let t = 0;
  items.forEach((it, i) => {
    const prev = items[i - 1];
    const tr = !prev ? null : prev.kind === "title" ? TITLE_TRANS : (it.c.trans || null);
    const type = tr ? tr.type : "cut", dur = tr ? tr.dur : 0;
    const ov = prev && OVERLAP[type] ? Math.min(dur, prev.len / 2, it.len / 2) : 0;
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
    let alpha = 1, scale = 1, panels = null;
    if (I && I.ov && a < I.ov) { if (I.type === "panels") panels = a / I.ov; else alpha = a / I.ov; }
    if (I && I.type === "black" && a < I.h) black = Math.max(black, 1 - a / I.h);
    if (O && O.type === "black" && b < O.h) black = Math.max(black, 1 - b / O.h);
    if (I && I.type === "zoom" && a < I.h) { const p = 1 - a / I.h; scale *= 1 + 0.35 * p * p; }
    if (O && O.type === "zoom" && b < O.h) { const p = 1 - b / O.h; scale *= 1 + 0.35 * p * p; }
    layers.push({ it, alpha, scale, panels, src: it.kind === "clip" ? clamp(it.c.in + a, it.c.in, it.c.out - 0.001) : 0 });
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

/* ---------- Captions ---------- */
// Where each caption shows on the timeline: every clip shows the captions of its own
// stretch of video, trimmed at the clip's edges.
let capCache = { key: "", list: [] };
function capsOnTimeline(P) {
  if (capCache.key === String(V.version)) return capCache.list;
  const list = [];
  for (const it of P.items) {
    if (it.kind !== "clip") continue;
    for (const cap of V.caps) {
      if (cap.src !== it.c.src || cap.e <= it.c.in || cap.s >= it.c.out) continue;
      list.push({ cap, it, t0: it.start + Math.max(cap.s, it.c.in) - it.c.in, t1: it.start + Math.min(cap.e, it.c.out) - it.c.in });
    }
  }
  list.sort((a, b) => a.t0 - b.t0);
  capCache = { key: String(V.version), list };
  return list;
}
function capAt(P, t) {
  let hitCap = null;
  for (const x of capsOnTimeline(P)) { if (x.t0 > t) break; if (t < x.t1 && x.cap.text.trim()) hitCap = x; }
  return hitCap;
}
/* ---------- Chapters ----------
   A chapter starts at a moment in a video (so cuts carry it along, like captions):
   an optional full-screen card for `card` seconds, then its heading stays pinned to
   the top for `hold` more. The sound carries on underneath, so lip sync is untouched. */
const ICONS = { chart: "Rising chart", bulb: "Light bulb", list: "Checklist", target: "Target", star: "Star", chat: "Speech bubble", none: "No picture" };
let chapCache = { key: "", list: [] };
function chaptersOnTimeline(P) {
  if (chapCache.key === String(V.version)) return chapCache.list;
  const list = [];
  for (const it of P.items) {
    if (it.kind !== "clip") continue;
    for (const ch of V.chapters) {
      if (ch.src !== it.c.src || ch.s < it.c.in || ch.s >= it.c.out) continue;
      const t0 = it.start + ch.s - it.c.in;
      list.push({ ch, t0, t1: Math.min(P.total, t0 + ch.card + ch.hold) });
    }
  }
  list.sort((a, b) => a.t0 - b.t0);
  // a heading gives way when the next chapter starts
  list.forEach((x, i) => { if (list[i + 1]) x.t1 = Math.min(x.t1, list[i + 1].t0); });
  chapCache = { key: String(V.version), list };
  return list;
}
function chapterAt(P, t) {
  let hitCh = null;
  for (const x of chaptersOnTimeline(P)) { if (x.t0 > t) break; if (t < x.t1) hitCh = x; }
  return hitCh;
}
// When the series banner shows: from the start of the video, after a title card or cover.
function bannerSpan(P) {
  if (!V.banner.on || !V.banner.text.trim() || !P.items.length) return null;
  const first = P.items.find(it => it.kind === "clip");
  if (!first) return null;
  let t0 = first.start + (first.inT ? first.inT.ov + first.inT.h : 0);
  if (V.title.on && V.title.style === "cover") t0 = Math.max(t0, V.title.dur);
  return { t0, t1: V.banner.dur ? Math.min(P.total, t0 + V.banner.dur) : P.total };
}

// Long lines from speech recognition become several short captions, timed by length.
const CAP_MAX = 64;   // characters: about two lines on a phone
function splitCaption(s, e, text) {
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return [];
  // whole sentences together where they fit; a long sentence splits into even pieces
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g).map(x => x.trim()).filter(Boolean), parts = [];
  let cur = "";
  for (const snt of sentences) {
    if (snt.length > CAP_MAX) { if (cur) parts.push(cur); cur = ""; parts.push(...evenSplit(snt)); continue; }
    if (cur && (cur + " " + snt).length > CAP_MAX) { parts.push(cur); cur = snt; } else cur = cur ? cur + " " + snt : snt;
  }
  if (cur) parts.push(cur);
  const total = parts.reduce((a, p) => a + p.length + 4, 0);
  let t = s;
  return parts.map(p => { const d = (e - s) * (p.length + 4) / total, out = { s: t, e: t + d, text: p }; t += d; return out; });
}
// A long sentence in pieces of similar length, breaking after a comma when one is close.
function evenSplit(text) {
  const words = text.split(" "), n = Math.ceil(text.length / CAP_MAX), target = text.length / n, out = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    const full = next.length > CAP_MAX || (out.length < n - 1 && next.length > target * 1.1) || (cur.length >= target * 0.7 && /,$/.test(cur));
    if (cur && full) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}
// Each word's share of the caption's time, by length; the bold style lights up the word being said.
function wordTimes(cap) {
  const words = cap.text.trim().split(/\s+/), weight = words.map(w => w.length + 2), sum = weight.reduce((a, b) => a + b, 0);
  let t = cap.s;
  return words.map((w, i) => { const d = (cap.e - cap.s) * weight[i] / sum, out = { w, s: t, e: t + d }; t += d; return out; });
}
const CAP_SIZE = { bar: { s: 0.04, m: 0.05, l: 0.062 }, bold: { s: 0.062, m: 0.078, l: 0.095 }, box: { s: 0.036, m: 0.045, l: 0.056 } };
function drawCaption(g, W, H, x, t) {
  const L = V.capLook, u = Math.min(W, H), fs = Math.round(u * CAP_SIZE[L.style][L.size]);
  const cy = L.pos === "middle" ? H * 0.55 : H * (H > W ? 0.76 : 0.84);
  g.save(); g.globalAlpha = 1; g.textAlign = "center"; g.textBaseline = "middle";
  if (L.style === "box") {
    // each line on its own highlight, the word being said underlined
    const k = V.look, st = x.it.c.in + (t - x.it.start), words = wordTimes(x.cap);
    let cur = words.findIndex(w => st < w.e); if (cur < 0) cur = words.length - 1;
    g.font = `700 ${fs}px ${fontStack(k.font)}`;
    const space = g.measureText(" ").width, widths = words.map(w => g.measureText(w.w).width), rows = [[]];
    let rw = 0;
    words.forEach((w, i) => { if (rows.at(-1).length && rw + space + widths[i] > W * 0.84) { rows.push([]); rw = 0; } rows.at(-1).push(i); rw += (rows.at(-1).length > 1 ? space : 0) + widths[i]; });
    const lh = fs * 1.32, padX = fs * 0.3, boxH = fs * 1.28;
    g.textAlign = "left";
    rows.forEach((row, r) => {
      const total = row.reduce((a, i) => a + widths[i], 0) + space * (row.length - 1), yy = cy - (rows.length - 1) * lh / 2 + r * lh;
      let xx = W / 2 - total / 2;
      g.fillStyle = k.hiBox; g.fillRect(xx - padX, yy - boxH / 2, total + padX * 2, boxH);
      g.fillStyle = k.hiInk;
      for (const i of row) {
        g.fillText(words[i].w, xx, yy);
        if (i === cur) g.fillRect(xx, yy + fs * 0.5, widths[i], Math.max(1.5, fs * 0.08));
        xx += widths[i] + space;
      }
    });
  } else if (L.style === "bar") {
    g.font = `600 ${fs}px Figtree, system-ui, sans-serif`;
    const lines = wrapLines(g, x.cap.text.trim(), W * 0.84), lh = fs * 1.3, pad = fs * 0.45;
    const w = Math.max(...lines.map(l => g.measureText(l).width)) + pad * 2, h = lines.length * lh + pad * 0.8;
    g.fillStyle = "rgba(0,0,0,.62)";
    g.beginPath(); g.roundRect(W / 2 - w / 2, cy - h / 2, w, h, fs * 0.3); g.fill();
    g.fillStyle = "#FFFFFF";
    lines.forEach((l, i) => g.fillText(l, W / 2, cy - (lines.length - 1) * lh / 2 + i * lh));
  } else {
    // a few words at a time, the one being said in gold
    const st = x.it.c.in + (t - x.it.start), words = wordTimes(x.cap);
    let k = words.findIndex(w => st < w.e); if (k < 0) k = words.length - 1;
    const groups = [];
    let cur = [];
    words.forEach((w, i) => { if (cur.length && (cur.length >= 4 || cur.reduce((a, j) => a + words[j].w.length + 1, 0) + w.w.length > 22)) { groups.push(cur); cur = []; } cur.push(i); });
    if (cur.length) groups.push(cur);
    const grp = groups.find(gp => gp.includes(k)) || groups[0];
    g.font = `800 ${fs}px Figtree, system-ui, sans-serif`;
    g.lineJoin = "round"; g.lineWidth = fs * 0.18; g.strokeStyle = "rgba(0,0,0,.9)";
    const space = g.measureText(" ").width, widths = grp.map(i => g.measureText(words[i].w).width);
    // wrap the group if it is wider than the frame
    const rows = [[]];
    let rw = 0;
    grp.forEach((i, n) => { const ww = widths[n]; if (rows.at(-1).length && rw + space + ww > W * 0.88) { rows.push([]); rw = 0; } rows.at(-1).push(n); rw += (rw ? space : 0) + ww; });
    const lh = fs * 1.15;
    rows.forEach((row, r) => {
      const total = row.reduce((a, n) => a + widths[n], 0) + space * (row.length - 1);
      let xx = W / 2 - total / 2;
      const yy = cy - (rows.length - 1) * lh / 2 + r * lh;
      g.textAlign = "left";
      for (const n of row) {
        const i = grp.at(n), w = words[i].w;
        g.strokeText(w, xx, yy);
        g.fillStyle = i === k ? "#FFC24A" : "#FFFFFF";
        g.fillText(w, xx, yy);
        xx += widths[n] + space;
      }
    });
  }
  g.restore();
}
const srtTime = t => {
  const ms = Math.max(0, Math.round(t * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
function captionsSrt(P) {
  return capsOnTimeline(P).filter(x => x.cap.text.trim())
    .map((x, i) => `${i + 1}\n${srtTime(x.t0)} --> ${srtTime(x.t1)}\n${x.cap.text.trim()}\n`).join("\n");
}
// SRT or WebVTT cues, in the edited video's time.
function parseSubs(text) {
  const out = [], re = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const sec = (h, m, s, ms) => (+h || 0) * 3600 + +m * 60 + +s + +ms.padEnd(3, "0") / 1000;
  for (const m of text.replace(/\r/g, "").matchAll(re)) {
    const body = m[9].replace(/<[^>]+>/g, "").trim();
    if (body) out.push({ t0: sec(m[1], m[2], m[3], m[4]), t1: sec(m[5], m[6], m[7], m[8]), text: body.replace(/\n+/g, " ") });
  }
  return out;
}

/* ---------- Voice cleanup ----------
   Optional, and only when chosen: noise reduction and even loudness. Each video's
   sound is processed once into a copy that both the preview and the export use. */
const TARGET_LUFS = -14;   // what phone feeds play at
const NOISE = { 1: { over: 1.3, floor: 0.35 }, 2: { over: 1.8, floor: 0.18 }, 3: { over: 2.4, floor: 0.08 } };
const enhKey = () => `${V.enh.noise}:${V.enh.level ? 1 : 0}`;
const voiceBuffer = s => (s.proc && s.procKey === enhKey() ? s.proc : s.audio);

// In-place complex FFT of size N (a power of two).
function makeFFT(N) {
  const rev = new Uint32Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2), bits = Math.log2(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
  return (re, im, inverse) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, c = cos[k], s = sin[k] * sg;
          const tr = re[b] * c + im[b] * s, ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  };
}
// A biquad filter (RBJ cookbook) that keeps its state between calls.
function biquad(type, f0, sr, Q, gainDb = 0) {
  const w = 2 * Math.PI * f0 / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Q), A = Math.pow(10, gainDb / 40), sa = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  if (type === "highpass") { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
  else { b0 = A * ((A + 1) + (A - 1) * cw + sa); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sa);
    a0 = (A + 1) - (A - 1) * cw + sa; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sa; }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x, out = x) => {
    for (let i = 0; i < x.length; i++) {
      const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y; out[i] = y;
    }
    return out;
  };
}
// Integrated loudness in LUFS (ITU-R BS.1770: K-weighting, 400 ms blocks, gated).
function loudness(chs, sr) {
  const seg = Math.round(sr * 0.1), nSeg = Math.floor(chs[0].length / seg), segE = new Float64Array(nSeg), tmp = new Float32Array(seg);
  for (const x of chs) {
    const shelf = biquad("highshelf", 1681.97, sr, 0.7071752, 3.99984), hp = biquad("highpass", 38.13547, sr, 0.500327);
    for (let k = 0; k < nSeg; k++) {
      tmp.set(x.subarray(k * seg, k * seg + seg)); shelf(tmp); hp(tmp);
      let e = 0; for (let i = 0; i < seg; i++) e += tmp[i] * tmp[i];
      segE[k] += e / seg;
    }
  }
  const blocks = [];
  for (let k = 0; k + 4 <= nSeg; k++) blocks.push((segE[k] + segE[k + 1] + segE[k + 2] + segE[k + 3]) / 4);
  const lk = e => -0.691 + 10 * Math.log10(e);
  const abs = blocks.filter(e => lk(e) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10, gated = abs.filter(e => lk(e) > rel);
  return lk(gated.reduce((a, b) => a + b, 0) / gated.length);
}
// Spectral noise reduction: learn the hiss from the quietest 15% of moments, then
// turn each frequency down by how close it is to that hiss. Works in place.
async function denoise(chs, opt, onProg) {
  const N = 1024, H = 256, n = chs[0].length, C = chs.length, fft = makeFFT(N), bins = N / 2 + 1;
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const at = (x, p) => (p >= 0 && p < n ? x[p] : 0);
  const mid = p => { let v = 0; for (const x of chs) v += at(x, p); return v / C; };
  const first = -(N / H - 1), last = Math.ceil(n / H), re = new Float64Array(N), im = new Float64Array(N);
  // 1. the noise: average spectrum of the quietest frames
  const energy = [];
  for (let f = 0; f < Math.floor((n - N) / H); f++) { let e = 0; for (let i = 0; i < N; i += 4) { const v = mid(f * H + i); e += v * v; } energy.push([e, f]); }
  if (energy.length < 8) return;
  energy.sort((a, b) => a[0] - b[0]);
  const quiet = energy.slice(0, Math.max(4, Math.floor(energy.length * 0.15))), noise = new Float64Array(bins);
  for (const [, f] of quiet) {
    for (let i = 0; i < N; i++) { re[i] = mid(f * H + i) * win[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < bins; k++) noise[k] += Math.hypot(re[k], im[k]) / quiet.length;
  }
  // 2. filter every frame, overlap-adding back into the same arrays
  const acc = chs.map(() => new Float64Array(N)), gain = new Float64Array(bins), prev = new Float64Array(bins).fill(1);
  const res = chs.map(() => [new Float64Array(N), new Float64Array(N)]);
  for (let f = first; f <= last; f++) {
    const s = f * H;
    for (let i = 0; i < N; i++) { re[i] = mid(s + i) * win[i]; im[i] = 0; }
    fft(re, im, false);
    for (let k = 0; k < bins; k++) {
      const g = Math.max(opt.floor, 1 - opt.over * noise[k] / (Math.hypot(re[k], im[k]) + 1e-12));
      gain[k] = Math.max(g, prev[k] * 0.6);   // let words fade out instead of chopping them
    }
    for (let k = 0; k < bins; k++) prev[k] = gain[k];
    for (let k = 1; k < bins - 1; k++) gain[k] = (prev[k - 1] + 2 * prev[k] + prev[k + 1]) / 4;   // soften across frequencies
    for (let c = 0; c < C; c++) {
      const [r, m] = res[c], x = chs[c];
      for (let i = 0; i < N; i++) { r[i] = at(x, s + i) * win[i]; m[i] = 0; }
      fft(r, m, false);
      for (let k = 0; k < bins; k++) { r[k] *= gain[k]; m[k] *= gain[k]; if (k && k < N / 2) { r[N - k] = r[k]; m[N - k] = -m[k]; } }
      fft(r, m, true);
      const a = acc[c];
      for (let i = 0; i < N; i++) a[(((s + i) % N) + N) % N] += r[i] * win[i] / 1.5;
      // samples s..s+H are complete now; later frames start beyond them
      for (let p = s; p < s + H; p++) { const slot = ((p % N) + N) % N; if (p >= 0 && p < n) x[p] = a[slot]; a[slot] = 0; }
    }
    if ((f - first) % 2000 === 0) { onProg((f - first) / (last - first)); await nextTask(); }
  }
}
// Gentle compression so quiet and loud words sit closer together (3:1 above the voice's usual level).
function compress(chs, sr, thrDb) {
  const n = chs[0].length, att = Math.exp(-1 / (sr * 0.005)), rel = Math.exp(-1 / (sr * 0.12)), ratio = 3;
  let env = 0;
  for (let i = 0; i < n; i++) {
    let v = 0; for (const x of chs) v = Math.max(v, x[i] * x[i]);
    env = v > env ? att * env + (1 - att) * v : rel * env + (1 - rel) * v;
    const db = 10 * Math.log10(env + 1e-12), over = db - thrDb;
    if (over > 0) { const g = Math.pow(10, -over * (1 - 1 / ratio) / 20); for (const x of chs) x[i] *= g; }
  }
}
// Peak limiter: looks 5 ms ahead so the level eases down before a loud moment.
function limit(chs, sr, ceil) {
  const n = chs[0].length, LA = Math.round(sr * 0.005), ring = new Int32Array(LA + 2);
  const peak = i => { let v = 0; for (const x of chs) v = Math.max(v, Math.abs(x[i])); return v; };
  let head = 0, tail = 0, g = 1;
  const a = 1 - Math.exp(-3 / LA), rel = 1 - Math.exp(-1 / (sr * 0.08)), cap = LA + 2;
  for (let j = 0; j < Math.min(LA, n); j++) { while (tail > head && peak(ring[(tail - 1) % cap]) <= peak(j)) tail--; ring[tail++ % cap] = j; }
  for (let i = 0; i < n; i++) {
    const j = i + LA;   // bring the next sample into the window [i, i + LA]
    if (j < n) { while (tail > head && peak(ring[(tail - 1) % cap]) <= peak(j)) tail--; ring[tail++ % cap] = j; }
    while (ring[head % cap] < i) head++;
    const target = Math.min(1, ceil / Math.max(1e-9, peak(ring[head % cap])));
    g = target < g ? g + (target - g) * a : g + (target - g) * rel;
    for (const x of chs) x[i] = clamp(x[i] * g, -ceil, ceil);
  }
}
async function cleanVoice(buf, enh, onProg) {
  const sr = buf.sampleRate, chs = Array.from({ length: buf.numberOfChannels }, (_, c) => Float32Array.from(buf.getChannelData(c)));
  const before = loudness(chs, sr);
  if (enh.noise) {
    for (const x of chs) biquad("highpass", 80, sr, 0.707)(x);   // rumble from fans, traffic, handling
    await denoise(chs, NOISE[enh.noise], p => onProg(p * (enh.level ? 0.8 : 1)));
  }
  if (enh.level) {
    const L = loudness(chs, sr);
    if (isFinite(L)) {
      compress(chs, sr, L + 4);
      const g = clamp(Math.pow(10, (TARGET_LUFS - loudness(chs, sr)) / 20), 0.1, 40);
      for (const x of chs) for (let i = 0; i < x.length; i++) x[i] *= g;
      limit(chs, sr, Math.pow(10, -1.5 / 20));
    }
  }
  onProg(1);
  const out = new AudioBuffer({ length: buf.length, numberOfChannels: chs.length, sampleRate: sr });
  chs.forEach((x, c) => out.copyToChannel(x, c));
  return { buffer: out, before, after: loudness(chs, sr) };
}
let procJob = 0, procBusy = null;
// Bring every video's processed sound up to date with the chosen settings.
function processVoices() {
  const job = ++procJob;
  procBusy = (async () => {
    const key = enhKey(), prog = $("#vEnhProg"), note = $("#vEnhNote");
    if (key === "0:0") { soundRefresh(); note.textContent = ""; prog.hidden = true; return; }
    const todo = V.sources.filter(s => s.audio && s.procKey !== key && V.clips.some(c => c.src === s));
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i];
      prog.hidden = false;
      const r = await cleanVoice(s.audio, V.enh, p => { prog.value = (i + p) / todo.length; note.textContent = `Working on the sound… ${Math.round((i + p) / todo.length * 100)}%`; });
      if (job !== procJob) return;
      Object.assign(s, { proc: r.buffer, procKey: key, lufsBefore: r.before, lufsAfter: r.after });
    }
    prog.hidden = true;
    const used = V.sources.filter(s => s.proc && s.procKey === key && V.clips.some(c => c.src === s));
    const avg = k => used.reduce((a, s) => a + (isFinite(s[k]) ? s[k] : 0), 0) / Math.max(1, used.length);
    note.textContent = used.length ? (V.enh.level ? `Voice level: ${avg("lufsBefore").toFixed(0)} → ${avg("lufsAfter").toFixed(0)} LUFS.` : "Background noise reduced.") : "";
    soundRefresh();
  })();
  return procBusy;
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
function drawMedia(g, W, H, m, scale, alpha, fill = V.fit === "fill") {
  const turned = m.rot % 180 !== 0, dw = turned ? m.h : m.w, dh = turned ? m.w : m.h;
  if (!dw || !dh) return;
  const fit = Math.min(W / dw, H / dh), cover = Math.max(W / dw, H / dh);
  g.save(); g.globalAlpha = alpha;
  g.filter = colourFilter();
  if (!fill && (dw * fit < W - 2 || dh * fit < H - 2)) {
    // the bars show a blurred, darkened copy of the same picture
    const bw = 72, bh = Math.max(1, Math.round(72 * H / W));
    if (blurCv.width !== bw || blurCv.height !== bh) { blurCv.width = bw; blurCv.height = bh; }
    blurG.filter = canFilter ? "blur(3px)" : "none";
    drawRotated(blurG, m.img, m.w, m.h, m.rot, bw / 2, bh / 2, Math.max(bw / dw, bh / dh) * 1.15);
    g.imageSmoothingQuality = "high";
    g.drawImage(blurCv, 0, 0, W, H);
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, 0, W, H);
  }
  drawRotated(g, m.img, m.w, m.h, m.rot, W / 2, H / 2, (fill ? cover : fit) * scale);
  // warmth: a soft orange (or blue) wash over the picture
  if (V.enh.warm) {
    g.filter = "none"; g.globalCompositeOperation = "soft-light";
    g.globalAlpha = alpha * Math.abs(V.enh.warm) / 50 * 0.55;
    g.fillStyle = V.enh.warm > 0 ? "#FF8A2A" : "#2A8CFF"; g.fillRect(0, 0, W, H);
  }
  g.restore();
}
function colourFilter() {
  const e = V.enh;
  if (!e.bright && !e.contrast && !e.sat) return "none";
  return `brightness(${1 + e.bright / 100}) contrast(${1 + e.contrast / 100}) saturate(${1 + e.sat / 100})`;
}
// Fonts the picture needs, loaded before drawing so export never falls back to another font.
function loadFonts() {
  const fam = `"${FONTS[V.look.font] || "Figtree"}"`;
  return Promise.all([`400 20px ${fam}`, `700 20px ${fam}`, `900 20px ${fam}`, "500 20px Figtree", "600 20px Figtree", "700 20px Figtree", "800 20px Figtree"]
    .map(f => document.fonts.load(f).catch(() => {})));
}
const fontStack = f =>`"${FONTS[f] || "Figtree"}", Figtree, system-ui, sans-serif`;
const headText = s => (V.look.caps ? s.toUpperCase() : s);
const ease = p => 1 - Math.pow(1 - clamp(p, 0, 1), 3);
// Font size that fits the text in maxW, starting from fs.
function fitFont(g, text, weight, fs, maxW) {
  g.font = `${weight} ${fs}px ${fontStack(V.look.font)}`;
  const w = g.measureText(text).width;
  if (w > maxW) { fs = Math.max(8, Math.floor(fs * maxW / w)); g.font = `${weight} ${fs}px ${fontStack(V.look.font)}`; }
  return fs;
}
// A title in at most three lines (wrapLines keeps three), shrinking the font until all of it fits.
function fitLines(g, text, weight, fs, maxW) {
  for (;;) {
    g.font = `${weight} ${fs}px ${fontStack(V.look.font)}`;
    const lines = wrapLines(g, text, maxW);
    if (lines.join(" ") === text.replace(/\s+/g, " ") || fs <= 10) return { lines, fs };
    fs = Math.floor(fs * 0.9);
  }
}
function drawTitle(g, W, H, alpha) {
  const k = V.look, u = Math.min(W, H), sfs = Math.round(u * 0.042);
  g.save(); g.globalAlpha = alpha;
  g.fillStyle = k.bg; g.fillRect(0, 0, W, H);
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  const { lines, fs } = fitLines(g, headText(V.title.text.trim() || "Your title here"), 700, Math.round(u * 0.085), W * 0.84);
  const lh = fs * 1.15, sub = V.title.sub.trim();
  const blockH = (lines.length - 1) * lh + fs * 0.75 + fs * 0.5 + Math.max(3, u * 0.008) + (sub ? sfs * 1.7 : 0);
  let y = H / 2 - blockH / 2 + fs * 0.75;
  g.fillStyle = k.ink;
  lines.forEach((l, i) => g.fillText(l, W / 2, y + i * lh));
  const barY = y + (lines.length - 1) * lh + fs * 0.5;
  g.fillStyle = k.accent; g.fillRect(W / 2 - u * 0.06, barY, u * 0.12, Math.max(3, u * 0.008));
  if (sub) { g.font = `500 ${sfs}px ${fontStack(k.font)}`; g.fillStyle = k.ink; g.globalAlpha = alpha * 0.75; g.fillText(sub, W / 2, barY + sfs * 1.7); }
  g.restore();
}
// The heading bar across the top: a bold line and an optional lighter one.
// p (0 to 1) wipes it in from the left.
function drawTopBar(g, W, H, line1, line2, p, alpha) {
  const k = V.look, u = Math.min(W, H), two = !!line2;
  const fs1 = Math.round(u * 0.052), fs2 = Math.round(u * 0.048);
  const bh = two ? fs1 * 1.35 + fs2 * 1.35 + u * 0.05 : fs1 * 1.35 + u * 0.06, y = H * (H > W ? 0.045 : 0.05);
  const bw = W * ease(p);
  if (bw < 1) return;
  g.save(); g.globalAlpha = alpha;
  g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = u * 0.045; g.shadowOffsetY = u * 0.012;
  g.fillStyle = k.bg; g.fillRect(0, y, bw, bh);
  g.shadowColor = "transparent";
  g.beginPath(); g.rect(0, y, bw, bh); g.clip();
  g.fillStyle = k.ink; g.textAlign = "center"; g.textBaseline = "middle";
  const a = headText(line1 || "Your heading"), b = two ? headText(line2) : "";
  if (two) {
    fitFont(g, a, 700, fs1, W * 0.88); g.fillText(a, W / 2, y + u * 0.025 + fs1 * 0.68);
    fitFont(g, b, 400, fs2, W * 0.88); g.fillText(b, W / 2, y + u * 0.025 + fs1 * 1.35 + fs2 * 0.68);
  } else { fitFont(g, a, 700, fs1, W * 0.88); g.fillText(a, W / 2, y + bh / 2); }
  g.restore();
}
// Simple pictures for chapter cards, drawn in a box of size s centred at (cx, cy).
function drawIcon(g, name, cx, cy, s, color) {
  if (!name || name === "none") return;
  g.save(); g.translate(cx - s / 2, cy - s / 2); g.scale(s / 100, s / 100);
  g.fillStyle = g.strokeStyle = color; g.lineCap = g.lineJoin = "round";
  if (name === "chart") {
    [[4, 82, 8], [16, 72, 18], [30, 62, 28], [44, 50, 40], [58, 38, 52], [72, 26, 64]].forEach(([x, y]) => g.fillRect(x, y, 10, 92 - y));
    g.fillRect(0, 90, 86, 4);
    g.lineWidth = 5; g.beginPath(); g.moveTo(6, 84); g.quadraticCurveTo(58, 80, 84, 16); g.stroke();
    g.beginPath(); g.moveTo(90, 4); g.lineTo(94, 26); g.lineTo(74, 18); g.closePath(); g.fill();
  } else if (name === "bulb") {
    g.lineWidth = 6;
    g.beginPath(); g.arc(50, 40, 26, Math.PI * 0.8, Math.PI * 2.2); g.lineTo(62, 72); g.lineTo(38, 72); g.closePath(); g.stroke();
    g.fillRect(38, 78, 24, 6); g.fillRect(41, 88, 18, 6);
    [[50, 2, 50, 8], [14, 16, 19, 21], [86, 16, 81, 21], [4, 42, 10, 42], [96, 42, 90, 42]].forEach(([a, b, c, d]) => { g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke(); });
  } else if (name === "list") {
    g.lineWidth = 6;
    [18, 48, 78].forEach(y => {
      g.beginPath(); g.moveTo(6, y); g.lineTo(13, y + 7); g.lineTo(26, y - 8); g.stroke();
      g.fillRect(38, y - 3, 56, 7);
    });
  } else if (name === "target") {
    g.lineWidth = 7;
    [44, 30, 16].forEach(r => { g.beginPath(); g.arc(50, 50, r, 0, Math.PI * 2); g.stroke(); });
    g.beginPath(); g.arc(50, 50, 6, 0, Math.PI * 2); g.fill();
  } else if (name === "star") {
    g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 20 : 46, a = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(50 + r * Math.cos(a), 52 + r * Math.sin(a)); }
    g.closePath(); g.fill();
  } else if (name === "chat") {
    g.beginPath(); g.roundRect(4, 10, 92, 60, 14); g.fill();
    g.beginPath(); g.moveTo(24, 66); g.lineTo(18, 92); g.lineTo(46, 68); g.closePath(); g.fill();
  }
  g.restore();
}
// A chapter at local time a (seconds since it started): the full card, then the pinned heading.
function drawChapter(g, W, H, x, a) {
  const ch = x.ch, len = x.t1 - x.t0, out = clamp((len - a) / 0.3, 0, 1);
  if (a < ch.card) {
    const u = Math.min(W, H), k = V.look, fadeIn = clamp(a / 0.2, 0, 1);
    g.save(); g.globalAlpha = fadeIn * (ch.card - a < 0.15 ? (ch.card - a) / 0.15 : 1);
    g.fillStyle = k.bg; g.fillRect(0, 0, W, H);
    const s = u * (H > W ? 0.5 : 0.36) * (0.85 + 0.15 * ease(a / 0.5));
    drawIcon(g, ch.icon, W / 2, H * (H > W ? 0.56 : 0.6), s, k.accent);
    g.restore();
  }
  drawTopBar(g, W, H, ch.text.trim(), ch.sub.trim(), a / 0.5, out);
}
// The cover title: a poster over the opening seconds, with the video playing in a frame.
// It starts full-screen, shrinks into its frame, and grows back out at the end.
function coverRects(W, H) {
  const tall = H > W, img = !!V.cover;
  if (tall) {
    const fw = W * 0.86, fh = Math.min(fw * 0.82, H * 0.38), fy = img ? H * 0.3 : H * 0.17;
    return { img: img && { x: 0, y: 0, w: W, h: H * 0.27 }, frame: { x: (W - fw) / 2, y: fy, w: fw, h: fh }, text: { x: W * 0.12, y: fy + fh + H * 0.05, w: W * 0.76 } };
  }
  const fw = W * 0.5, fh = fw * 9 / 16;
  return { img: img && { x: W * 0.6, y: 0, w: W * 0.4, h: H * 0.42 }, frame: { x: W * 0.05, y: (H - fh) / 2, w: fw, h: fh }, text: { x: W * 0.6, y: img ? H * 0.5 : H * 0.3, w: W * 0.35 } };
}
function drawCover(g, W, H, a, dur, L, m) {
  const k = V.look, u = Math.min(W, H), R = coverRects(W, H);
  const p = Math.min(ease(a / 0.8), dur > 2 ? ease((dur - a) / 0.6) : 1);   // 0 = full screen, 1 = in its frame
  g.save();
  g.globalAlpha = p; g.fillStyle = k.bg; g.fillRect(0, 0, W, H);
  // a soft circle in the accent colour, like printed stationery
  g.globalAlpha = p * 0.16; g.fillStyle = k.accent;
  g.beginPath(); g.arc(W * 0.95, H * (H > W ? 0.8 : 0.85), u * 0.32, 0, Math.PI * 2); g.fill();
  g.globalAlpha = p;
  if (R.img) {
    const b = V.cover.bmp, r = R.img, sc = Math.max(r.w / b.width, r.h / b.height);
    g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    g.drawImage(b, r.x + (r.w - b.width * sc) / 2, r.y + (r.h - b.height * sc) / 2, b.width * sc, b.height * sc);
    g.restore();
  }
  // title box with an outline, and the second line under the title
  const T = R.text, title = headText(V.title.text.trim() || "Your title here"), sub = V.title.sub.trim();
  const fs0 = Math.round(u * (H > W ? 0.07 : 0.05)), sfs = Math.round(fs0 * 0.62);
  const { lines, fs } = fitLines(g, title, 900, fs0, T.w - fs0), lh = fs * 1.2, boxH = lines.length * lh + fs * 0.9 + (sub ? sfs * 1.6 : 0);
  g.lineWidth = Math.max(1.5, u * 0.004); g.strokeStyle = k.ink; g.strokeRect(T.x, T.y, T.w, boxH);
  g.fillStyle = k.ink; g.textAlign = "center"; g.textBaseline = "middle";
  lines.forEach((l, i) => g.fillText(l, T.x + T.w / 2, T.y + fs * 0.45 + lh * (i + 0.5)));
  if (sub) { g.font = `400 ${sfs}px ${fontStack(k.font)}`; g.globalAlpha = p * 0.8; g.fillText(sub, T.x + T.w / 2, T.y + fs * 0.45 + lh * lines.length + sfs * 0.8); }
  g.restore();
  // the video, moving between full screen and its frame
  const F = R.frame, x = F.x * p, y = F.y * p, w = W + (F.w - W) * p, h = H + (F.h - H) * p;
  if (m) {
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.translate(x, y);
    drawMedia(g, w, h, m, L.scale, 1, p > 0.01 || V.fit === "fill");
    g.restore();
  }
  if (p > 0.01) { g.save(); g.globalAlpha = p; g.lineWidth = Math.max(2, u * 0.007); g.strokeStyle = "#FFFFFF"; g.strokeRect(x, y, w, h); g.restore(); }
}
// The next clip arrives in three bands that slide in from alternate sides.
function drawPanels(g, W, H, m, L) {
  for (let i = 0; i < 3; i++) {
    const q = ease((L.panels - i * 0.15) / 0.7), dx = (1 - q) * W * (i % 2 ? -1 : 1);
    if (q <= 0) continue;
    g.save(); g.beginPath(); g.rect(0, H * i / 3, W, H / 3 + 1); g.clip(); g.translate(dx, 0);
    drawMedia(g, W, H, m, L.scale, 1);
    g.restore();
  }
}
// One output picture. getImg(layer) gives the picture for a clip layer, or null.
function compose(g, W, H, st, getImg) {
  g.globalAlpha = 1; g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  const cover = V.title.on && V.title.style === "cover" && st.t < V.title.dur;
  const top = st.layers.filter(L => L.it.kind === "clip").at(-1);
  for (const L of st.layers) {
    if (L.it.kind === "title") { drawTitle(g, W, H, L.alpha); continue; }
    const m = getImg(L);
    if (cover) { if (L === top) drawCover(g, W, H, st.t, V.title.dur, L, m); }
    else if (!m) continue;
    else if (L.panels != null) drawPanels(g, W, H, m, L);
    else drawMedia(g, W, H, m, L.scale, L.alpha);
  }
  const P = st.P, ch = P && !cover ? chapterAt(P, st.t) : null, bn = P && !cover && !ch ? bannerSpan(P) : null;
  if (ch) drawChapter(g, W, H, ch, st.t - ch.t0);
  else if (bn && st.t >= bn.t0 && st.t < bn.t1) drawTopBar(g, W, H, V.banner.text.trim(), "", (st.t - bn.t0) / 0.5, clamp((bn.t1 - st.t) / 0.3, 0, 1));
  // no captions over a full-screen card
  if (st.cap && !cover && !(ch && st.t - ch.t0 < ch.ch.card)) drawCaption(g, W, H, st.cap, st.t);
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
  sizeTimeline(); sizePreview(); renderCapList(); renderChapList(); vtick(); updateUi(); vSave();
}
// Settings outside the undo history (music, title, shape) just redraw.
function settingsChanged() { V.version++; V.T = clamp(V.T, 0, vtotal()); sizeTimeline(); sizePreview(); renderCapList(); renderChapList(); vtick(); updateUi(); vSave(); }

/* ---------- Editing ---------- */
function splitAtPlayhead() {
  if (!V.clips.length || V.exporting) return;
  const L = locate(V.T), c = V.clips[L.i];
  if (!c) { vStatus("Move the playhead onto a clip to split it."); return; }
  const s = frameSnap(c.src, L.s);
  if (s - c.in < MIN_CLIP || c.out - s < MIN_CLIP) { vStatus("Move the playhead a little away from the edge of the clip to split it."); return; }
  const before = snap();
  V.clips.splice(L.i, 1, { ...c, id: V.nextId++, out: s }, { ...c, id: V.nextId++, in: s, trans: null });
  V.sel = L.i + 1; V.selJoin = -1; V.selCap = null;
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
   The sound is scheduled on the audio clock from the same (cleaned) sound the
   export uses, fades and all. Two silent video players follow that clock (one
   per clip on screen, or parked on the next clip), and each frame is drawn onto
   a canvas with the same code the export uses. */
const vA = $("#vA"), vB = $("#vB"), els = [vA, vB];
const pv = { cv: $("#vCanvas"), box: $("#vPrevBox"), W: 1280, H: 720, map: new Map() };
let pa = null;   // the sound now playing: { nodes, out, t0, T }
function sizePreview() {
  const [W, H] = outSize(), stage = $(".vstage"), ar = W / H;
  pv.W = W; pv.H = H;
  const maxW = stage.clientWidth || 640, maxH = Math.max(220, window.innerHeight * 0.56);
  const w = Math.min(maxW, maxH * ar), h = w / ar, dpr = window.devicePixelRatio || 1;
  pv.box.style.width = Math.round(w) + "px"; pv.box.style.height = Math.round(h) + "px";
  const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
  if (pv.cv.width !== cw || pv.cv.height !== ch) { pv.cv.width = cw; pv.cv.height = ch; }
}
// The moment being heard: the audio clock, less the delay on the way to the speakers.
function nowT() {
  if (!V.playing || !pa) return V.T;
  const c = audio(), lat = c.outputLatency || c.baseLatency || 0;
  return pa.T + Math.max(0, c.currentTime - pa.t0 - lat);
}
function vPlay() {
  if (!V.clips.length || V.exporting) return;
  const P = vplan();
  if (V.T >= P.total - 0.02) V.T = 0;
  V.playing = true;
  soundStart(P, V.T);
  vtick(); updateUi();
}
function vPause() {
  if (!V.playing) return;
  V.T = nowT(); V.playing = false;
  els.forEach(e => e.pause()); soundStop();
  updateUi(); vtick();
}
function vToggle() { V.playing ? vPause() : vPlay(); }
function vSeek(T) {
  const was = V.playing;
  if (was) { V.playing = false; els.forEach(e => e.pause()); soundStop(); }
  V.T = clamp(T, 0, vtotal());
  if (was) vPlay(); else vtick();
}
// Volume curve points every 10 ms, for setValueCurveAtTime.
function curveOf(fn, from, to) {
  const n = Math.max(2, Math.ceil((to - from) * 100) + 1), a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(from + (to - from) * i / (n - 1));
  return a;
}
function soundStart(P, T) {
  soundStop();
  const c = audio(), t0 = c.currentTime + 0.1, out = c.createGain(), nodes = [];
  out.connect(c.destination);
  for (const it of P.items) {
    if (it.kind !== "clip" || it.end <= T) continue;
    const s = it.c.src, buf = voiceBuffer(s);
    if (!buf) continue;
    let from = Math.max(T, it.start), off = it.c.in + (from - it.start) - s.aOff;
    if (off < 0) { from -= off; off = 0; }   // this video's sound starts a moment after its picture
    if (it.end - from < 0.01) continue;
    const src = c.createBufferSource(), g = c.createGain();
    src.buffer = buf; src.connect(g).connect(out);
    g.gain.setValueCurveAtTime(curveOf(t => gainOf(it, t), from, it.end), t0 + from - T, it.end - from);
    src.start(t0 + from - T, off, it.end - from);
    nodes.push(src);
  }
  if (V.music && P.total - T > 0.01) {
    const src = c.createBufferSource(), g = c.createGain();
    src.buffer = V.music.buffer; src.loop = true; src.connect(g).connect(out);
    g.gain.setValueCurveAtTime(curveOf(t => musicGain(P, t), T, P.total), t0, P.total - T);
    src.start(t0, T % src.buffer.duration);
    nodes.push(src);
  }
  pa = { nodes, out, t0, T };
}
function soundStop() {
  if (!pa) return;
  pa.nodes.forEach(n => { try { n.stop(); } catch (e) {} });
  pa.out.disconnect(); pa = null;
}
// Restart the sound from here after its settings change mid-play.
function soundRefresh() { if (V.playing) { V.T = nowT(); soundStart(vplan(), V.T); } }
function stepFrames(n) {
  if (!V.clips.length) return;
  const L = locate(V.T), c = V.clips[Math.max(0, L.i)];
  vPause(); vSeek(V.T + n / (c.src.fps || 30));
}

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
    const drift = e.currentTime - w.t, off = Math.abs(drift);
    e.muted = true;   // the sound comes from the audio clock (see soundStart)
    if (w.on && V.playing) {
      // a player takes a moment to get going, so it starts a little ahead
      if (e.paused) { e.currentTime = Math.min(c.out, w.t + 0.12); e.playbackRate = 1; }
      else if (off > 0.5) { e.currentTime = w.t; e.playbackRate = 1; }
      else e.playbackRate = clamp(1 - drift * 3, 0.8, 1.25);   // ease back into step with the sound
      if (e.paused) e.play().catch(() => {});
    } else {
      if (!e.paused) e.pause();
      e.playbackRate = 1;
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
  // draw only when every picture on screen is ready, so seeking never flashes black
  const st = layersAt(P, V.T), imgs = new Map();
  st.cap = capAt(P, V.T); st.t = V.T; st.P = P;
  markActiveCap(st.cap);
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
const tl = { box: $("#vtl"), inner: $("#vtlInner"), cv: $("#vtlCanvas"), pad: 16, h: 182, clipY: 30, clipH: 84, capY: 119, capH: 24, musY: 149, musH: 26, drag: null, col: null };
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
  // chapter flags along the top of the clips
  if (!(d && d.kind === "move" && d.moved)) {
    g.font = `600 11px ${C.body || "sans-serif"}`; g.textBaseline = "middle";
    for (const x of chaptersOnTimeline(P)) {
      const x0 = xOf(x.t0), x1 = xOf(x.t1);
      if (x1 < 0 || x0 > W) continue;
      const y = tl.clipY + 24, label = x.ch.text.trim() || "Chapter", lw = Math.min(g.measureText(label).width + 10, Math.max(30, x1 - x0));
      g.fillStyle = C.t[3];
      g.fillRect(x0 - 1, tl.clipY + 2, 2, tl.clipH - 4);
      roundBox(g, x0, y, lw, 16, C.t[3]);
      g.save(); g.beginPath(); g.rect(x0, y, lw - 4, 16); g.clip();
      g.fillStyle = C.surface; g.fillText(label, x0 + 5, y + 8); g.restore();
    }
  }
  // captions and music lanes
  drawCapLane(g, P, W);
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
  roundBox(g, l, tl.clipY, w, tl.clipH, V.look.bg, C.accent, 1);
  g.clip();
  g.fillStyle = V.look.ink; g.font = `600 12px ${C.body || "sans-serif"}`; g.textBaseline = "middle";
  g.fillText("Title card", l + 8, tl.clipY + 14, Math.max(0, w - 16));
  g.font = `12px ${C.body || "sans-serif"}`;
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
function drawCapLane(g, P, W) {
  const C = tl.col, y = tl.capY, h = tl.capH, list = capsOnTimeline(P);
  if (!list.length) return;
  g.save();
  g.font = `600 11.5px ${C.body || "sans-serif"}`; g.textBaseline = "middle";
  for (const x of list) {
    const x0 = xOf(x.t0), x1 = xOf(x.t1);
    if (x1 < 0 || x0 > W) continue;
    const sel = x.cap.id === V.selCap, w = Math.max(3, x1 - x0 - 2);
    g.save();
    roundBox(g, x0 + 1, y, w, h, C.surface);
    g.globalAlpha = 0.22; g.fillStyle = C.t[3]; g.fill(); g.globalAlpha = 1;
    g.lineWidth = sel ? 2.5 : 1; g.strokeStyle = sel ? C.ink : C.t[3]; g.stroke();
    g.clip();
    g.fillStyle = C.ink;
    if (w > 24) g.fillText(x.cap.text.trim() || "(empty)", x0 + 6, y + h / 2);   // the clip cuts off what doesn't fit
    g.restore();
  }
  // while a caption is being dragged, its length floats above it
  const d = tl.drag;
  if (d && d.kind === "cap") {
    const x = list.find(k => k.cap === d.cap);
    if (x) {
      const label = `${(x.cap.e - x.cap.s).toFixed(1)} s`, cx = clamp(xOf((x.t0 + x.t1) / 2), 30, W - 30);
      g.font = `600 12px ${C.mono || "monospace"}`; g.textAlign = "center";
      const bw = g.measureText(label).width + 14;
      roundBox(g, cx - bw / 2, y - 24, bw, 20, C.ink);
      g.fillStyle = C.surface; g.fillText(label, cx, y - 14);
      g.textAlign = "left";
    }
  }
  g.restore();
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
  if (y >= tl.capY && y <= tl.capY + tl.capH) {
    // the caption under the pointer wins, so where two captions touch, the side you
    // point at is the one that moves; short captions get a third of their width per edge
    const list = capsOnTimeline(vplan()), edges = c => {
      const x0 = xOf(c.t0), x1 = xOf(c.t1), zone = Math.min(EDGE, Math.max(3, (x1 - x0) / 3));
      return { x0, x1, zone };
    };
    const under = [...list].reverse().find(c => { const k = edges(c); return x >= k.x0 && x <= k.x1; });
    if (under) {
      const k = edges(under);
      return { cap: under, edge: x - k.x0 <= k.zone ? "l" : k.x1 - x <= k.zone ? "r" : null };
    }
    for (const c of list) {
      const k = edges(c);
      if (k.x0 - x > 0 && k.x0 - x <= k.zone) return { cap: c, edge: "l" };
      if (x - k.x1 > 0 && x - k.x1 <= k.zone) return { cap: c, edge: "r" };
    }
    return null;
  }
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
  V.selCap = h && h.cap ? h.cap.cap.id : null;
  if (h && h.cap) {
    V.sel = -1; V.selJoin = -1;
    const cap = h.cap.cap, same = V.caps.filter(k => k !== cap && k.src === cap.src);
    // neighbours in the same video: a caption can't be dragged over them
    const lo = Math.max(cap.src.start, ...same.filter(k => k.e <= cap.s + 1e-6).map(k => k.e));
    const hi = Math.min(cap.src.end, ...same.filter(k => k.s >= cap.e - 1e-6).map(k => k.s));
    tl.drag = { kind: "cap", cap, edge: h.edge, x0: x, orig: { s: cap.s, e: cap.e }, lo, hi, pps: pps() };
    showTab("caps"); renderCapList(); focusCapRow(cap.id, false);
    if (!h.edge) vSeek(h.cap.t0 + 0.01); else vPause();
  } else if (h && h.join != null) {
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
  if (d.kind === "cap") {
    // captions move in their video's own time, between their neighbours
    const c = d.cap, dt = (x - d.x0) / pps(), MIN = 0.3;
    if (d.edge === "l") c.s = clamp(d.orig.s + dt, d.lo, c.e - MIN);
    else if (d.edge === "r") c.e = clamp(d.orig.e + dt, c.s + MIN, d.hi);
    else { const sh = clamp(dt, d.lo - d.orig.s, d.hi - d.orig.e); c.s = d.orig.s + sh; c.e = d.orig.e + sh; }
    d.moved = d.moved || Math.abs(x - d.x0) > 2;
    V.version++;
    vtick();
    return;
  }
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
  if (d.kind === "cap") {
    if (d.moved) { renderCapList(); focusCapRow(d.cap.id, false); vStatus("Caption timing changed."); vSave(); }
    updateUi();
    return;
  }
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
    const vb = voiceBuffer(s), sl = vb.getChannelData(0), sr2 = vb.numberOfChannels > 1 ? vb.getChannelData(1) : sl;
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
    // the cleaned-up sound must be ready before it's written out
    if (enhKey() !== "0:0") { $("#vNote").textContent = "Finishing the sound cleanup…"; await processVoices(); }
    const P = vplan(), [W, H] = outSize(), s0 = V.clips[0].src;
    const fps = [24, 25, 30, 50, 60].reduce((a, b) => Math.abs(b - s0.fps) < Math.abs(a - s0.fps) ? b : a);
    const bitrate = clamp(Math.round(W * H * fps * 0.14), 2e6, 16e6);
    const vcfg = await pickEncoder(W, H, fps, bitrate);
    if (!vcfg) throw new Error("this browser can't make MP4 video at this size. Try Chrome or Edge");
    const sr = audio().sampleRate;
    const acfg = { codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: 2, bitrate: 192000 };
    if (!(await AudioEncoder.isConfigSupported(acfg).then(r => r.supported, () => false))) throw new Error("this browser can't make AAC sound. Try Chrome or Edge");
    const burn = V.capLook.burn && capsOnTimeline(P).length > 0;
    await loadFonts();

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
      st.t = t; st.P = P;
      if (burn) st.cap = capAt(P, t);
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
      storeFile("src-" + s.id, f);
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
  if (added.length && enhKey() !== "0:0") processVoices();
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
    storeFile("music", file);
    vStatus(`Added music: ${V.music.name}.`);
  } catch (e) {
    vStatus(`Couldn't read ${file.name}${e && e.why ? ": " + e.why : ". Try an MP3 or M4A file"}.`, true);
  }
  settingsChanged();
}

/* ---------- Saved project (this browser only) ----------
   The videos, music and the whole edit live in IndexedDB, so a reload or a later
   visit picks up where you left off. A separate database from Build mode's,
   which tidies away files it doesn't know. */
const vstore = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open("hookd-video", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("files"); r.result.createObjectStore("project"); };
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
    putFile: (k, f) => tx("files", "readwrite", s => s.put(f, k)),
    getFile: k => tx("files", "readonly", s => s.get(k)),
    fileKeys: () => tx("files", "readonly", s => s.getAllKeys()),
    delFile: k => tx("files", "readwrite", s => s.delete(k)),
    put: v => tx("project", "readwrite", s => s.put(v, "current")),
    get: () => tx("project", "readonly", s => s.get("current")),
    clear: () => Promise.all([tx("files", "readwrite", s => s.clear()), tx("project", "readwrite", s => s.clear())]),
  };
})();
let vRestoring = true, vSaveT = 0, vSaveOK = true, vStoring = 0;
// store a video or music file; leaving the page warns until it has landed
function storeFile(k, f) {
  if (!vSaveOK) return;
  vStoring++;
  vstore.putFile(k, f).catch(vSaveFail).finally(() => vStoring--);
}
function vSaveFail() {
  if (!vSaveOK) return;
  vSaveOK = false;
  toast("This browser isn't letting the page save your videos, so a reload will clear them.");
}
function projectData() {
  return {
    v: 1, nextId: V.nextId, name: $("#vName").value,
    sources: V.sources.map(s => ({ id: s.id, name: s.name, color: s.color })),
    clips: V.clips.map(c => ({ id: c.id, src: c.src.id, in: c.in, out: c.out, trans: c.trans || null })),
    caps: V.caps.map(k => ({ id: k.id, src: k.src.id, s: k.s, e: k.e, text: k.text })),
    chapters: V.chapters.map(c => ({ ...c, src: c.src.id })),
    title: V.title, banner: V.banner, look: V.look, shape: V.shape, fit: V.fit, capLook: V.capLook, enh: V.enh,
    music: V.music ? { name: V.music.name, vol: V.music.vol, duck: V.music.duck } : null,
    cover: V.cover ? { name: V.cover.name } : null,
  };
}
function vSave() {
  if (vRestoring || !vSaveOK) return;
  clearTimeout(vSaveT);
  vSaveT = setTimeout(() => { if (!vRestoring) vstore.put(projectData()).catch(vSaveFail); }, 500);
}
async function vRestore() {
  let p;
  try { p = await vstore.get(); } catch (e) { vSaveOK = false; return; }
  if (!p || p.v !== 1 || !p.clips || !p.clips.length) return;
  vStatus("Opening your last video project…");
  const byId = new Map();
  let failed = 0;
  for (let i = 0; i < p.sources.length; i++) {
    const saved = p.sources[i];
    if (!p.clips.some(c => c.src === saved.id) && !p.caps.some(k => k.src === saved.id)) continue;
    vStatus(`Opening your last video project: ${saved.name} (${i + 1} of ${p.sources.length})…`);
    try {
      const file = await vstore.getFile("src-" + saved.id);
      if (!file) throw new Error("missing");
      const s = await openSource(file);
      Object.assign(s, { id: saved.id, name: saved.name, color: saved.color });
      V.sources.push(s); byId.set(saved.id, s);
    } catch (e) { failed++; }
  }
  V.clips = p.clips.filter(c => byId.has(c.src)).map(c => ({ ...c, src: byId.get(c.src) }));
  V.caps = (p.caps || []).filter(k => byId.has(k.src)).map(k => ({ ...k, src: byId.get(k.src) }));
  V.chapters = (p.chapters || []).filter(c => byId.has(c.src)).map(c => ({ ...c, src: byId.get(c.src) }));
  Object.assign(V.title, p.title || {}); Object.assign(V.capLook, p.capLook || {}); Object.assign(V.enh, p.enh || {});
  Object.assign(V.banner, p.banner || {}); if (p.look) V.look = { ...V.look, ...p.look };
  if (p.cover) {
    try { const f = await vstore.getFile("cover"); V.cover = { name: p.cover.name, bmp: await createImageBitmap(f) }; } catch (e) { failed++; }
  }
  V.shape = p.shape || V.shape; V.fit = p.fit || V.fit;
  V.nextId = Math.max(p.nextId || 1, ...V.sources.map(s => s.id + 1), ...V.clips.map(c => c.id + 1), ...V.caps.map(k => k.id + 1), ...V.chapters.map(c => c.id + 1));
  if (p.name) $("#vName").value = p.name;
  if (p.music) {
    try {
      const f = await vstore.getFile("music");
      V.music = { name: p.music.name, buffer: await decodeFile(audio(), f), vol: p.music.vol, duck: p.music.duck };
    } catch (e) { failed++; }
  }
  syncForms();
  V.sel = V.clips.length ? 0 : -1;
  vStatus(failed ? `Opened your last project, but ${failed} file${failed > 1 ? "s" : ""} couldn't be read back. Add ${failed > 1 ? "them" : "it"} again.` : "Picked up where you left off.", failed > 0);
  if (!failed) setTimeout(() => { if ($("#vStatus").textContent === "Picked up where you left off.") vStatus(""); }, 4000);
}
async function vRestoreAll() {
  try { await vRestore(); } catch (e) {} finally { vRestoring = false; }
  V.version++;
  sizeTimeline(); sizePreview(); renderCapList(); vtick(); updateUi();
  if (enhKey() !== "0:0") processVoices();
  // tidy away stored videos the project no longer uses
  try {
    const keep = new Set(V.sources.map(s => "src-" + s.id).concat(V.music ? ["music"] : [], V.cover ? ["cover"] : []));
    for (const k of await vstore.fileKeys()) if (!keep.has(k)) await vstore.delFile(k);
  } catch (e) {}
}
let startOverArmed = 0;
async function startOver() {
  const b = $("#vNew");
  if (!startOverArmed) {
    b.textContent = "Click again to clear everything"; b.classList.add("danger");
    startOverArmed = setTimeout(() => { startOverArmed = 0; b.textContent = "Start over"; b.classList.remove("danger"); }, 4000);
    return;
  }
  clearTimeout(startOverArmed); startOverArmed = 0; b.textContent = "Start over"; b.classList.remove("danger");
  if (capJob) cancelAutoCaptions();
  vPause();
  V.sources.forEach(s => URL.revokeObjectURL(s.url));
  // the style (colours, font, caption look, banner name) stays for the next video in the series
  Object.assign(V, { sources: [], clips: [], caps: [], chapters: [], undo: [], redo: [], sel: -1, selJoin: -1, selCap: null, T: 0, music: null, cover: null });
  Object.assign(V.title, { on: false, text: "", dur: 3 });
  Object.assign(V.enh, { noise: 0, level: false, bright: 0, contrast: 0, sat: 0, warm: 0 });
  $("#vName").value = "";
  syncForms();
  els.forEach(e => { e.removeAttribute("src"); e.dataset.src = ""; e.itemId = null; e.load(); });
  try { await vstore.clear(); } catch (e) {}
  changed();
  vStatus("Cleared. Add videos to start a new project.");
}

/* ---------- Captions panel ---------- */
function capsChanged() { V.version++; renderCapList(); vtick(); updateUi(); vSave(); }
// The list shows captions in the order they play in the edited video.
function renderCapList() {
  const box = $("#vCapList"), P = vplan(), seen = new Set(), rows = [];
  for (const x of capsOnTimeline(P)) { if (!seen.has(x.cap.id)) { seen.add(x.cap.id); rows.push(x); } }
  const focusedId = document.activeElement && document.activeElement.closest(".vcap") ? document.activeElement.closest(".vcap").dataset.id : null;
  box.replaceChildren(...rows.map(x => {
    const row = document.createElement("li");
    row.className = "vcap"; row.dataset.id = x.cap.id;
    row.classList.toggle("sel", x.cap.id === V.selCap);
    const time = document.createElement("button");
    time.type = "button"; time.className = "vcap-time mono"; time.textContent = fmt(x.t0, 1);
    time.title = "Jump here"; time.setAttribute("aria-label", `Jump to ${fmt(x.t0, 1)}`);
    time.addEventListener("click", () => { V.selCap = x.cap.id; V.sel = -1; V.selJoin = -1; vSeek(x.t0 + 0.01); markSelectedRow(); });
    const text = document.createElement("textarea");
    text.rows = 2; text.value = x.cap.text; text.setAttribute("aria-label", `Caption at ${fmt(x.t0, 1)}`);
    text.addEventListener("focus", () => { V.selCap = x.cap.id; markSelectedRow(); if (!V.playing) vSeek(x.t0 + 0.01); });
    text.addEventListener("input", () => { x.cap.text = text.value; V.version++; vtick(); vSave(); });
    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn"; del.setAttribute("aria-label", `Delete caption at ${fmt(x.t0, 1)}`);
    del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener("click", () => deleteCaption(x.cap.id));
    row.append(time, text, del);
    return row;
  }));
  $("#vCapEmpty").hidden = rows.length > 0;
  $("#vCapCount").textContent = rows.length ? `${rows.length} caption${rows.length > 1 ? "s" : ""}` : "";
  if (focusedId) { const r = box.querySelector(`.vcap[data-id="${focusedId}"] textarea`); if (r) r.focus({ preventScroll: true }); }
}
function markSelectedRow() { document.querySelectorAll("#vCapList .vcap").forEach(r => r.classList.toggle("sel", r.dataset.id == V.selCap)); }
// Bring a row into view by scrolling the list (and the tools panel) only, never the page,
// so the timeline stays put under the pointer.
function showRow(row) {
  for (const box of [$("#vCapList"), $("#vToolsPanel")]) {
    const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 4;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4;
  }
}
function focusCapRow(id, focusText = true) {
  const row = $(`#vCapList .vcap[data-id="${id}"]`);
  if (!row) return;
  showRow(row);
  if (focusText) row.querySelector("textarea").focus({ preventScroll: true });
}
let lastActiveCap = null;
function markActiveCap(x) {
  const id = x ? x.cap.id : null;
  if (id === lastActiveCap) return;
  lastActiveCap = id;
  document.querySelectorAll("#vCapList .vcap").forEach(r => r.classList.toggle("now", r.dataset.id == id));
  if (id && V.playing) { const row = $(`#vCapList .vcap[data-id="${id}"]`); if (row && !row.contains(document.activeElement)) showRow(row); }
}
function addCaptionAtPlayhead() {
  if (!V.clips.length || V.exporting) return;
  const L = locate(V.T), c = V.clips[L.i];
  if (!c) { vStatus("Move the playhead onto a clip to add a caption there."); return; }
  const s = L.s, next = V.caps.filter(k => k.src === c.src && k.s > s).reduce((m, k) => Math.min(m, k.s), Infinity);
  const e = Math.min(s + 2.5, c.out, next);
  if (e - s < 0.3) { vStatus("There's already a caption right here. Click it in the timeline to edit it."); return; }
  const cap = { id: V.nextId++, src: c.src, s, e, text: "" };
  V.caps.push(cap); V.selCap = cap.id; V.sel = -1; V.selJoin = -1;
  showTab("caps"); capsChanged();
  focusCapRow(cap.id);
}
function deleteCaption(id) {
  const i = V.caps.findIndex(k => k.id === id);
  if (i < 0) return;
  const [cap] = V.caps.splice(i, 1);
  if (V.selCap === id) V.selCap = null;
  capsChanged();
  toast("Caption deleted.", () => { V.caps.splice(Math.min(i, V.caps.length), 0, cap); capsChanged(); });
}
async function importSubs(file) {
  if (!file) return;
  const cues = parseSubs(await file.text());
  if (!cues.length) { vStatus(`${file.name} has no captions Hookd can read. Use an .srt or .vtt file.`, true); return; }
  const added = [];
  for (const q of cues) {
    const L = locate(q.t0 + 0.001), c = V.clips[L.i];
    if (!c || q.t0 >= vtotal()) continue;
    added.push({ id: V.nextId++, src: c.src, s: L.s, e: Math.min(c.out, L.s + (q.t1 - q.t0)), text: q.text });
  }
  V.caps.push(...added);
  showTab("caps"); capsChanged();
  vStatus(`Added ${added.length} caption${added.length === 1 ? "" : "s"} from ${file.name}.`);
}
async function saveSrt() {
  const srt = captionsSrt(vplan());
  if (!srt) { vStatus("There are no captions to save yet."); return; }
  await saveFile(new Blob([srt], { type: "application/x-subrip" }), exportName() + ".srt");
}

/* ---------- Automatic captions ---------- */
// The sound the edit uses, as pieces under 30 s (Whisper's window), split at quiet moments.
async function speechPieces() {
  const bySrc = new Map();
  for (const c of V.clips) {
    if (!c.src.audio) continue;
    if (!bySrc.has(c.src)) bySrc.set(c.src, []);
    bySrc.get(c.src).push([c.in, c.out]);
  }
  const pieces = [];
  for (const [src, rs] of bySrc) {
    rs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of rs) { const m = merged.at(-1); if (m && r[0] <= m[1] + 0.5) m[1] = Math.max(m[1], r[1]); else merged.push([...r]); }
    for (const [a, b] of merged) {
      let t = a;
      while (b - t > 0.5) {
        let end = b;
        if (b - t > 28) {   // cut at the quietest moment between 20 and 28 s in
          let best = t + 28, low = Infinity;
          for (let u = t + 20; u < t + 28; u += 0.02) {
            const lv = src.levels[Math.floor((u - src.aOff) * LEVELS_PER_SEC)] ?? 1;
            if (lv < low) { low = lv; best = u; }
          }
          end = best;
        }
        // skip stretches with nobody talking; Whisper tends to invent words for silence
        let loud = false;
        for (let u = t; u < end && !loud; u += 0.02) if ((src.levels[Math.floor((u - src.aOff) * LEVELS_PER_SEC)] || 0) > src.voiceThr) loud = true;
        if (loud) pieces.push({ src, t0: t, t1: end });
        t = end;
      }
    }
  }
  for (const p of pieces) p.audio = await to16k(p.src, p.t0, p.t1);
  return pieces;
}
async function to16k(src, t0, t1) {
  const buf = src.audio, sr = buf.sampleRate;
  const a = clamp(Math.round((t0 - src.aOff) * sr), 0, buf.length), b = clamp(Math.round((t1 - src.aOff) * sr), a + 1, buf.length);
  const part = new AudioBuffer({ length: b - a, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < buf.numberOfChannels; ch++) part.copyToChannel(buf.getChannelData(ch).subarray(a, b), ch);
  const off = new OfflineAudioContext(1, Math.ceil((b - a) / sr * 16000), 16000);
  const s = off.createBufferSource(); s.buffer = part; s.connect(off.destination); s.start();
  return (await off.startRendering()).getChannelData(0);
}
let capWorker = null, capJob = null;
async function autoCaptions() {
  if (capJob) { cancelAutoCaptions(); return; }
  if (!V.clips.length || V.exporting) return;
  if (!V.clips.some(c => c.src.audio)) { vStatus("None of these videos has sound to make captions from.", true); return; }
  const model = $("#vCapModel").value, language = $("#vCapLang").value;
  vPause();
  const job = capJob = { found: [], cancelled: false };
  updateUi();
  const prog = $("#vCapProg"), note = $("#vCapNote");
  prog.hidden = false; prog.removeAttribute("value"); note.textContent = "Getting the sound ready…";
  try {
    const pieces = await speechPieces();
    if (job.cancelled) return;
    if (!pieces.length) { vStatus("Couldn't hear anyone talking in these clips."); return; }
    if (!capWorker) capWorker = new Worker("captions-worker.js", { type: "module" });
    const total = pieces.reduce((a, p) => a + p.t1 - p.t0, 0);
    await new Promise((resolve, reject) => {
      job.stop = resolve;
      let done = 0;
      capWorker.onmessage = e => {
        const d = e.data;
        if (job.cancelled) return;
        if (d.type === "download") {
          prog.value = d.loaded / d.total;
          note.textContent = `Downloading the speech model (once)… ${Math.round(d.loaded / 1e6)} of ${Math.round(d.total / 1e6)} MB`;
        } else if (d.type === "ready") {
          prog.value = 0; note.textContent = "Listening…";
        } else if (d.type === "piece") {
          const p = pieces[d.index];
          for (const ch of d.chunks) {
            const s = p.t0 + Math.max(0, ch.s ?? 0), e = Math.min(p.t1, p.t0 + (ch.e ?? (p.t1 - p.t0)));
            for (const part of splitCaption(s, Math.max(e, s + 0.4), ch.text)) job.found.push({ id: V.nextId++, src: p.src, ...part });
          }
          done += p.t1 - p.t0;
          prog.value = done / total;
          note.textContent = `Listening… ${Math.round(done / total * 100)}%`;
        } else if (d.type === "done") resolve();
        else if (d.type === "error") reject(new Error(d.message));
      };
      capWorker.onerror = () => reject(new Error("the speech tools stopped unexpectedly"));
      capWorker.postMessage({ type: "run", model, device: "wasm", language, pieces: pieces.map((p, id) => ({ id, audio: p.audio })) },
        pieces.map(p => p.audio.buffer));
    });
    if (job.cancelled) return;
    // new captions replace the old ones for the parts that were listened to
    const covered = (src, s, e) => pieces.some(p => p.src === src && s < p.t1 && e > p.t0);
    V.caps = V.caps.filter(k => !covered(k.src, k.s, k.e)).concat(job.found);
    showTab("caps"); capsChanged();
    vStatus(job.found.length ? `Made ${job.found.length} captions. Read them through and fix any words it got wrong.` : "Didn't catch any words. Try another language setting.");
  } catch (e) {
    if (!job.cancelled) vStatus("Couldn't make captions: " + ((e && e.message) || e), true);
    if (capWorker) { capWorker.terminate(); capWorker = null; }
  } finally {
    if (capJob === job) capJob = null;
    prog.hidden = true; note.textContent = "";
    updateUi();
  }
}
function cancelAutoCaptions() {
  if (!capJob) return;
  capJob.cancelled = true;
  if (capJob.stop) capJob.stop();
  capJob = null;
  if (capWorker) { capWorker.terminate(); capWorker = null; }
  $("#vCapProg").hidden = true; $("#vCapNote").textContent = "";
  vStatus("Stopped making captions.");
  updateUi();
}

/* ---------- Chapters panel ---------- */
function chaptersChanged() { V.version++; renderChapList(); vtick(); updateUi(); vSave(); }
const option = (value, label, sel) => { const o = document.createElement("option"); o.value = value; o.textContent = label; o.selected = sel; return o; };
function renderChapList() {
  const box = $("#vChapList"), rows = chaptersOnTimeline(vplan());
  const focused = document.activeElement && document.activeElement.closest(".vchap");
  const fid = focused && focused.dataset.id, fk = fid && document.activeElement.dataset.k;
  box.replaceChildren(...rows.map((x, n) => {
    const ch = x.ch, row = document.createElement("li");
    row.className = "vchap"; row.dataset.id = ch.id;
    const time = document.createElement("button");
    time.type = "button"; time.className = "vcap-time mono"; time.textContent = fmt(x.t0, 1);
    time.title = "Jump here"; time.setAttribute("aria-label", `Jump to chapter ${n + 1} at ${fmt(x.t0, 1)}`);
    time.addEventListener("click", () => vSeek(x.t0 + 0.01));
    const field = (k, label, ph) => {
      const i = document.createElement("input");
      i.className = "vname"; i.value = ch[k]; i.placeholder = ph; i.maxLength = 60; i.dataset.k = k; i.autocomplete = "off";
      i.setAttribute("aria-label", `Chapter ${n + 1} ${label}`);
      i.addEventListener("focus", () => { if (!V.playing) vSeek(x.t0 + Math.min(ch.card + 0.5, x.t1 - x.t0 - 0.01)); });
      i.addEventListener("input", () => { ch[k] = i.value; vtick(); vSave(); });
      return i;
    };
    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn"; del.setAttribute("aria-label", `Delete chapter ${n + 1}`);
    del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener("click", () => deleteChapter(ch.id));
    const pick = (k, label, opts) => {
      const s = document.createElement("select");
      s.dataset.k = k; s.setAttribute("aria-label", `Chapter ${n + 1} ${label}`); s.title = label;
      s.append(...opts.map(([v, l]) => option(v, l, String(ch[k]) === String(v))));
      s.addEventListener("change", () => { ch[k] = k === "icon" ? s.value : +s.value; chaptersChanged(); vSeek(x.t0 + 0.01); });
      return s;
    };
    const opts = document.createElement("div");
    opts.className = "vchap-opts";
    opts.append(
      pick("icon", "picture", Object.entries(ICONS)),
      pick("card", "full-screen card", [[0, "No card"], [1, "Card 1 s"], [1.5, "Card 1.5 s"], [2, "Card 2 s"], [3, "Card 3 s"]]),
      pick("hold", "heading stays", [[2, "Then 2 s"], [4, "Then 4 s"], [6, "Then 6 s"], [10, "Then 10 s"]]));
    row.append(time, field("text", "heading", "Heading, like What to target"), del, field("sub", "second line", "Second line (optional)"), opts);
    return row;
  }));
  $("#vChapEmpty").hidden = rows.length > 0;
  if (fid) { const el = box.querySelector(`.vchap[data-id="${fid}"] [data-k="${fk}"]`); if (el) el.focus({ preventScroll: true }); }
}
function addChapterAtPlayhead(fields = {}) {
  if (!V.clips.length || V.exporting) return null;
  const L = locate(V.T), c = V.clips[L.i];
  if (!c) { vStatus("Move the playhead onto a clip to start a chapter there."); return null; }
  // new chapters copy the last one's picture and timings, so a series stays consistent
  const last = V.chapters.at(-1) || { icon: "chart", card: 1.5, hold: 4 };
  const ch = { id: V.nextId++, src: c.src, s: L.s, text: "", sub: "", icon: last.icon, card: last.card, hold: last.hold, ...fields };
  V.chapters.push(ch);
  showTab("chap"); chaptersChanged();
  const inp = $(`#vChapList .vchap[data-id="${ch.id}"] [data-k="text"]`);
  if (inp && !fields.text) { showRow(inp.closest(".vchap")); inp.focus({ preventScroll: true }); }
  vStatus("Chapter added. Type its heading; it shows as a full card, then stays at the top.");
  return ch;
}
function deleteChapter(id) {
  const i = V.chapters.findIndex(c => c.id === id);
  if (i < 0) return;
  const [ch] = V.chapters.splice(i, 1);
  chaptersChanged();
  toast("Chapter deleted.", () => { V.chapters.splice(Math.min(i, V.chapters.length), 0, ch); chaptersChanged(); });
}

/* ---------- Style panel ---------- */
// Saved styles live in this browser, so every video in a series can share one look.
const STYLE_KEY = "hookd-styles";
function savedStyles() { try { return JSON.parse(localStorage.getItem(STYLE_KEY)) || []; } catch (e) { return []; } }
function storeStyles(list) { try { localStorage.setItem(STYLE_KEY, JSON.stringify(list)); return true; } catch (e) { return false; } }
function currentStyle(name) {
  return { name, look: { ...V.look }, capLook: { style: V.capLook.style, size: V.capLook.size, pos: V.capLook.pos },
    banner: { ...V.banner }, title: { style: V.title.style, sub: V.title.sub } };
}
function applyStyle(s) {
  V.look = { ...V.look, ...s.look };
  if (s.capLook) Object.assign(V.capLook, s.capLook);
  if (s.banner) Object.assign(V.banner, s.banner);
  if (s.title) Object.assign(V.title, s.title);
  syncForms(); lookChanged();
}
function lookChanged() { settingsChanged(); loadFonts().then(() => vtick()); }
function renderStyles() {
  const box = $("#vThemes"), saved = savedStyles(), swatch = l => {
    const i = document.createElement("i");
    i.setAttribute("aria-hidden", "true");
    i.style.background = l.bg; i.style.color = l.ink; i.style.borderColor = l.accent;
    const b = document.createElement("b"); b.style.background = l.hiBox; i.append("Aa", b);
    return i;
  };
  const btns = Object.entries(THEMES).map(([id, t]) => {
    const b = document.createElement("button");
    b.type = "button"; b.dataset.theme = id; b.append(swatch(t), t.name);
    b.setAttribute("aria-pressed", V.look.theme === id);
    return b;
  });
  saved.forEach((s, n) => {
    const wrap = document.createElement("span"), b = document.createElement("button"), x = document.createElement("button");
    wrap.className = "vsaved";
    b.type = "button"; b.dataset.saved = n; b.append(swatch(s.look), s.name);
    b.setAttribute("aria-pressed", V.look.theme === "saved:" + s.name);
    x.type = "button"; x.className = "icon-btn"; x.dataset.unsave = n; x.setAttribute("aria-label", `Remove the style ${s.name}`);
    x.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    wrap.append(b, x); btns.push(wrap);
  });
  box.replaceChildren(...btns);
}
function saveStyle() {
  const name = $("#vStyleName").value.trim().slice(0, 30);
  if (!name) { $("#vStyleName").focus(); vStatus("Give your style a name first, like the name of your series."); return; }
  V.look.theme = "saved:" + name;
  const list = savedStyles().filter(s => s.name !== name);
  list.push(currentStyle(name));
  if (!storeStyles(list.slice(-12))) { vStatus("This browser isn't letting the page save styles.", true); return; }
  $("#vStyleName").value = "";
  renderStyles(); vSave();
  vStatus(`Saved the style "${name}". Pick it on your next video to make it match.`);
}

/* ---------- Title, banner and cover ---------- */
async function addCover(file) {
  if (!file) return;
  try {
    V.cover = { name: cleanName(file.name), bmp: await createImageBitmap(file) };
    storeFile("cover", file);
    vStatus(`Added ${V.cover.name} to the cover.`);
  } catch (e) { vStatus(`Couldn't read ${file.name}. Use a JPG, PNG or WebP picture.`, true); }
  settingsChanged(); vSeek(1);
}

/* ---------- Forms ---------- */
// Put every control back in step with the project (after a restore, a style or the API).
function syncForms() {
  $("#vTitleOn").checked = V.title.on; $("#vTitleText").value = V.title.text; $("#vTitleSub").value = V.title.sub; $("#vTitleDur").value = String(V.title.dur);
  $("#vBannerOn").checked = V.banner.on; $("#vBannerText").value = V.banner.text; $("#vBannerDur").value = String(V.banner.dur);
  if (V.music) { $("#vMusicVol").value = Math.round(V.music.vol * 100); $("#vDuck").checked = V.music.duck; }
  const k = V.look;
  $("#vColBg").value = k.bg; $("#vColInk").value = k.ink; $("#vColAccent").value = k.accent; $("#vColHiBox").value = k.hiBox; $("#vColHiInk").value = k.hiInk;
  $("#vFont").value = k.font; $("#vCaps").checked = k.caps;
  showEnh(); renderStyles(); renderChapList();
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
  document.querySelectorAll("#vTitleStyle [data-tstyle]").forEach(b => { b.setAttribute("aria-pressed", b.dataset.tstyle === V.title.style); b.disabled = !V.title.on; });
  const isCover = V.title.style === "cover";
  $("#vCoverSet").hidden = !isCover;
  $("#vCoverAdd").disabled = !V.title.on;
  $("#vCoverAdd").textContent = V.cover ? "Change picture" : "Add a picture";
  $("#vCoverName").textContent = V.cover ? V.cover.name : "";
  $("#vCoverDel").hidden = !V.cover;
  $("#vTitleHelp").textContent = isCover ? "Covers the first seconds of your video: it shrinks into a frame under your title, then grows back out. Nothing is added to the length."
    : "A plain card that plays before your video, in your style's colours.";
  ["#vBannerText", "#vBannerDur"].forEach(s => ($(s).disabled = !V.banner.on));
  // chapters and style
  $("#vChapAdd").disabled = !has || busy;
  document.querySelectorAll("#vThemes [data-theme], #vThemes [data-saved]").forEach(b => {
    const s = b.dataset.saved != null && savedStyles()[b.dataset.saved];
    b.setAttribute("aria-pressed", V.look.theme === (s ? "saved:" + s.name : b.dataset.theme));
  });
  // captions
  const hasCaps = capsOnTimeline(vplan()).length > 0;
  $("#vCapAuto").disabled = (!has || busy) && !capJob;
  $("#vCapAuto").textContent = capJob ? "Stop" : hasCaps ? "Make captions again" : "Make captions automatically";
  $("#vCapAuto").classList.toggle("primary", !capJob && !hasCaps && has);
  $("#vCapAdd").disabled = !has || busy;
  $("#vCapImport").disabled = !has || busy;
  $("#vCapSrt").disabled = !hasCaps;
  ["#vCapLang", "#vCapModel"].forEach(s => ($(s).disabled = !!capJob));
  document.querySelectorAll("#vCapStyle [data-style]").forEach(b => b.setAttribute("aria-pressed", b.dataset.style === V.capLook.style));
  $("#vCapBoxHelp").hidden = V.capLook.style !== "box";
  document.querySelectorAll("#vCapSize [data-size]").forEach(b => b.setAttribute("aria-pressed", b.dataset.size === V.capLook.size));
  document.querySelectorAll("#vCapPos [data-pos]").forEach(b => b.setAttribute("aria-pressed", b.dataset.pos === V.capLook.pos));
  $("#vCapBurn").checked = V.capLook.burn;
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
$("#vMusicDel").addEventListener("click", () => { vPause(); V.music = null; vstore.delFile("music").catch(() => {}); settingsChanged(); vStatus("Removed the music."); });
$("#vMusicVol").addEventListener("input", e => { if (V.music) { V.music.vol = e.target.value / 100; V.version++; vSave(); soundRefresh(); } });
$("#vDuck").addEventListener("change", e => { if (V.music) { V.music.duck = e.target.checked; V.version++; vSave(); soundRefresh(); } });
// title card
$("#vTitleOn").addEventListener("change", e => { V.title.on = e.target.checked; settingsChanged(); if (V.title.on) vSeek(0); });
$("#vTitleText").addEventListener("input", e => { V.title.text = e.target.value; vtick(); vSave(); });
$("#vTitleSub").addEventListener("input", e => { V.title.sub = e.target.value; vtick(); vSave(); });
$("#vTitleDur").addEventListener("change", e => { V.title.dur = +e.target.value; settingsChanged(); });
$("#vTitleStyle").addEventListener("click", e => {
  const b = e.target.closest("[data-tstyle]"); if (!b) return;
  V.title.style = b.dataset.tstyle; settingsChanged(); vSeek(V.title.style === "cover" ? 1 : 0.5);
});
$("#vCoverAdd").addEventListener("click", () => $("#vCoverIn").click());
$("#vCoverIn").addEventListener("change", e => { addCover(e.target.files[0]); e.target.value = ""; });
$("#vCoverDel").addEventListener("click", () => { V.cover = null; vstore.delFile("cover").catch(() => {}); settingsChanged(); });
// series banner
$("#vBannerOn").addEventListener("change", e => {
  V.banner.on = e.target.checked; settingsChanged();
  if (V.banner.on) { const b = bannerSpan(vplan()); vSeek(b ? b.t0 + 1 : 0); if (!V.banner.text) $("#vBannerText").focus(); }
});
$("#vBannerText").addEventListener("input", e => { V.banner.text = e.target.value; vtick(); vSave(); });
$("#vBannerDur").addEventListener("change", e => { V.banner.dur = +e.target.value; settingsChanged(); });
// chapters
$("#vChapAdd").addEventListener("click", () => addChapterAtPlayhead());
// style
$("#vThemes").addEventListener("click", e => {
  const un = e.target.closest("[data-unsave]");
  if (un) { const list = savedStyles(); const [s] = list.splice(+un.dataset.unsave, 1); storeStyles(list); renderStyles(); updateUi(); if (s) vStatus(`Removed the style "${s.name}".`); return; }
  const sv = e.target.closest("[data-saved]");
  if (sv) { const s = savedStyles()[+sv.dataset.saved]; if (s) { applyStyle({ ...s, look: { ...s.look, theme: "saved:" + s.name } }); vStatus(`Using your style "${s.name}".`); } return; }
  const b = e.target.closest("[data-theme]");
  if (!b) return;
  V.look = lookOf(b.dataset.theme); syncForms(); lookChanged();
  vStatus(`${THEMES[b.dataset.theme].name} colours on your title, banner, chapters and Highlight captions.`);
});
[["#vColBg", "bg"], ["#vColInk", "ink"], ["#vColAccent", "accent"], ["#vColHiBox", "hiBox"], ["#vColHiInk", "hiInk"]].forEach(([sel, k]) =>
  $(sel).addEventListener("input", e => { V.look[k] = e.target.value; V.look.theme = "custom"; updateUi(); vtick(); vSave(); }));
$("#vFont").addEventListener("change", e => { V.look.font = e.target.value; V.look.theme = "custom"; updateUi(); lookChanged(); });
$("#vCaps").addEventListener("change", e => { V.look.caps = e.target.checked; vtick(); vSave(); });
$("#vStyleSave").addEventListener("click", saveStyle);
$("#vStyleName").addEventListener("keydown", e => { if (e.key === "Enter") saveStyle(); });
// shape
$("#vShapes").addEventListener("click", e => { const b = e.target.closest("[data-shape]"); if (b) { V.shape = b.dataset.shape; settingsChanged(); } });
$("#vFitSeg").addEventListener("click", e => { const b = e.target.closest("[data-fit]"); if (b) { V.fit = b.dataset.fit; settingsChanged(); } });
// captions
$("#vCapAuto").addEventListener("click", autoCaptions);
$("#vCapAdd").addEventListener("click", addCaptionAtPlayhead);
$("#vCapImport").addEventListener("click", () => $("#vCapIn").click());
$("#vCapIn").addEventListener("change", e => { importSubs(e.target.files[0]); e.target.value = ""; });
$("#vCapSrt").addEventListener("click", saveSrt);
$("#vCapBurn").addEventListener("change", e => { V.capLook.burn = e.target.checked; updateUi(); vSave(); });
[["#vCapStyle", "style"], ["#vCapSize", "size"], ["#vCapPos", "pos"]].forEach(([sel, key]) => $(sel).addEventListener("click", e => {
  const b = e.target.closest(`[data-${key}]`); if (!b) return;
  V.capLook[key] = b.dataset[key]; vtick(); updateUi(); vSave();
}));
// enhance: voice and colour
function showEnh() {
  $("#vNoise").value = String(V.enh.noise); $("#vLevel").checked = V.enh.level;
  for (const k of ["Bright", "Contrast", "Sat", "Warm"]) { const v = V.enh[k.toLowerCase()]; $("#v" + k).value = v; $("#v" + k + "Out").textContent = v > 0 ? "+" + v : v; }
}
$("#vNoise").addEventListener("change", e => { V.enh.noise = +e.target.value; vSave(); processVoices(); });
$("#vLevel").addEventListener("change", e => { V.enh.level = e.target.checked; vSave(); processVoices(); });
document.querySelectorAll(".vsliders input").forEach(inp => inp.addEventListener("input", () => {
  V.enh[inp.dataset.k] = +inp.value; showEnh(); vtick(); vSave();
}));
$("#vColorReset").addEventListener("click", () => { Object.assign(V.enh, { bright: 0, contrast: 0, sat: 0, warm: 0 }); showEnh(); vtick(); vSave(); });
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
  else if (k === "Delete" || k === "Backspace") { e.preventDefault(); if (V.selCap != null) deleteCaption(V.selCap); else deleteSelected(); }
  else if (k === "c" || k === "C") { e.preventDefault(); addCaptionAtPlayhead(); }
  else if (k === "ArrowLeft") { e.preventDefault(); e.shiftKey ? vSeek(V.T - 1) : stepFrames(-1); }
  else if (k === "ArrowRight") { e.preventDefault(); e.shiftKey ? vSeek(V.T + 1) : stepFrames(1); }
  else if (k === "Home") { e.preventDefault(); vSeek(0); }
  else if (k === "End") { e.preventDefault(); vSeek(vtotal()); }
});
// the project is saved, so leaving only needs a warning mid-export or while a file is still being stored
window.addEventListener("beforeunload", e => { if (V.exporting || vStoring) { e.preventDefault(); e.returnValue = ""; } });
$("#vName").addEventListener("input", vSave);
$("#vNew").addEventListener("click", startOver);
/* ---------- For AI assistants ----------
   window.hookd lets an assistant that drives the browser for someone (like Claude in
   Chrome) read and change the edit exactly, instead of guessing at clicks. The guide
   at /llms.txt explains it. Adding files and exporting stay with the person: the
   browser only lets them pick files and choose where to save. Times are seconds on
   the edited video's timeline, the same as the time under the preview. */
const oneOf = (v, list, what) => { if (!list.map(String).includes(String(v))) throw new Error(`${what} must be one of: ${list.join(", ")}`); return v; };
const timeArg = (t, what = "time") => { if (typeof t !== "number" || !isFinite(t)) throw new Error(`${what} must be a number of seconds`); return clamp(t, 0, vtotal()); };
const capById = id => { const k = V.caps.find(c => c.id === id); if (!k) throw new Error(`no caption with id ${id}; call hookd.video.state() for the ids`); return k; };
const chapById = id => { const c = V.chapters.find(c => c.id === id); if (!c) throw new Error(`no chapter with id ${id}; call hookd.video.state() for the ids`); return c; };
const chapFields = f => {
  const out = {};
  if (f.text != null) out.text = String(f.text).slice(0, 60);
  if (f.sub != null) out.sub = String(f.sub).slice(0, 60);
  if (f.icon != null) out.icon = oneOf(f.icon, Object.keys(ICONS), "icon");
  if (f.card != null) out.card = +oneOf(f.card, [0, 1, 1.5, 2, 3], "card");
  if (f.hold != null) out.hold = +oneOf(f.hold, [2, 4, 6, 10], "hold");
  return out;
};
window.hookd = {
  guide: location.origin + "/llms.txt",
  mode(m) { setMode(oneOf(m, ["build", "live", "video"], "mode")); return m; },
  video: {
    state() {
      const P = vplan();
      return {
        mode: state.mode, duration: +P.total.toFixed(3), playhead: +V.T.toFixed(3), playing: V.playing, exporting: V.exporting, fileName: $("#vName").value,
        output: (([w, h]) => ({ width: w, height: h }))(outSize()),
        clips: P.items.filter(it => it.kind === "clip").map(it => ({ index: it.ci, video: it.c.src.name, start: +it.start.toFixed(3), end: +it.end.toFixed(3),
          sourceIn: +it.c.in.toFixed(3), sourceOut: +it.c.out.toFixed(3), transitionIn: it.ci > 0 ? (it.c.trans || { type: "cut" }) : null })),
        captions: capsOnTimeline(P).map(x => ({ id: x.cap.id, start: +x.t0.toFixed(3), end: +x.t1.toFixed(3), text: x.cap.text })),
        chapters: chaptersOnTimeline(P).map(x => ({ id: x.ch.id, at: +x.t0.toFixed(3), until: +x.t1.toFixed(3), text: x.ch.text, sub: x.ch.sub, icon: x.ch.icon, card: x.ch.card, hold: x.ch.hold })),
        title: { ...V.title, coverPicture: V.cover ? V.cover.name : null }, banner: { ...V.banner }, look: { ...V.look }, captionStyle: { ...V.capLook },
        shape: V.shape, fit: V.fit, music: V.music ? { name: V.music.name, volume: V.music.vol, duck: V.music.duck } : null, enhance: { ...V.enh },
        themes: Object.keys(THEMES), savedStyles: savedStyles().map(s => s.name), icons: Object.keys(ICONS),
      };
    },
    seek(t) { vSeek(timeArg(t)); return V.T; },
    play() { vPlay(); }, pause() { vPause(); },
    // Change settings. Any of: title, banner, look, captionStyle, shape, fit, enhance, music, transition.
    set(p) {
      if (!p || typeof p !== "object") throw new Error("pass an object, like { banner: { on: true, text: 'Finance Playbook' } }");
      if (p.title) {
        const t = p.title;
        if (t.style != null) V.title.style = oneOf(t.style, ["card", "cover"], "title.style");
        if (t.dur != null) V.title.dur = +oneOf(t.dur, [2, 3, 4, 5], "title.dur");
        if (t.on != null) V.title.on = !!t.on;
        if (t.text != null) V.title.text = String(t.text).slice(0, 80);
        if (t.sub != null) V.title.sub = String(t.sub).slice(0, 80);
      }
      if (p.banner) {
        const b = p.banner;
        if (b.on != null) V.banner.on = !!b.on;
        if (b.text != null) V.banner.text = String(b.text).slice(0, 60);
        if (b.dur != null) V.banner.dur = +oneOf(b.dur, [0, 3, 5, 8], "banner.dur (0 = whole video)");
      }
      if (p.look) {
        const l = p.look;
        if (l.savedStyle != null) {
          const s = savedStyles().find(x => x.name === l.savedStyle);
          if (!s) throw new Error(`no saved style called ${l.savedStyle}; saved: ${savedStyles().map(x => x.name).join(", ") || "none"}`);
          applyStyle({ ...s, look: { ...s.look, theme: "saved:" + s.name } });
        }
        if (l.theme != null) V.look = lookOf(oneOf(l.theme, Object.keys(THEMES), "look.theme"));
        for (const k of ["bg", "ink", "accent", "hiBox", "hiInk"]) if (l[k] != null) {
          if (!/^#[0-9a-f]{6}$/i.test(l[k])) throw new Error(`look.${k} must be a colour like #1F1F1F`);
          V.look[k] = l[k].toUpperCase(); V.look.theme = "custom";
        }
        if (l.font != null) { V.look.font = oneOf(l.font, Object.keys(FONTS), "look.font"); V.look.theme = "custom"; }
        if (l.caps != null) V.look.caps = !!l.caps;
      }
      if (p.captionStyle) {
        const c = p.captionStyle;
        if (c.style != null) V.capLook.style = oneOf(c.style, ["bar", "bold", "box"], "captionStyle.style");
        if (c.size != null) V.capLook.size = oneOf(c.size, ["s", "m", "l"], "captionStyle.size");
        if (c.pos != null) V.capLook.pos = oneOf(c.pos, ["bottom", "middle"], "captionStyle.pos");
        if (c.burn != null) V.capLook.burn = !!c.burn;
      }
      if (p.shape != null) V.shape = oneOf(p.shape, Object.keys(SHAPES), "shape");
      if (p.fit != null) V.fit = oneOf(p.fit, ["fit", "fill"], "fit");
      if (p.music && V.music) {
        if (p.music.volume != null) V.music.vol = clamp(+p.music.volume, 0, 1);
        if (p.music.duck != null) V.music.duck = !!p.music.duck;
        soundRefresh();
      }
      let voice = false;
      if (p.enhance) {
        const e = p.enhance;
        if (e.noise != null) { V.enh.noise = +oneOf(e.noise, [0, 1, 2, 3], "enhance.noise"); voice = true; }
        if (e.level != null) { V.enh.level = !!e.level; voice = true; }
        for (const k of ["bright", "contrast", "sat", "warm"]) if (e[k] != null) V.enh[k] = clamp(Math.round(+e[k]), -50, 50);
      }
      if (p.transition) {
        const { into, type, dur = 0.6 } = p.transition;
        if (!Number.isInteger(into) || into < 1 || into >= V.clips.length) throw new Error("transition.into is the index of the clip it leads into, from 1 to " + (V.clips.length - 1));
        setTrans(into, { type: oneOf(type, Object.keys(TRANS), "transition.type"), dur: +oneOf(dur, [0.3, 0.6, 1], "transition.dur") });
      }
      syncForms(); lookChanged();
      if (voice) processVoices();
      return this.state();
    },
    addChapter(f = {}) { vSeek(timeArg(f.at, "at")); const ch = addChapterAtPlayhead(chapFields(f)); if (!ch) throw new Error($("#vStatus").textContent); return ch.id; },
    updateChapter(id, f) { Object.assign(chapById(id), chapFields(f)); chaptersChanged(); },
    removeChapter(id) { chapById(id); deleteChapter(id); },
    addCaption({ at, end, text = "" } = {}) {
      const t0 = timeArg(at, "at"), L = locate(t0 + 0.001), c = V.clips[L.i];
      if (!c) throw new Error("there's no clip at that time");
      const e = Math.min(c.out, L.s + Math.max(0.3, timeArg(end, "end") - t0)), cap = { id: V.nextId++, src: c.src, s: L.s, e, text: String(text) };
      V.caps.push(cap); capsChanged(); return cap.id;
    },
    editCaption(id, text) { capById(id).text = String(text); capsChanged(); },
    removeCaption(id) { capById(id); deleteCaption(id); },
    split(at) { vSeek(timeArg(at, "at")); const n = V.clips.length; splitAtPlayhead(); if (V.clips.length === n) throw new Error($("#vStatus").textContent); },
    removeClip(index) { if (!V.clips[index]) throw new Error(`no clip ${index}; there are ${V.clips.length}`); V.sel = index; deleteSelected(); },
    undo() { undoEdit(); }, redo() { redoEdit(); },
  },
};

// reopen in Video mode if that's where the last visit ended
try { if (localStorage.getItem("hookd-mode") === "video") setMode("video"); } catch (e) {}
syncForms();
updateUi();
vRestoreAll();
