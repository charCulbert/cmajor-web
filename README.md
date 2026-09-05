# Cmajor Web

A simple, serverless Cmajor playground. Edit a patch, compile it in the browser, play it through AudioWorklet, and share it with a URL.

## Run

Requires Node.js 20.19 or newer.

```sh
npm install
npm run dev
```

Open <http://localhost:5173>.

```sh
npm test          # tests
npm run build     # production build
npm run preview   # preview the build
```

## Features

- CodeMirror editor with Cmajor highlighting, diagnostics, completion, and optional Vim mode
- Real Cmajor WebAssembly compiler running in a Worker
- AudioWorklet playback, parameters, MIDI, audio inputs, meters, and scope
- Sample-accurate MIDI through `SharedArrayBuffer` where cross-origin isolation is available
- Project explorer, local-folder import, draft recovery, and compressed share links
- Direct loading from public GitHub repositories and `.cmajorpatch` links
- All 27 official Cmajor example projects, including their custom UIs

There is no browser-ready Cmajor language server, so the editor provides lightweight completion plus diagnostics from the real compiler rather than claiming LSP support.

## GitHub example

The repository includes a small polyphonic FM synth:

- [Project folder](https://github.com/charCulbert/cmajor-web/tree/main/examples/simple-fm)
- [Patch manifest](https://github.com/charCulbert/cmajor-web/blob/main/examples/simple-fm/SimpleFMSynth.cmajorpatch)
- [Open from a local playground](http://localhost:5173/#github=charCulbert%2Fcmajor-web&ref=main&path=examples%2Fsimple-fm&manifest=examples%2Fsimple-fm%2FSimpleFMSynth.cmajorpatch)

GitHub imports are anonymous and therefore require a public repository. They never start audio automatically.

## Compiler and license

The browser API binaries are Cmajor 1.0.3178 from [`cmajor-lang/docs` at `bf391fe`](https://github.com/cmajor-lang/docs/commit/bf391feddbf652835ad52c2514af7c8e0e5d4a6a). Matching source and bundled examples are pinned to [`cmajor-lang/cmajor` at `4ba0924`](https://github.com/cmajor-lang/cmajor/commit/4ba0924f3933d9650fb6a8f01f652a7236344604). Rebuild them with upstream `tools/wasm_compiler/build.py`, targeting `public/cmaj_api` and version `1.0.3178`.

GPL-3.0-or-later. See [COPYING](COPYING) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
