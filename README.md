# Cmajor Web

Loading and editing cmajor patches on the web, compiling them with the cmajor compiler directly on the web.

## Features

- CodeMirror editor with Cmajor highlighting, diagnostics, completion, and optional Vim mode
- Cmajor wasm compiler running in a Worker
- AudioWorklet playback, parameters, MIDI, audio inputs, meters, and scope
- Sample-accurate MIDI delivery through `SharedArrayBuffer` when cross-origin isolation is available
- Project explorer, local-folder import, draft recovery, and compressed share links
- Direct loading from public GitHub repositories
- Succesfully loads ll the Cmajor example projects, including their custom UIs

## GitHub example

The repository includes a small polyphonic FM synth:

- [Project folder](https://github.com/charCulbert/cmajor-web/tree/main/examples/simple-fm)
- [Patch manifest](https://github.com/charCulbert/cmajor-web/blob/main/examples/simple-fm/SimpleFMSynth.cmajorpatch)
- [Open from a local playground](http://localhost:5173/#github=charCulbert%2Fcmajor-web&ref=main&path=examples%2Fsimple-fm&manifest=examples%2Fsimple-fm%2FSimpleFMSynth.cmajorpatch)

## Compiler and license

The browser API binaries are Cmajor 1.0.3178 from [`cmajor-lang/docs` at `bf391fe`](https://github.com/cmajor-lang/docs/commit/bf391feddbf652835ad52c2514af7c8e0e5d4a6a). Matching source and bundled examples are pinned to [`cmajor-lang/cmajor` at `4ba0924`](https://github.com/cmajor-lang/cmajor/commit/4ba0924f3933d9650fb6a8f01f652a7236344604). Rebuild them with upstream `tools/wasm_compiler/build.py`, targeting `public/cmaj_api` and version `1.0.3178`.

GPL-3.0-or-later. See [COPYING](COPYING) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
