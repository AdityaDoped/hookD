# Security policy

Hookd runs entirely in the browser. It has no server, accounts or database, and songs and videos never leave the user's device.

## Reporting a problem

Please don't open a public issue for security problems. Instead, use GitHub's private reporting: go to the repo's **Security** tab and choose **Report a vulnerability**.

Useful things to include: what you found, the steps to reproduce it, and which browser you used.

## In scope

- The site at https://hookd-sage.vercel.app and the code in this repo
- Ways a page, file, link or saved project could run code or read data it shouldn't
- The `window.hookd` API the page offers to AI assistants

## How third-party code and models are loaded

- **Scripts in the page** (lamejs, mp4-muxer, webm-muxer) load from cdnjs and jsDelivr at exact versions with Subresource Integrity hashes.
- **Signalsmith Stretch** (key matching) is included in this repo under `vendor/`, unmodified, with its license.
- **Loaded on first use** (ONNX Runtime Web for vocal separation, Transformers.js for captions) come from jsDelivr at exact npm versions. Browsers can't check integrity hashes on these on-demand module imports, so they rely on npm versions being immutable and on the Content-Security-Policy in `vercel.json`, which only allows scripts from this site, jsDelivr and cdnjs.
- **AI models** come from Hugging Face, pinned to exact commits (`webnn/stem-separator`, `onnx-community/whisper-base` and `-small`). They are weights run by ONNX Runtime, not code.

Problems inside third-party libraries or models are best reported to their own projects.
