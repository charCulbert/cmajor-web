# Cmajor Web

Loading and editing cmajor patches on the web, compiling them with the cmajor compiler directly in the browser.

## Features

- CodeMirror editor with Cmajor highlighting, diagnostics, completion, and optional Vim mode
- Cmajor wasm compiler running in a Worker
- AudioWorklet playback, parameters, MIDI, audio inputs, meters, and scope
- Sample-accurate MIDI delivery through `SharedArrayBuffer` when cross-origin isolation is available
- Project explorer, local-folder import, draft recovery, and compressed share links
- Direct loading from public GitHub repositories
- Loads all Cmajor example projects, including their UIs (where applicable)

## GitHub example

The repository includes a small polyphonic FM synth. You can open it in the web playground with the following link. This also demonstrates the link format for loading any GitHub repository into it.

- [Open the FM synth in Cmajor Web](https://charculbert.github.io/cmajor-web/#github=charCulbert%2Fcmajor-web&ref=main&path=examples%2Fsimple-fm)

## Compiler and license

The browser API binaries are Cmajor 1.0.3178 from [`cmajor-lang/docs` at `bf391fe`](https://github.com/cmajor-lang/docs/commit/bf391feddbf652835ad52c2514af7c8e0e5d4a6a). Matching source and official examples are pinned to [`cmajor-lang/cmajor` at `4ba0924`](https://github.com/cmajor-lang/cmajor/commit/4ba0924f3933d9650fb6a8f01f652a7236344604).

Cmajor and its official examples are copyright Cmajor Software Ltd. See the [Cmajor repository](https://github.com/cmajor-lang/cmajor) for its source and licensing terms.

Cmajor Web's original code is copyright © 2026 Charlie Culbert and licensed under GPL-3.0-or-later. See [COPYING](COPYING) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
