// Speech to text for captions, off the page's main thread. Runs Whisper through
// Transformers.js; the model downloads once from Hugging Face and the browser
// keeps it. The video's sound never leaves the device.
// The self-contained build (the 'web' build imports onnxruntime by bare name, which needs a
// bundler), loaded on first use so a failure (offline, blocked) comes back as a message.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

// each model pinned to an exact version, so an update on Hugging Face can't change it unseen
const MODELS = {
  base: { id: "onnx-community/whisper-base", revision: "1846881b6b3a3024392c1eea3ad983695bc23925" },
  small: { id: "onnx-community/whisper-small", revision: "36050c46d777d46dc4b5f43f6d90574fc38f8732" },
};
let asr = null, loaded = "";

async function load(model, device) {
  const key = model + ":" + device;
  if (asr && loaded === key) return;
  let lib;
  try { lib = await import(LIB); }
  catch (e) { throw new Error("couldn't load the speech tools. Check your internet connection and try again"); }
  lib.env.allowLocalModels = false;
  // load ONNX Runtime straight from the CDN; its cache step rebuilds the loader as a
  // blob: script, which the site's security policy (rightly) refuses to run
  lib.env.useWasmCache = false;
  const files = new Map();
  asr = await lib.pipeline("automatic-speech-recognition", MODELS[model].id, {
    revision: MODELS[model].revision,
    device,
    dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
    progress_callback: p => {
      if (p.status !== "progress" || !p.total) return;
      files.set(p.file, p);
      let got = 0, all = 0;
      for (const f of files.values()) { got += f.loaded; all += f.total; }
      postMessage({ type: "download", loaded: got, total: all });
    },
  });
  loaded = key;
}

// pieces: [{ id, audio: Float32Array at 16 kHz }]; each piece is under 30 s.
async function run({ pieces, model, device, language }) {
  await load(model, device);
  postMessage({ type: "ready" });
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const out = await asr(p.audio, { task: "transcribe", language: language || null, return_timestamps: true });
    const chunks = (out.chunks || []).map(c => ({ s: c.timestamp[0], e: c.timestamp[1], text: c.text }));
    if (!chunks.length && out.text && out.text.trim()) chunks.push({ s: 0, e: null, text: out.text });
    postMessage({ type: "piece", id: p.id, index: i, count: pieces.length, chunks });
  }
  postMessage({ type: "done" });
}

onmessage = e => {
  if (e.data.type === "run") run(e.data).catch(err => postMessage({ type: "error", message: (err && err.message) || String(err) }));
};
