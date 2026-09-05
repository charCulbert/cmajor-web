# Cmajor Web

A focused, serverless Cmajor playground: edit Cmajor source files, compile them in a browser Worker, run the generated DSP in an AudioWorklet, adjust patch parameters, and share the project in a URL fragment.

## Run it

Requirements: Node.js 20.19 or newer and npm.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`.

Production build and local preview:

```sh
npm run build
npm run preview
```

Tests:

```sh
npm test
```

## What is included

- A VS Code-inspired, keyboard-accessible project explorer around CodeMirror 6. Files and nested folders can be created, renamed, deleted, or moved by dragging them onto a folder or the explorer root. Double-clicking empty explorer space creates a new item; a name ending in `/` creates a folder. Moves update manifest-relative paths without changing file contents. New `.cmajor` files are added to the active manifest's `source` list using their project-relative paths. Draft recovery and share links preserve complete text-only projects. The persisted explorer and editor/preview splitters support pointer dragging, arrow keys, Home/End, and double-click reset; on narrow screens they become horizontal splitters. Patch UIs and the scope can also open in movable, resizable Compost windows. The editor has high-contrast Cmajor highlighting, line numbers, indentation, bracket matching, search/replace, history, basic keyword/snippet completion, and an optional persisted Vim mode with working half-page `Ctrl-D`/`Ctrl-U` motions.
- Cmajor's real WebAssembly compiler running entirely in a dedicated browser Worker. Successful generated DSP runs through Cmajor's AudioWorklet helper; there is no compiler server and no precompiled audio fallback.
- Compiler diagnostics mapped to editor source positions. Persisted Auto-compile runs a whole-patch compile after one second of idle time, coalesces edits, skips hidden tabs and projects with over 512 KiB of source/manifest text, and never changes playback. Binary resources do not count toward that guard, so selecting an official example auto-compiles its code without repeatedly processing while the user edits. A failed or stale build cannot replace the last working patch.
- Compost knobs for discovered Cmajor parameter endpoints, plus a stereo Compost level meter and detachable triggered oscilloscope. The post-gain meter follows the WCLAP mixer scale: each bar is the latest per-channel sample peak over a 400-sample window, mapped across −90–+6 dB, with an orange region only for current levels above 0 dB. There is no peak-hold marker. Mono output is shown equally on L/R. The docked scope is a compact 3:2 tile; its free/rising/falling trigger modes, trigger level and position, sample count, amplitude scale, vertical offset, fine-grained 0–1 second phosphor persistence in 0.001-second steps, and freeze controls appear in a popup menu available only from its floating Compost window, so settings never reflow the scope.
- Patches with audio input endpoints get a source selector for a one-sample click impulse, a small touch/keyboard oscillator synth, an explicitly enabled audio input device, or a user-provided WAV file with play, stop, and loop. Device capture disables browser voice processing where supported, and all sources are disconnected on rebuild or Stop.
- Patches with MIDI input endpoints automatically open a resizable-range Compost keyboard and also show a compact keyboard plus Compost hardware MIDI input chooser in the preview. Z/X shift octaves without losing keyboard focus. In cross-origin-isolated browsers, keyboard and Web MIDI messages travel through a lock-free SharedArrayBuffer queue carrying timestamp-derived absolute audio frames; the worklet splits Cmajor rendering at each due event to apply it at the exact in-block sample. The upstream block-boundary message path remains the compatibility fallback.
- DSP CPU reports the Cmajor worklet's process time as a fraction of each 128-frame audio deadline. Its 0.1 EMA, 20,000-frame reporting interval, change threshold, and 80% warning follow Cmajor's VS Code host; it excludes compilation, UI, scope, the separate level-meter worklet, and other Web Audio nodes. When the AudioWorklet has no high-resolution clock, a dedicated Worker supplies a timestamp through `SharedArrayBuffer` for a short 2.5-second sample after each build, following the optional diagnostics technique used by WebCLAP's browser test host. The Worker is then terminated rather than consuming a core throughout playback.
- All 27 projects from Cmajor's upstream `examples/patches` tree, with their original names, source files, binary assets, workers, and custom UIs loaded through the standard `createPatchView(patchConnection)` entry point. Selecting one fetches its files directly from pinned Cmajor commit `4ba0924` on GitHub, then makes them available to the compiler and AudioWorklet through the browser's local project-file service. The repository also contains a byte-for-byte reproducible snapshot; run `npm run sync:cmajor-examples` to refresh it from that pinned revision.
- Output gain, explicit Stop/AudioContext cleanup, example patches with attribution, local draft recovery, and persisted preferences.
- Versioned gzip-compressed share links in `#code=…`, with UTF-8 handling and strict compressed/decompressed size limits. Shared links restore before local drafts and never auto-start audio.
- Public GitHub repositories, folders, and direct `.cmajorpatch` URLs can be opened without a backend. The browser discovers manifests through GitHub, asks which patch to open when there are several, and pins mutable branch links to the resolved commit in `#github=…&ref=…&manifest=…`. As in Cmajor Tools, the selected manifest—not every source file or sibling manifest—defines the patch. GitHub imports never auto-start audio. Anonymous GitHub API limits apply, and private repositories are not sent credentials.
- Individual `.cmajor` import/download plus complete project-folder import. **Open local project folder** uses the read-only File System Access API on supporting Chromium browsers and falls back to the standard folder picker on Safari, Firefox, and iPhone. Files and folders can also be dropped directly on the explorer. Folder import preserves relative filenames, the original `.cmajorpatch`, all source files, custom UI/worker modules, and binary resources. Those files are passed unchanged to the in-browser compiler; an in-memory same-origin project mount lets imported UIs and workers resolve their relative assets without a backend.

