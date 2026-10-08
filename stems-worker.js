/* ---------- Vocals and beat, separated on this device ----------
   Meta's HTDemucs v4 (MIT), as the ONNX export by the WebNN team
   (huggingface.co/webnn/stem-separator, MIT). The model holds only the inner
   network, so the spectrogram steps around it are done here, ported line for
   line from Demucs (pre_forward/post_forward in demucs4ht.py): the song is cut
   into 7.8 s windows at 44.1 kHz, each turned into a spectrogram, run through
   the model, and turned back into sound. Windows overlap by a quarter and are
   blended with triangular weights, as Demucs does.

   In:  { type: "run", left, right }  (Float32Array, 44.1 kHz)
   Out: { type: "download", loaded, total } | { type: "progress", p, device }
        | { type: "done", vocals: [L, R], beat: [L, R], device } | { type: "error", message } */

const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const MODEL = "https://huggingface.co/webnn/stem-separator/resolve/main/onnx/htdemucs_fwd.onnx";
const SR = 44100, SEG = 343980, NFFT = 4096, HL = 1024, BINS = 2048, LE = 336, PAD = 1536;
const SOURCES = 4, VOCALS = 3;   // drums, bass, other, vocals

/* ---------- FFT ---------- */
const rev = new Uint32Array(NFFT), cosT = new Float64Array(NFFT / 2), sinT = new Float64Array(NFFT / 2);
for (let i = 0, bits = Math.log2(NFFT); i < NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
for (let i = 0; i < NFFT / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / NFFT); sinT[i] = Math.sin(2 * Math.PI * i / NFFT); }
// in place; sign -1 forward, +1 inverse (unscaled)
function fft(re, im, sign) {
  for (let i = 0; i < NFFT; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1, step = NFFT / size;
    for (let i = 0; i < NFFT; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half, c = cosT[k], s = sign * sinT[k];
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}
const hann = new Float64Array(NFFT).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));   // torch.hann_window (periodic)

// torch's reflect padding: the samples either side mirrored, without repeating the edge
function reflectPad(x, l, r) {
  const n = x.length, out = new Float64Array(n + l + r);
  for (let i = 0; i < l; i++) out[i] = x[l - i];
  out.set(x, l);
  for (let j = 0; j < r; j++) out[n + l + j] = x[n - 2 - j];
  return out;
}

/* ---------- Spectrogram in (HTDemucs._spec + spectro) ----------
   Demucs pads by 3/4 of a hop, then torch.stft(center, reflect, normalized) adds
   NFFT/2 more; of the 340 frames, frames 2..337 and bins 0..2047 are kept. */
function spec(x, re, im, ch) {
  const p1 = reflectPad(x, PAD, PAD + LE * HL - SEG), p2 = reflectPad(p1, NFFT / 2, NFFT / 2);
  const fr = new Float64Array(NFFT), fi = new Float64Array(NFFT), scale = 1 / Math.sqrt(NFFT);
  for (let t = 0; t < LE; t++) {
    const s = (t + 2) * HL;
    for (let i = 0; i < NFFT; i++) { fr[i] = p2[s + i] * hann[i]; fi[i] = 0; }
    fft(fr, fi, -1);
    for (let f = 0; f < BINS; f++) { const o = (ch * BINS + f) * LE + t; re[o] = fr[f] * scale; im[o] = fi[f] * scale; }
  }
}

/* ---------- Spectrogram out (HTDemucs._ispec + ispectro) ----------
   The model's 2048 bins get the Nyquist bin back (zero) and two empty frames
   each side, then torch.istft(center, normalized) with window-sum normalisation. */
function ispec(getRe, getIm) {
  const frames = LE + 4, olaLen = NFFT + HL * (frames - 1), out = new Float64Array(olaLen), env = new Float64Array(olaLen);
  const fr = new Float64Array(NFFT), fi = new Float64Array(NFFT), scale = 1 / Math.sqrt(NFFT);
  for (let t = 0; t < frames; t++) {
    const s = t * HL, k = t - 2;
    for (let i = 0; i < NFFT; i++) env[s + i] += hann[i] * hann[i];
    if (k < 0 || k >= LE) continue;
    fr.fill(0); fi.fill(0);
    for (let f = 0; f < BINS; f++) { fr[f] = getRe(f, k); fi[f] = getIm(f, k); }
    for (let f = 1; f < NFFT / 2; f++) { fr[NFFT - f] = fr[f]; fi[NFFT - f] = -fi[f]; }   // a real signal's mirror half
    fi[0] = 0;   // irfft ignores the imaginary part of the DC bin
    fft(fr, fi, 1);
    for (let i = 0; i < NFFT; i++) out[s + i] += fr[i] * scale * hann[i];
  }
  const y = new Float32Array(SEG), start = NFFT / 2 + PAD;
  for (let i = 0; i < SEG; i++) { const e = env[start + i]; y[i] = e > 1e-11 ? out[start + i] / e : 0; }
  return y;
}

const meanStd = a => {
  let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length;
  let v = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - m; v += d * d; }
  return [m, Math.sqrt(v / (a.length - 1))];   // torch.std is unbiased
};

