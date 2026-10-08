# Hookd

**Mix the songs. Cut the video. Make it hit.**

Hookd is a free mashup maker, live DJ and video editor that runs right in your browser. Blend the best parts of your favourite songs, play them from pads like a DJ set, or edit videos with captions, chapters and music for Reels, Shorts and LinkedIn.

Your songs and videos never leave your device. Decoding, mixing, separating vocals, making captions and encoding all run in the browser, so nothing is uploaded and there's no server. Nothing you make ever gets a watermark.

**Live:** https://hookd-sage.vercel.app

## Build a mashup

- **Cut any song:** drag across a waveform to pick the part you want, or click to listen from any point. Audio and video files both work (MP3, M4A, WAV, MP4, WebM…).
- **Find the hook** picks the catchiest stretch of a song, cut on bar lines. **Auto mashup** finds every hook, orders the songs by tempo and picks the transitions.
- **Transitions:** crossfade, filter sweep, echo out, riser or hard cut, set per join.
- **Beat snap and tempo sync:** cut points land on the beat, and songs lock to each other's tempo during a blend.
- **Match keys:** detects each cut's key and tunes the next song by up to 3 semitones, without changing its speed, so blends sound in tune.
- **Vocals only / Beat only:** separates a song's voice from its music on your device (Meta's Demucs).
- **Vibes:** Original, Slowed + reverb, or Sped up.
- **Download** as MP3 320 or lossless WAV, or as a vertical or square MP4 with an animated visualizer.

## Live DJ

Every cut becomes a pad. Tap a pad (or press 1–9) to jump to it on the next beat with your chosen transition, and record your set.

## Edit a video

- **Cut and join** MP4 and MOV clips: split, trim, reorder, undo. Picture and sound are always cut at the same instant, so lip sync never drifts.
- **Captions:** automatic (Whisper, on your device), typed, or imported from .srt; three looks, burned in or saved as .srt.
- **Chapters, series banner and cover title**, styled by themes you can edit and save for a whole series.
- **Transitions, music** that dips under your voice, **noise reduction, even loudness** and colour.
- **Export** MP4 up to 4K, at Standard or Best quality.

## For AI assistants

[`llms.txt`](llms.txt) explains every control and the `window.hookd` API, so an AI assistant that drives the browser (such as Claude in Chrome) can help someone edit.

## Browser support

| | Chrome / Edge (desktop) | Chrome (Android) | Safari | Firefox |
|---|---|---|---|---|
| Build, play, Live DJ, MP3/WAV | ✅ | ✅ | ✅ | ✅ |
| Video editing and export, captions | ✅ | Usually | Depends on version | Depends on version |
| Vocals only / Beat only | ✅ fast with WebGPU | Slower | Depends on version | Slower |

Video export needs the WebCodecs API. Where a feature isn't available, its button is disabled with a note.

## Run it locally

It's a static site with no build step: `index.html` holds the page and styles, `app.js` the mashup and Live DJ, `video.js` the video editor, and `captions-worker.js` and `stems-worker.js` the on-device AI.

```sh
npx serve .
# or
python -m http.server
```

Then open the printed address. Saving your work needs a real `http://` address rather than opening the file from disk.

## Deploy

The repo deploys to [Vercel](https://vercel.com) as a static site with no settings: import the repo and deploy. Every push to `main` goes live. `vercel.json` sets security headers, including a Content-Security-Policy; if you add a script, font or download from somewhere new, add its origin there too. See [SECURITY.md](SECURITY.md) for how third-party code and models are loaded.

## Built with

- Web Audio, WebCodecs and WebGPU, all in the browser
- [lamejs](https://github.com/zhuker/lamejs) for MP3 (LGPL, loaded unmodified), [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [webm-muxer](https://github.com/Vanilagy/webm-muxer) (MIT)
- [Transformers.js](https://github.com/huggingface/transformers.js) running [Whisper](https://github.com/openai/whisper) for captions (Apache 2.0, MIT)
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) running Meta's [Demucs](https://github.com/facebookresearch/demucs) ([WebNN export](https://huggingface.co/webnn/stem-separator)) for vocal separation (MIT)
- [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) for key matching (MIT, in `vendor/`)
- Fonts from Google Fonts: Yatra One, Bricolage Grotesque, Hind and others (SIL Open Font License)

## License

The code is under the [MIT License](LICENSE). The libraries, models and fonts above keep their own licenses. Privacy, terms and copyright details are on the site at [/legal](https://hookd-sage.vercel.app/legal).

Please only use music and videos you have the right to use.