## GitHub import example

The repository includes a small polyphonic FM synth built with Cmajor's MIDI converter, voice allocator, note utilities, and envelope library. Use **Open GitHub project** and paste either the [project folder](https://github.com/charCulbert/cmajor-web/tree/main/examples/simple-fm) or the [direct patch manifest](https://github.com/charCulbert/cmajor-web/blob/main/examples/simple-fm/SimpleFMSynth.cmajorpatch). The direct fragment for a locally running playground is [open Simple FM Synth](http://localhost:5173/#github=charCulbert%2Fcmajor-web&ref=main&path=examples%2Fsimple-fm&manifest=examples%2Fsimple-fm%2FSimpleFMSynth.cmajorpatch).

## Language tooling

No genuine Cmajor LSP or browser-ready incremental language service was found in the upstream Cmajor repository. The official compiler exposes whole-patch compilation and printable diagnostics, but not completion, hover, definition, references, incremental parse, or a diagnostics-only build API. This app therefore provides syntax highlighting, small static completions/snippets, and actual compiler diagnostics; it does **not** claim LSP support. Auto-compile must perform full code generation internally, so its result omits generated code and the UI applies the safeguards above to keep CPU use bounded.

## Browser requirements and limits

Use a current Chromium, Firefox, or Safari with WebAssembly, module Workers, AudioWorklet, service workers, Cache Storage, `CompressionStream`, and `DecompressionStream`. Audio starts only from **Build & Play**, which is a user gesture. The initial compiler download is about 28 MB before HTTP compression/cache. If a local folder or GitHub location contains multiple `.cmajorpatch` files, the playground asks which manifest to open. Imported binary projects remain available for the current tab but are not copied into localStorage or compressed `#code` shares. This avoids silently dropping files and keeps large binary assets out of URLs.

The Cmajor helper's parameter messages use its existing MessagePort transport. Shared memory is limited to the bounded MIDI event queue and short-lived diagnostics clock described above; the playground does not add a sequencer, graph-wide event protocol, or WCLAP runtime. A production server must preserve the included COOP/COEP headers for sample-accurate MIDI and the high-resolution CPU sample. Playback falls back to block-boundary MIDI and coarse/no CPU timing without cross-origin isolation.