/* ---------- One 7.8 s window ---------- */
async function separate(session, ort, L, R) {
  // frequency branch input: complex-as-channels [L.re, L.im, R.re, R.im] x 2048 x 336
  const re = new Float64Array(2 * BINS * LE), im = new Float64Array(2 * BINS * LE);
  spec(L, re, im, 0); spec(R, re, im, 1);
  const x = new Float32Array(4 * BINS * LE);
  for (let c = 0; c < 2; c++) for (let j = 0; j < BINS * LE; j++) { x[(2 * c) * BINS * LE + j] = re[c * BINS * LE + j]; x[(2 * c + 1) * BINS * LE + j] = im[c * BINS * LE + j]; }
  const [mean, std] = meanStd(x);
  for (let i = 0; i < x.length; i++) x[i] = (x[i] - mean) / (1e-5 + std);
  // time branch input: the waveform, normalised the same way
  const xt = new Float32Array(2 * SEG); xt.set(L, 0); xt.set(R, SEG);
  const [meant, stdt] = meanStd(xt);
  for (let i = 0; i < xt.length; i++) xt[i] = (xt[i] - meant) / (1e-5 + stdt);

  const res = await session.run({ x: new ort.Tensor("float32", x, [1, 4, BINS, LE]), xt: new ort.Tensor("float32", xt, [1, 2, SEG]) });
  const xo = res.x_out.data, xto = res.xt_out.data;   // [1, 16, 2048, 336], [1, 8, 343980]
  const plane = BINS * LE;
  // each source's spectrogram: channels (L.re, L.im, R.re, R.im), de-normalised
  const at = (s, c, f, t) => xo[(s * 4 + c) * plane + f * LE + t] * std + mean;
  const stem = (pick, ch) => {
    const spectral = ispec((f, t) => pick.reduce((a, s) => a + at(s, 2 * ch, f, t), 0), (f, t) => pick.reduce((a, s) => a + at(s, 2 * ch + 1, f, t), 0));
    for (let i = 0; i < SEG; i++) spectral[i] += pick.reduce((a, s) => a + xto[(s * 2 + ch) * SEG + i] * stdt + meant, 0);
    return spectral;
  };
  // the beat is everything but the voice: drums + bass + other, as Demucs's two-stem mode does
  const beat = [0, 1, 2];
  return { vocals: [stem([VOCALS], 0), stem([VOCALS], 1)], beat: [stem(beat, 0), stem(beat, 1)] };
}

/* ---------- Model, downloaded once and kept ---------- */
async function fetchCached(url, onProgress) {
  const cache = await caches.open("hookd-models-v1").catch(() => null);
  const hit = cache && await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const r = await fetch(url);
  if (!r.ok) throw new Error(`couldn't download the separation model (${r.status})`);
  const total = +r.headers.get("content-length") || 0, reader = r.body.getReader(), parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  for (let o = 0, i = 0; i < parts.length; o += parts[i].length, i++) bytes.set(parts[i], o);
  if (cache) await cache.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

let ready = null;
function load() {
  if (!ready) ready = (async () => {
    const ort = await import(ORT + "ort.webgpu.min.mjs");
    ort.env.wasm.wasmPaths = ORT;
    const graph = await fetchCached(MODEL);
    const weights = await fetchCached(MODEL + ".data", (loaded, total) => postMessage({ type: "download", loaded, total }));
    const opts = name => ({ executionProviders: [name], graphOptimizationLevel: "all", externalData: [{ path: "htdemucs_fwd.onnx.data", data: weights }] });
    // the graphics card when the browser offers it (many times faster), the processor otherwise
    let session = null, device = "wasm";
    if (typeof navigator !== "undefined" && navigator.gpu) {
      try { session = await ort.InferenceSession.create(graph, opts("webgpu")); device = "webgpu"; } catch (e) { session = null; }
    }
    if (!session) session = await ort.InferenceSession.create(graph, opts("wasm"));
    return { ort, session, device };
  })().catch(e => { ready = null; throw e; });
  return ready;
}

onmessage = async e => {
  const d = e.data;
  if (d.type !== "run") return;
  try {
    const { ort, session, device } = await load();
    const n = d.left.length, stride = Math.floor(SEG * 0.75);
    const out = { vocals: [new Float32Array(n), new Float32Array(n)], beat: [new Float32Array(n), new Float32Array(n)] };
    const sum = new Float32Array(n);
    // triangular weights, highest in the middle of each window
    const w = new Float32Array(SEG);
    for (let i = 0; i < SEG; i++) w[i] = Math.min(i + 1, SEG - i) / Math.ceil(SEG / 2);
    const offsets = [];
    for (let o = 0; o < n; o += stride) offsets.push(o);
    for (let k = 0; k < offsets.length; k++) {
      const o = offsets[k], len = Math.min(SEG, n - o);
      // a short last window is filled out with the audio around it, centred (Demucs's
      // TensorChunk.padded), and only its own stretch of the result is kept
      const lead = (SEG - len) >> 1, from = o - lead;
      const L = new Float32Array(SEG), R = new Float32Array(SEG);
      const a = Math.max(0, from), b = Math.min(n, from + SEG);
      L.set(d.left.subarray(a, b), a - from); R.set(d.right.subarray(a, b), a - from);
      const r = await separate(session, ort, L, R);
      for (let i = 0; i < len; i++) {
        const wi = w[i], j = lead + i;
        out.vocals[0][o + i] += r.vocals[0][j] * wi; out.vocals[1][o + i] += r.vocals[1][j] * wi;
        out.beat[0][o + i] += r.beat[0][j] * wi; out.beat[1][o + i] += r.beat[1][j] * wi;
        sum[o + i] += wi;
      }
      postMessage({ type: "progress", p: (k + 1) / offsets.length, device });
    }
    for (const a of [...out.vocals, ...out.beat]) for (let i = 0; i < n; i++) a[i] /= sum[i];
    postMessage({ type: "done", vocals: out.vocals, beat: out.beat, device }, [...out.vocals, ...out.beat].map(a => a.buffer));
  } catch (err) {
    postMessage({ type: "error", message: (err && err.message) || String(err) });
  }
};
