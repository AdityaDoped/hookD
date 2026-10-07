# Hookd

**Find the hook, drop the mashup.**

Hookd makes song mashups right in your browser. Drop in a few songs, let it find the best part of each, blend them with DJ-style transitions, and download the result as an MP3 or as a video for Reels and WhatsApp Status. You can also play your songs live from pads, like a DJ set.

Your songs never leave your device. Everything, including decoding, mixing and encoding, runs in the browser, so nothing is uploaded and there's no server.

**Live:** https://hookd-sage.vercel.app

## Features

- **Cut any song:** drag across a waveform to pick the part you want, or click to listen from any point. Audio and video files both work (MP3, M4A, WAV, MP4, WebM…).
- **Find the hook:** one tap picks the catchiest-sounding stretch of a song, cut on bar lines.
- **Auto mashup:** finds every hook, orders the songs by tempo and picks the transitions for you.
- **Transitions:** crossfade, filter sweep, echo out, riser or hard cut, set per join.
- **Beat snap and tempo sync:** the tempo of each song is detected, cut points land on the beat, and songs lock to each other's tempo during a blend.
- **Vibes:** Original, Slowed + reverb, or Sped up.
- **Live DJ:** every cut becomes a pad. Tap a pad (or press 1–9) to jump to it on the next beat, and record your set.
- **Export:** MP3 audio, or a vertical or square MP4 video with an animated visualizer.
- **Remembers your work:** songs and settings are saved in your browser, so a refresh doesn't lose anything.
- **Works on phones:** includes a touch layout and a bottom play bar.

## Browser support

| | Chrome / Edge (desktop) | Chrome (Android) | Safari (iPhone / Mac) | Firefox |
|---|---|---|---|---|
| Build, play, Live DJ | ✅ | ✅ | ✅ | ✅ |
| MP3 export | ✅ | ✅ | ✅ | ✅ |
| Video export | ✅ | Usually | Depends on version | Depends on version |

Video export needs the WebCodecs API. Where it isn't available, the button is disabled with a note.

## Run it locally

It's a static site with no build step. `index.html` holds the page and styles, and `app.js` holds the app.

```sh
npx serve .
# or
python -m http.server
```

Then open the printed address. Opening `index.html` directly from disk mostly works, but saving your session needs a real `http://` address.

## Deploy

The repo deploys to [Vercel](https://vercel.com) as a static site with no settings: go to **Add New → Project**, import this repo, and deploy. Every push to `main` goes live, and every branch or pull request gets its own preview URL. `vercel.json` adds security headers, including a Content-Security-Policy that only allows scripts from this site and the two pinned CDNs. If you add a script or font from somewhere new, add its origin there too.

## Built with

- Web Audio API for playback and offline mixing, and WebCodecs for fast encoding
- [lamejs](https://github.com/zhuker/lamejs) for MP3 encoding (LGPL, loaded unmodified from cdnjs)
- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [webm-muxer](https://github.com/Vanilagy/webm-muxer) for video files (MIT)
- Fonts: Yatra One, Figtree and JetBrains Mono from Google Fonts

## License

The code is under the [MIT License](LICENSE). The libraries and fonts above keep their own licenses. Privacy, terms and copyright details are on the site at [/legal](https://hookd-sage.vercel.app/legal), and security reports go through [SECURITY.md](SECURITY.md).

Please only mash up music you have the right to use.