## Licensing and compiler source

cmajor-web is prepared for release under GPL-3.0-or-later; see [COPYING](COPYING). Dependency and bundled-example attributions are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The files under `public/cmaj_api/` come from the official `cmajor-lang/docs` browser API snapshot at commit [`bf391fe`](https://github.com/cmajor-lang/docs/commit/bf391feddbf652835ad52c2514af7c8e0e5d4a6a), identified upstream as Cmajor 1.0.3178. The corresponding Cmajor source and bundled examples are pinned to [`4ba0924`](https://github.com/cmajor-lang/cmajor/commit/4ba0924f3933d9650fb6a8f01f652a7236344604).

```text
10c451d683728261f087f7f19cc01d70eb348645d2541af13217c5c227993a8c  public/cmaj_api/cmaj-compiler-wasm.js
ce32053dd0a8213e0d55e6116b8c75095ac09e40e49fcf7bbf02bab134db8844  public/cmaj_api/cmaj-compiler-wasm.wasm
```

`cmaj-embedded-compiler-worker.js` removes the upstream adapter's DOM-only playback import so the unchanged compiler ABI can run in a module Worker. `cmaj-audio-worklet-helper.js` retains upstream playback with documented additions for Cmajor-style CPU monitoring and WCLAP-derived sample-accurate MIDI scheduling. To rebuild the compiler assets, check out Cmajor at the pinned source revision with submodules, activate a pinned Emscripten SDK, install `rjsmin`, and run:

```sh
python3 tools/wasm_compiler/build.py \
  --target /absolute/path/to/cmajor-web/public/cmaj_api \
  --version 1.0.3178
```

Reapply the Worker-only adapter change and update the checksums after rebuilding. Upstream's build script does not pin Emscripten, CMake, Ninja, Python, or `rjsmin`, so a byte-for-byte rebuild additionally requires pinning those tools.

## Verification summary

- `npm test`: 21 tests cover timestamp/frame mapping, stepped clocks, suspend/resume, long-term skew, GitHub imports, metering, Unicode sharing, malformed payloads, and compressed/decompressed size limits.
- Cmajor CLI 1.0.3175: 185 upstream sine, gain, arithmetic, control-flow, and library tests passed with no failures.
- Browser audio: editing a 220 Hz source to 440 Hz changed captured AudioWorklet samples from 5 to 10 positive crossings per 1,024 frames. Native and browser 220 Hz renders had matching 1,024-frame crossing estimates and peak magnitudes within `3e-8`.
- Browser workflows exercised successful and failed compilation, retention of the previous working preview, repeated Build/Stop cleanup, Vim motions, project import, GitHub restoration, custom patch UIs, parameter controls, MIDI, audio inputs, share links, and all 27 upstream example manifests. Exact-frame MIDI probes covered out-of-order targets, same-frame FIFO ordering, offsets 127/128, and late-event clamping.
- The production build was tested at desktop and 390 × 844 mobile dimensions. SineSynth and 808 both recovered from an Auto-compile/Build race and produced measured AudioWorklet output. Physical iPhone Safari, microphone hardware, and audible device output remain real-device checks.

Representative warm-build medians from the same machine are included for orientation, not as cross-device benchmarks:

| Official patch | Browser Worker compile | AudioWorklet start | Native `webaudio-html` export |
| --- | ---: | ---: | ---: |
| SineSynth | 1,422 ms | 19 ms | 910 ms |
| Tremolo | 1,087 ms | 29 ms | 810 ms |
| Freeverb CustomGUI | 1,208 ms | 18 ms | 500 ms |

The browser compiler and native CLI were adjacent releases, so these are behavioral and practical performance comparisons rather than bit-identical same-build results.
