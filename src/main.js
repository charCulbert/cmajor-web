import { basicSetup } from "codemirror";
import { autocompletion, completeFromList } from "@codemirror/autocomplete";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import "compost/components/compost-knob";
import "compost/components/compost-meter";
import "compost/components/compost-midi";
import "compost/components/compost-number-box";
import "compost/components/compost-piano";
import "compost/components/compost-scope";
import "compost/components/compost-window";
import { examples, manifestFor } from "./examples.js";
import {
  discoverGitHubProject,
  downloadGitHubPatch,
  githubProjectFragment,
  githubProjectFromFragment,
  parseGitHubProject,
} from "./github-project.js";
import { createMeterChannel, setChannelMinMax } from "./metering.js";
import { decodeProject, encodeProject, MAX_SOURCE_BYTES } from "./share.js";
import "./style.css";

const audioHelperURL = new URL("/cmaj_api/cmaj-audio-worklet-helper.js", window.location.href).href;
const { AudioWorkletPatchConnection } = await import(/* @vite-ignore */ audioHelperURL);
const projectFileService = "serviceWorker" in navigator
  ? navigator.serviceWorker.register("/project-files-sw.js").then(() => navigator.serviceWorker.ready).catch(() => null)
  : Promise.resolve(null);

const DRAFT_KEY = "cmajor-web:draft:v1";
const PREFS_KEY = "cmajor-web:preferences:v1";
const THEME_KEY = "cmajor-web:theme";
let compiler = null;
const compilerRequests = new Map();
const COMPILER_TIMEOUT = 120000;
const vimCompartment = new Compartment();
const editableCompartment = new Compartment();
const AUTO_CHECK_DELAY = 1000;
const AUTO_CHECK_SOURCE_LIMIT = 512 * 1024;
const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
const PROJECT_DRAG_TYPE = "application/x-cmajor-project-path";
let requestID = 0;
let checkID = 0;
let sourceRevision = 0;
let diagnosticEpoch = 0;
let activeConnection = null;
let audioContext = null;
let outputGain = null;
let analyser = null;
let meterFrame = 0;
let meterTimer = 0;
let outputMeterNode = null;
let meterChannels = [createMeterChannel(), createMeterChannel()];
let cpuTimerBuffer = null;
let cpuTimerWorker = null;
let cpuTimerStopTimeout = 0;
let cpuSampleReceived = false;
let cpuSampleComplete = false;
let draftTimer = 0;
let autoCheckTimer = 0;
let autoCheckRunning = false;
let autoCheckPending = false;
let lastCheckedSource = null;
let additionalSourceFiles = [];
let manifestPath = "main.cmajorpatch";
let manifestDoc = null;
let projectAssetFiles = [];
let projectFolders = [];
let projectResourceRoot = null;
let midiInputTarget = null;
let audioInputTarget = null;
let mediaInputStream = null;
let mediaInputNode = null;
let wavBuffer = null;
let wavSource = null;
const synthVoices = new Map();
let patchViewResizeObserver = null;
let resizePatchView = null;
let exampleLoadID = 0;
let pendingExplorerEdit = null;
let explorerContextTarget = null;
let githubShareURL = "";
let githubShareRevision = -1;

const preferences = {
  vim: false,
  autoCheck: true,
  volume: 0.7,
  scopeSize: 1024,
  scopeRange: 0.25,
  scopeTrigger: "free",
  scopeTriggerLevel: 0,
  scopeTriggerPosition: 0.25,
  scopeOffset: 0,
  scopePersistence: 0.5,
  midiRoot: 48,
  explorerWidth: 165,
  explorerHeight: 99,
  previewWidth: 341,
  workspaceHeight: 490,
  ...loadJSON(PREFS_KEY, {}),
};
preferences.scopePersistence = Math.min(1, Math.max(0, Number(preferences.scopePersistence) || 0));
preferences.midiRoot = Math.min(91, Math.max(0, Number(preferences.midiRoot) || 48));

document.querySelector("#app").innerHTML = `
  <header class="topbar">
    <div class="toolbar">
      <label class="example-label"><span class="visually-hidden">Examples</span>
        <select id="examples"></select>
      </label>
      <button id="build" class="primary"><span class="play-icon">▶</span> Build &amp; Play</button>
      <button id="stop" disabled>■ Stop</button>
      <label class="volume">Output <input id="volume" type="range" min="0" max="1" step="0.01" value="${preferences.volume}"><span id="volume-value">${Math.round(preferences.volume * 100)}%</span></label>
      <button id="share">Share link</button>
      <button class="theme-toggle" id="theme" type="button" aria-pressed="false" aria-label="Switch to light theme" title="Light theme">
        <svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><path d="M6 1.5a4.5 4.5 0 0 1 0 9z"/></svg>
      </button>
    </div>
  </header>
  <main id="main-layout">
    <section class="workspace" aria-label="Code editor">
      <div class="editor-header">
        <span><span class="status-dot"></span><span id="active-file-name">main.cmajor</span></span>
        <div class="editor-toggles">
          <label><input id="auto-check" type="checkbox" ${preferences.autoCheck ? "checked" : ""}> Auto-compile</label>
          <label><input id="vim" type="checkbox" ${preferences.vim ? "checked" : ""}> Vim mode</label>
        </div>
      </div>
      <div class="editor-body">
        <details class="project-explorer" open>
          <summary>Explorer</summary>
          <div class="explorer-actions">
            <button id="new-file" type="button" aria-label="New file" title="New file"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M8 7v5M5.5 9.5h5"/></svg></button>
            <button id="new-folder" type="button" aria-label="New folder" title="New folder"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h5l1.5 2h6.5v8h-13zM8 7v5M5.5 9.5h5"/></svg></button>
            <button id="more" type="button" aria-label="Open or import local files" aria-expanded="false" aria-controls="file-actions" title="Open or import local files">•••</button>
            <div id="file-actions" class="file-actions" hidden>
              <button id="download">Download current file</button>
              <button id="import">Import one file…</button>
              <button id="import-project">Open local project folder…</button>
              <button id="open-github">Open GitHub project…</button>
              <small>Files and folders can also be dropped onto Explorer.</small>
              <input id="file-input" type="file" accept=".cmajor,.txt,application/json" hidden>
              <input id="project-input" type="file" webkitdirectory multiple hidden>
            </div>
          </div>
          <nav id="file-tree" aria-label="Project files"></nav>
        </details>
        <div id="explorer-resizer" class="explorer-resizer" role="separator" aria-label="Resize project explorer" tabindex="0"></div>
        <div id="editor"></div>
      </div>
      <div class="editor-footer"><span id="cursor-position">Ln 1, Col 1</span><span id="check-state" class="visually-hidden" role="status">${preferences.autoCheck ? "Auto-compile ready" : "Auto-compile off"}</span><span id="draft-state" class="visually-hidden">Draft saved locally</span></div>
    </section>
    <div id="preview-resizer" class="preview-resizer" role="separator" aria-label="Resize patch preview" tabindex="0"></div>
    <aside class="preview" aria-label="Patch preview">
      <div class="preview-heading"><h1 id="patch-name">Sine tone</h1><span id="audio-state" class="pill">Stopped</span></div>
      <p id="attribution" class="attribution"></p>
      <section id="audio-input" class="audio-input" aria-label="Audio input source" hidden>
        <div class="input-source-header">
          <label>Audio input
            <select id="audio-source">
              <option value="impulse">Click impulse</option>
              <option value="synth">Test synth</option>
              <option value="device">Input device</option>
              <option value="wav">WAV file</option>
            </select>
          </label>
          <span id="audio-input-channels"></span>
        </div>
        <div id="impulse-controls" class="input-source-controls"><button id="fire-impulse" type="button">Send click impulse</button><span>Full-scale, one sample</span></div>
        <div id="synth-controls" class="input-source-controls" hidden>
          <label>Waveform <select id="synth-waveform"><option>sine</option><option>triangle</option><option>sawtooth</option><option>square</option></select></label>
          <compost-piano id="synth-piano" root-note="48" note-count="25" inline></compost-piano>
        </div>
        <div id="device-controls" class="input-source-controls" hidden>
          <label>Device <select id="audio-device"><option value="">Default audio input</option></select></label>
          <button id="enable-audio-input" type="button">Enable input</button>
        </div>
        <div id="wav-controls" class="input-source-controls" hidden>
          <input id="wav-input" type="file" accept=".wav,audio/wav,audio/x-wav">
          <button id="play-wav" type="button" disabled>Play WAV</button>
          <button id="stop-wav" type="button" disabled>Stop</button>
          <label><input id="loop-wav" type="checkbox"> Loop</label>
        </div>
        <div id="input-status" class="input-status" role="status">Choose a source for this patch's audio input.</div>
      </section>
      <section id="midi-input" class="midi-input tool-launcher" aria-label="MIDI input" hidden>
        <compost-piano id="docked-midi-piano" root-note="48" note-count="13" inline aria-label="Compact MIDI keyboard"></compost-piano>
        <div class="midi-tools"><compost-midi id="midi-device" input-only aria-label="Hardware MIDI input"></compost-midi><button id="open-keyboard" type="button" aria-controls="keyboard-window">Open keyboard</button></div>
      </section>
      <section class="patch-controls" aria-label="Plugin controls">
        <button id="open-plugin" type="button" aria-controls="patch-window" disabled>Open plugin</button>
        <div id="parameters-home"><div id="parameters" class="parameters" role="tabpanel" aria-label="Plugin parameters"><p class="empty">Build the patch to discover its parameters.</p></div></div>
      </section>
      <div class="output-tools" aria-label="Output analysis">
        <section class="meter-tool analysis-card" aria-label="Output meters">
          <div class="analysis-card-heading"><strong>Levels</strong><button id="float-meter" type="button" aria-controls="meter-window" aria-label="Open output meters" title="Open output meters">↗</button></div>
          <div id="docked-meter" class="meter-host">
            <div id="meter-panel" class="meter-card">
              <compost-meter id="meter" min="-90" max="6" curve="gain" aria-label="Stereo output level"></compost-meter>
              <div id="cpu-meter" class="cpu-meter" role="meter" aria-label="Cmajor DSP callback time" title="Cmajor DSP process time as a percentage of the 128-frame audio callback deadline. Host UI, meter and scope work are excluded." aria-valuemin="0" aria-valuemax="100">
                <div><span>CPU</span><output id="cpu-level">—</output></div>
                <div class="cpu-track"><i id="cpu-bar"></i></div>
              </div>
            </div>
          </div>
          <p id="meter-placeholder" class="tool-placeholder" hidden>Meters open in floating window.</p>
        </section>
        <section class="scope-card analysis-card" aria-label="Output oscilloscope">
          <div class="analysis-card-heading">
            <strong>Scope</strong><span id="scope-duration" class="visually-hidden"></span><button id="float-scope" type="button" aria-controls="scope-window" aria-label="Open output scope" title="Open output scope">↗</button>
          </div>
          <div id="docked-scope" class="scope-host">
            <div id="scope-panel" class="scope-panel">
              <div class="scope-settings">
                <button id="scope-settings-toggle" type="button" aria-expanded="false" aria-controls="scope-settings-menu">Scope settings</button>
                <div id="scope-settings-menu" class="scope-controls" hidden>
            <label>Trigger
              <select id="scope-trigger">
                <option value="free">Free</option>
                <option value="rising">Rising</option>
                <option value="falling">Falling</option>
              </select>
            </label>
            <label>Level <compost-number-box id="scope-trigger-level" min="-1" max="1" step="0.01" reset-value="0" display-fraction-digits="2" aria-label="Scope trigger level"></compost-number-box></label>
            <label>Position
              <select id="scope-trigger-position">
                <option value="0.1">10%</option>
                <option value="0.25">25%</option>
                <option value="0.5">50%</option>
                <option value="0.75">75%</option>
              </select>
            </label>
            <label>Samples
              <select id="scope-size">
                <option value="256">256</option>
                <option value="512">512</option>
                <option value="1024">1024</option>
                <option value="2048">2048</option>
                <option value="4096">4096</option>
              </select>
            </label>
            <label>Scale
              <select id="scope-range">
                <option value="0.1">±0.1</option>
                <option value="0.25">±0.25</option>
                <option value="0.5">±0.5</option>
                <option value="1">±1.0</option>
              </select>
            </label>
            <label>Offset <compost-number-box id="scope-offset" min="-1" max="1" step="0.01" reset-value="0" display-fraction-digits="2" aria-label="Scope vertical offset"></compost-number-box></label>
            <label>Persist <compost-number-box id="scope-persistence" min="0" max="1" step="0.001" value="${preferences.scopePersistence}" reset-value="0.5" display-fraction-digits="3" unit="s" aria-label="Scope persistence"></compost-number-box></label>
            <button id="scope-freeze" type="button" aria-pressed="false">Freeze</button>
                </div>
              </div>
              <div class="scope-stage"><canvas id="scope-persistence-canvas" aria-hidden="true"></canvas><compost-scope id="scope" value-range="${preferences.scopeRange}" y-markers="0" aria-label="Live patch output waveform"></compost-scope></div>
            </div>
          </div>
          <p id="scope-placeholder" class="scope-placeholder" hidden>Scope open in floating window.</p>
        </section>
      </div>
      <section class="diagnostics" aria-live="polite">
        <span id="compiler-version" class="visually-hidden"></span>
        <div id="diagnostic-output" class="diagnostic-output success" hidden><strong>Ready.</strong><span>Press Build &amp; Play to compile in your browser.</span></div>
      </section>
    </aside>
  </main>
  <compost-window id="patch-window" heading="Patch UI" x="24" y="24">
    <div slot="controls" class="patch-window-tabs" role="tablist" aria-label="Floating patch view"><button id="floating-ui-tab" type="button" role="tab" aria-selected="true">UI</button><button id="floating-params-tab" type="button" role="tab" aria-selected="false">Params</button></div>
    <div id="floating-view" class="patch-view-host"></div>
  </compost-window>
  <compost-window id="keyboard-window" heading="Keyboard" x="230" y="560" width="560" height="120" min-width="200" min-height="90" resizable="none">
    <span slot="title" class="keyboard-title"><b>Keyboard</b><span id="midi-octave-label">C3 · 37 notes</span><button id="midi-octave-down" type="button" aria-label="Keyboard down one octave" title="Octave down (Z)">−12</button><button id="midi-octave-up" type="button" aria-label="Keyboard up one octave" title="Octave up (X)">+12</button></span>
    <div id="floating-keyboard" class="floating-keyboard"><compost-piano id="midi-piano" root-note="48" note-count="37" inline></compost-piano><div class="keyboard-grip left" aria-hidden="true"></div><div class="keyboard-grip right" aria-hidden="true"></div></div>
  </compost-window>
  <compost-window id="meter-window" heading="Output meters" x="48" y="48" width="180" height="300" min-width="100" min-height="120"><div id="floating-meter" class="meter-host"></div></compost-window>
  <compost-window id="scope-window" heading="Output scope" x="24" y="24" min-width="0" min-height="0"><div id="floating-scope" class="scope-host"></div></compost-window>
  <div id="explorer-context-menu" class="explorer-context-menu" role="menu" hidden>
    <button type="button" role="menuitem" data-action="new-file">New file</button>
    <button type="button" role="menuitem" data-action="new-folder">New folder</button>
    <button type="button" role="menuitem" data-action="rename">Rename</button>
    <button type="button" role="menuitem" data-action="delete" class="danger">Delete</button>
  </div>
  <dialog id="github-dialog" class="project-dialog">
    <form method="dialog">
      <header><h2 id="github-dialog-title">Open GitHub project</h2><button value="cancel" aria-label="Close">×</button></header>
      <div id="github-location-fields">
        <label>Public repository, folder, or manifest URL
          <input id="github-location" type="text" spellcheck="false" autocomplete="off" placeholder="https://github.com/owner/repository" required>
        </label>
        <p>GitHub projects are fetched in your browser. A branch is resolved to a commit so the resulting link always opens the same code.</p>
      </div>
      <div id="github-manifest-fields" hidden>
        <label>Patch manifest <select id="github-manifest"></select></label>
        <p>Like Cmajor Tools, this opens one explicit .cmajorpatch. Sibling patches are not merged into the build.</p>
      </div>
      <footer><button value="cancel">Cancel</button><button id="github-confirm" class="primary" value="confirm">Open</button></footer>
    </form>
  </dialog>
  <div id="toast" role="status" aria-live="polite"></div>`;

const elements = Object.fromEntries([
  "main-layout", "preview-resizer", "examples", "build", "stop", "volume", "volume-value", "share", "theme", "more", "file-actions", "download", "import", "import-project", "open-github", "file-input", "project-input", "github-dialog", "github-dialog-title", "github-location-fields", "github-location", "github-manifest-fields", "github-manifest", "github-confirm",
  "vim", "auto-check", "new-file", "new-folder", "active-file-name", "file-tree", "explorer-context-menu", "explorer-resizer", "cursor-position", "check-state", "draft-state", "patch-name", "audio-state", "attribution", "audio-input", "audio-source", "audio-input-channels", "impulse-controls", "fire-impulse", "synth-controls", "synth-waveform", "synth-piano", "device-controls", "audio-device", "enable-audio-input", "wav-controls", "wav-input", "play-wav", "stop-wav", "loop-wav", "input-status", "midi-input", "docked-midi-piano", "midi-device", "open-keyboard", "keyboard-window", "floating-keyboard", "midi-piano", "midi-octave-down", "midi-octave-up", "midi-octave-label", "open-plugin", "patch-window", "floating-ui-tab", "floating-params-tab", "floating-view", "parameters-home", "parameters", "float-meter", "docked-meter", "meter-panel", "meter-placeholder", "meter-window", "floating-meter", "meter", "cpu-meter", "cpu-level", "cpu-bar", "float-scope", "docked-scope", "scope-panel", "scope-placeholder", "scope-window", "floating-scope", "scope", "scope-settings-toggle", "scope-settings-menu", "scope-trigger", "scope-trigger-level", "scope-trigger-position", "scope-size", "scope-range", "scope-offset", "scope-persistence", "scope-persistence-canvas", "scope-freeze", "scope-duration", "compiler-version", "diagnostic-output", "toast",
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

elements.scopeSize.value = String(preferences.scopeSize);
elements.scopeRange.value = String(preferences.scopeRange);
elements.scopeTrigger.value = preferences.scopeTrigger;
elements.scopeTriggerLevel.value = String(preferences.scopeTriggerLevel);
elements.scopeTriggerPosition.value = String(preferences.scopeTriggerPosition);
elements.scopeOffset.value = String(preferences.scopeOffset);
elements.scopePersistence.value = String(preferences.scopePersistence);

const playgroundGroup = document.createElement("optgroup");
playgroundGroup.label = "Playground";
const projectGroup = document.createElement("optgroup");
projectGroup.label = "Projects";
const upstreamGroup = document.createElement("optgroup");
upstreamGroup.label = "Official Cmajor examples";
elements.examples.append(new Option("Examples", "", true, true));
for (const example of examples) {
  (example.group === "project" ? projectGroup : example.upstreamProject ? upstreamGroup : playgroundGroup).append(new Option(example.name, example.id));
}
elements.examples.append(playgroundGroup, projectGroup, upstreamGroup);

const initial = await loadInitialProject();
let activeExample = examples.find(({ id }) => id === initial.exampleID) || null;
let sourceDoc = initial.source;
additionalSourceFiles = initial.files || [];
manifestPath = initial.manifestPath || activeExample?.manifestPath || "main.cmajorpatch";
manifestDoc = initial.manifestDoc ?? activeExample?.manifestText ?? null;
let primaryProjectSourcePath = initial.primarySourcePath || firstManifestSourcePath(manifestDoc !== null ? JSON.parse(manifestDoc) : manifestFor(initial.name, activeExample));
projectAssetFiles = initial.assetFiles || [];
projectFolders = initial.folders || [];
let activeFile = null;
let switchingFile = false;
elements.patchName.textContent = initial.name;
elements.attribution.textContent = initial.attribution || "Shared or local project.";
elements.examples.value = "";
if (projectAssetFiles.length) {
  projectResourceRoot = await publishProjectFiles(compilerProjectFiles().map(({ path, content }) => ({
    path,
    bytes: typeof content === "string" ? new TextEncoder().encode(content) : content,
  })));
}

const cmajorLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { while (!stream.match("*/") && !stream.eol()) stream.next(); return "comment"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^\d+(?:\.\d+)?(?:f\d*)?/)) return "number";
    if (stream.match(/^(processor|graph|namespace|node|connection|input|output|stream|event|value|let|var|void|struct|if|else|for|loop|return|advance|const|using|import)\b/)) return "keyword";
    if (stream.match(/^(float(?:32|64)?|int(?:32|64)?|bool|string|wrap)\b/)) return "typeName";
    stream.next(); return null;
  },
});

const cmajorHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--code-keyword)" },
  { tag: tags.typeName, color: "var(--code-type)" },
  { tag: tags.string, color: "var(--code-string)" },
  { tag: tags.number, color: "var(--code-number)" },
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
]);

const completions = completeFromList([
  "processor", "graph", "namespace", "input", "output", "stream", "event", "value", "node", "connection", "advance()", "processor.frequency", "processor.period",
  { label: "processor", type: "keyword", apply: "processor Name [[ main ]]\n{\n    output stream float out;\n\n    void main()\n    {\n        loop { out <- 0.0f; advance(); }\n    }\n}" },
  { label: "parameter", type: "snippet", apply: 'input event float value [[ name: "Value", min: 0, max: 1, init: 0.5 ]];' },
]);

const editor = new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: sourceDoc,
    extensions: [
      basicSetup,
      cmajorLanguage,
      syntaxHighlighting(cmajorHighlightStyle),
      indentUnit.of("    "),
      autocompletion({ override: [completions] }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      Prec.highest(EditorView.domEventHandlers({
        keydown(event, view) {
          if (!preferences.vim || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !/^[du]$/i.test(event.key)) return false;
          const cm = getCM(view);
          if (!cm?.state.vim || cm.state.vim.insertMode || cm.state.vim.visualMode) return false;
          moveVimHalfPage(view, event.key.toLowerCase() === "d" ? 1 : -1);
          event.preventDefault();
          event.stopPropagation();
          return true;
        },
      })),
      vimCompartment.of(preferences.vim ? vim() : []),
      editableCompartment.of(EditorView.editable.of(true)),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        elements.cursorPosition.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
        if (update.docChanged && !switchingFile && activeFile?.editable) {
          const content = update.state.doc.toString();
          if (activeFile.type === "source" && activeFile.path === primarySourcePath()) sourceDoc = content;
          else if (activeFile.type === "source") {
            const sourceFile = additionalSourceFiles.find(({ path }) => path === activeFile.path);
            if (sourceFile) sourceFile.content = content;
          } else {
            const resource = projectAssetFiles.find(({ path }) => path === activeFile.path);
            if (resource) resource.content = content;
          }
          ++sourceRevision;
          elements.examples.value = "";
          elements.draftState.textContent = "Saving draft…";
          clearTimeout(draftTimer);
          draftTimer = setTimeout(saveDraft, 300);
          scheduleAutoCheck();
        }
      }),
    ],
  }),
});

function moveVimHalfPage(view, direction) {
  const scroller = view.scrollDOM;
  const selection = view.state.selection.main;
  const currentLine = view.state.doc.lineAt(selection.head);
  const lineCount = Math.max(1, Math.floor(scroller.clientHeight / view.defaultLineHeight / 2));
  const targetNumber = Math.max(1, Math.min(view.state.doc.lines, currentLine.number + direction * lineCount));
  const targetLine = view.state.doc.line(targetNumber);
  const target = targetLine.from + Math.min(selection.head - currentLine.from, targetLine.length);
  const targetScroll = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + direction * scroller.clientHeight / 2));
  view.dispatch({ selection: { anchor: target } });
  scroller.scrollTop = targetScroll;
}
renderFileTree();
setupExplorerResizer();
setupPreviewResizer();

elements.examples.addEventListener("change", async () => {
  const example = examples.find(({ id }) => id === elements.examples.value);
  if (!example) return;
  beginProjectLoad(example.name);
  try {
    if (example.upstreamProject) {
      await loadUpstreamExample(example);
      return;
    }
    activeExample = example;
    elements.patchName.textContent = example.name;
    elements.attribution.textContent = example.attribution;
    replaceSource(example.source);
    saveDraft();
    elements.audioState.textContent = activeConnection ? "Previous patch playing" : "Ready";
    showDiagnostic("success", `${example.name} loaded`, "Source is ready for in-browser compilation.");
  } finally {
    elements.examples.value = "";
  }
});

function beginProjectLoad(name) {
  ++exampleLoadID;
  clearCustomView();
  renderParameters([], null);
  renderMIDIInput(null, null);
  renderAudioInput([], null);
  if (elements.keyboardWindow.open) elements.keyboardWindow.close();
  if (elements.meterWindow.open) elements.meterWindow.close();
  if (elements.scopeWindow.open) elements.scopeWindow.close();
  elements.patchName.textContent = `Loading ${name}…`;
  elements.audioState.textContent = activeConnection ? "Previous patch playing" : "Loading";
  elements.audioState.classList.toggle("playing", Boolean(activeConnection));
  elements.openPlugin.disabled = true;
  showDiagnostic("busy", `Loading ${name}…`, "Closing the previous patch controls and loading the selected project.");
}

elements.vim.addEventListener("change", () => {
  preferences.vim = elements.vim.checked;
  savePreferences();
  editor.dispatch({ effects: vimCompartment.reconfigure(preferences.vim ? vim() : []) });
  editor.focus();
});

elements.autoCheck.addEventListener("change", () => {
  preferences.autoCheck = elements.autoCheck.checked;
  savePreferences();
  ++diagnosticEpoch;
  clearTimeout(autoCheckTimer);
  autoCheckPending = false;
  elements.checkState.textContent = preferences.autoCheck ? "Auto-compile ready" : "Auto-compile off";
  if (preferences.autoCheck) scheduleAutoCheck();
});

elements.newFile.addEventListener("click", () => beginExplorerEdit("file"));
elements.newFolder.addEventListener("click", () => beginExplorerEdit("folder"));
elements.fileTree.addEventListener("contextmenu", (event) => {
  if (event.target === elements.fileTree) openExplorerContextMenu(event, { kind: "folder", path: "" });
});
elements.fileTree.addEventListener("dblclick", (event) => {
  if (event.target.closest("button, summary, input")) return;
  event.preventDefault();
  beginExplorerEdit("file", event.target.closest(".explorer-folder")?.dataset.path || "");
});
elements.fileTree.addEventListener("dragover", (event) => acceptProjectDrop(event, ""));
elements.fileTree.addEventListener("dragleave", (event) => {
  if (!elements.fileTree.contains(event.relatedTarget)) elements.fileTree.classList.remove("project-drop-target");
});
elements.fileTree.addEventListener("drop", (event) => dropProjectItem(event, ""));
const explorer = document.querySelector(".project-explorer");
explorer.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.types || [])].includes(PROJECT_DRAG_TYPE)) return;
  if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  explorer.classList.add("drop-target");
});
explorer.addEventListener("dragleave", (event) => {
  if (!explorer.contains(event.relatedTarget)) explorer.classList.remove("drop-target");
});
explorer.addEventListener("drop", (event) => {
  if ([...(event.dataTransfer?.types || [])].includes(PROJECT_DRAG_TYPE)) return;
  event.preventDefault();
  explorer.classList.remove("drop-target");
  void importDroppedItems(event.dataTransfer);
});
elements.explorerContextMenu.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.action;
  if (!action) return;
  const target = explorerContextTarget;
  closeExplorerContextMenu();
  const targetParent = target?.path?.split("/").slice(0, -1).join("/") || "";
  const parent = action === "rename" ? targetParent : target?.kind === "folder" ? target.path : targetParent;
  if (action === "delete" && target) { void deleteProjectPath(target.path, target.kind === "folder"); return; }
  if (action === "new-file") beginExplorerEdit("file", parent);
  if (action === "new-folder") beginExplorerEdit("folder", parent);
  if (action === "rename" && target) beginExplorerEdit(target.kind, parent, target.path);
});
document.addEventListener("pointerdown", (event) => {
  if (!elements.explorerContextMenu.hidden && !elements.explorerContextMenu.contains(event.target)) closeExplorerContextMenu();
  if (!elements.fileActions.hidden && !elements.fileActions.contains(event.target) && event.target !== elements.more) {
    elements.fileActions.hidden = true;
    elements.more.setAttribute("aria-expanded", "false");
  }
  if (!elements.scopeSettingsMenu.hidden && !elements.scopeSettingsMenu.contains(event.target) && event.target !== elements.scopeSettingsToggle) closeScopeSettings();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeExplorerContextMenu();
  elements.fileActions.hidden = true;
  elements.more.setAttribute("aria-expanded", "false");
  closeScopeSettings();
});

elements.volume.addEventListener("input", () => {
  preferences.volume = Number(elements.volume.value);
  elements.volumeValue.textContent = `${Math.round(preferences.volume * 100)}%`;
  if (outputGain && audioContext) outputGain.gain.setTargetAtTime(preferences.volume, audioContext.currentTime, 0.01);
  savePreferences();
});

elements.scopeSize.addEventListener("change", () => {
  preferences.scopeSize = Number(elements.scopeSize.value);
  applyScopeSettings();
});
elements.scopeRange.addEventListener("change", () => {
  preferences.scopeRange = Number(elements.scopeRange.value);
  applyScopeSettings();
});
elements.scopeTrigger.addEventListener("change", () => { preferences.scopeTrigger = elements.scopeTrigger.value; applyScopeSettings(); });
elements.scopeTriggerLevel.addEventListener("parameter-edit", ({ detail }) => { preferences.scopeTriggerLevel = detail.value; applyScopeSettings(); });
elements.scopeTriggerPosition.addEventListener("change", () => { preferences.scopeTriggerPosition = Number(elements.scopeTriggerPosition.value); applyScopeSettings(); });
elements.scopeOffset.addEventListener("parameter-edit", ({ detail }) => { preferences.scopeOffset = detail.value; applyScopeSettings(); });
elements.scopePersistence.addEventListener("parameter-edit", ({ detail }) => { preferences.scopePersistence = Math.min(1, Math.max(0, detail.value)); applyScopeSettings(); });
elements.scopeSettingsToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  if (elements.scopeSettingsMenu.hidden) openScopeSettings();
  else closeScopeSettings();
});
elements.scopeFreeze.addEventListener("click", () => {
  const frozen = elements.scopeFreeze.getAttribute("aria-pressed") !== "true";
  if (frozen && elements.scope.samples.length) elements.scope.setSamples(elements.scope.samples, { copy: true });
  elements.scopeFreeze.setAttribute("aria-pressed", String(frozen));
  elements.scopeFreeze.textContent = frozen ? "Resume" : "Freeze";
});
elements.floatScope.addEventListener("click", openFloatingScope);
elements.scopeWindow.addEventListener("window-close", dockScope);
elements.floatMeter.addEventListener("click", openFloatingMeter);
elements.meterWindow.addEventListener("window-close", dockMeter);
elements.openKeyboard.addEventListener("click", openFloatingKeyboard);
elements.keyboardWindow.addEventListener("window-close", () => elements.midiPiano.allNotesOff());
elements.openPlugin.addEventListener("click", () => {
  if (elements.floatingView.querySelector(".patch-view-frame")) openFloatingPatchView();
  else openFloatingParameters();
});
elements.floatingUiTab.addEventListener("click", () => showFloatingPatchTab("ui"));
elements.floatingParamsTab.addEventListener("click", () => showFloatingPatchTab("params"));
elements.patchWindow.addEventListener("window-close", () => {
  dockParameters();
  elements.openPlugin.disabled = !activeConnection;
});
for (const piano of [elements.midiPiano, elements.dockedMidiPiano]) {
  piano.addEventListener("note-down", ({ detail }) => sendMIDIMessage(0x900000 | (detail.note << 8) | 100));
  piano.addEventListener("note-up", ({ detail }) => sendMIDIMessage(0x800000 | (detail.note << 8)));
}
elements.midiDevice.addEventListener("midi-input-selected", ({ detail }) => elements.midiDevice.selectInput(detail.id));
elements.midiDevice.addEventListener("midi-message", ({ detail }) => sendMIDIMessage(detail.message, detail.timestamp));
elements.midiOctaveDown.addEventListener("click", () => changeMIDIOctave(-12));
elements.midiOctaveUp.addEventListener("click", () => changeMIDIOctave(12));
elements.keyboardWindow.addEventListener("keydown", (event) => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key.toLowerCase() === "z") changeMIDIOctave(-12);
  else if (event.key.toLowerCase() === "x") changeMIDIOctave(12);
  else return;
  event.preventDefault(); event.stopPropagation();
});
for (const side of ["left", "right"]) {
  const grip = elements.floatingKeyboard.querySelector(`.keyboard-grip.${side}`);
  let drag = null;
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault(); event.stopPropagation();
    drag = { x: event.clientX, root: preferences.midiRoot, count: Number(elements.midiPiano.getAttribute("note-count")), right: elements.keyboardWindow.getBoundingClientRect().right };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const delta = Math.round((event.clientX - drag.x) / 20 * (12 / 7));
    if (side === "right") setKeyboardRange(drag.root, drag.count + delta);
    else {
      const top = drag.root + drag.count - 1;
      const root = Math.min(top - 12, Math.max(0, drag.root + delta));
      setKeyboardRange(root, top - root + 1, drag.right);
    }
  });
  const end = () => { drag = null; };
  grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end);
}
elements.audioSource.addEventListener("change", updateAudioInputMode);
elements.fireImpulse.addEventListener("click", fireImpulse);
elements.synthPiano.addEventListener("note-down", ({ detail }) => startSynthNote(detail.note));
elements.synthPiano.addEventListener("note-up", ({ detail }) => stopSynthNote(detail.note));
elements.audioDevice.addEventListener("change", () => { if (mediaInputStream) void enableDeviceInput(); });
elements.enableAudioInput.addEventListener("click", () => mediaInputStream ? disableDeviceInput() : void enableDeviceInput());
elements.wavInput.addEventListener("change", loadWavFile);
elements.playWav.addEventListener("click", playWav);
elements.stopWav.addEventListener("click", () => stopWav(true));

elements.build.addEventListener("click", buildAndPlay);
elements.stop.addEventListener("click", () => stopAudio(true));
elements.share.addEventListener("click", shareProject);
elements.theme.addEventListener("click", toggleTheme);
elements.more.addEventListener("click", () => {
  elements.fileActions.hidden = !elements.fileActions.hidden;
  elements.more.setAttribute("aria-expanded", String(!elements.fileActions.hidden));
  if (!elements.fileActions.hidden) {
    const bounds = elements.more.getBoundingClientRect();
    elements.fileActions.style.left = `${Math.max(8, Math.min(innerWidth - 200, bounds.right - 192))}px`;
    elements.fileActions.style.top = `${bounds.bottom + 4}px`;
  }
});
elements.download.addEventListener("click", downloadSource);
elements.import.addEventListener("click", () => elements.fileInput.click());
elements.importProject.addEventListener("click", openProjectFolder);
elements.openGithub.addEventListener("click", () => void requestGitHubProject());
elements.fileInput.addEventListener("change", importSource);
elements.projectInput.addEventListener("change", importProjectFolder);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && preferences.autoCheck && projectFingerprint() !== lastCheckedSource) scheduleAutoCheck();
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (!elements.audioInput.hidden) void populateAudioDevices(); });
window.addEventListener("resize", () => { applyExplorerSize(); applyPreviewSize(); closeScopeSettings(); });
window.addEventListener("beforeunload", () => { compiler?.terminate(); void stopAudio(false); });

renderMeter();
resetCPU();
elements.scope.setSamples(new Float32Array(2));
applyScopeSettings();
changeMIDIOctave(0);
paintTheme();
if (initial.githubProject) void openGitHubProject(initial.githubProject);

async function loadInitialProject() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const encoded = fragment.get("code");
  if (encoded) {
    try {
      const shared = await decodeProject(encoded);
      return { ...shared, attribution: "Restored from this share link." };
    } catch (error) {
      setTimeout(() => showDiagnostic("error", "Share link error", error.message), 0);
      return { ...examples[0], exampleID: examples[0].id };
    }
  }
  if (fragment.has("github")) {
    try {
      return { ...examples[0], exampleID: examples[0].id, githubProject: githubProjectFromFragment(fragment) };
    } catch (error) {
      setTimeout(() => showDiagnostic("error", "GitHub link error", error.message), 0);
      return { ...examples[0], exampleID: examples[0].id };
    }
  }
  const draft = loadJSON(DRAFT_KEY, null);
  if (draft && typeof draft.source === "string") {
    const files = Array.isArray(draft.files) ? draft.files.filter(isValidSourceFile) : [];
    const assetFiles = Array.isArray(draft.assetFiles)
      ? draft.assetFiles.filter((file) => file && typeof file.path === "string" && typeof file.content === "string")
      : [];
    return {
      source: draft.source,
      files,
      manifestPath: typeof draft.manifestPath === "string" ? draft.manifestPath : undefined,
      manifestDoc: typeof draft.manifestDoc === "string" ? draft.manifestDoc : null,
      primarySourcePath: typeof draft.primarySourcePath === "string" && isSafeProjectPath(draft.primarySourcePath) ? draft.primarySourcePath : undefined,
      assetFiles,
      folders: Array.isArray(draft.folders) ? draft.folders.filter((folder) => typeof folder === "string") : [],
      name: draft.name || "Recovered draft",
      attribution: "Automatically recovered from this browser.",
    };
  }
  return { ...examples[0], exampleID: examples[0].id };
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function savePreferences() { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); }

function setupExplorerResizer() {
  const editorBody = document.querySelector(".editor-body");
  let dragging = false;

  const updateFromPointer = (event) => {
    const bounds = editorBody.getBoundingClientRect();
    if (matchMedia("(max-width: 600px)").matches) preferences.explorerHeight = event.clientY - bounds.top;
    else preferences.explorerWidth = event.clientX - bounds.left;
    applyExplorerSize();
  };

  elements.explorerResizer.addEventListener("pointerdown", (event) => {
    dragging = true;
    elements.explorerResizer.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });
  elements.explorerResizer.addEventListener("pointermove", (event) => { if (dragging) updateFromPointer(event); });
  elements.explorerResizer.addEventListener("pointerup", () => { dragging = false; savePreferences(); });
  elements.explorerResizer.addEventListener("pointercancel", () => { dragging = false; });
  elements.explorerResizer.addEventListener("dblclick", () => {
    preferences.explorerWidth = 165;
    preferences.explorerHeight = 99;
    applyExplorerSize();
    savePreferences();
  });
  elements.explorerResizer.addEventListener("keydown", (event) => {
    const compact = matchMedia("(max-width: 600px)").matches;
    const backward = compact ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    const forward = compact ? event.key === "ArrowDown" : event.key === "ArrowRight";
    if (!backward && !forward && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    if (compact) preferences.explorerHeight = event.key === "Home" ? 70 : event.key === "End" ? 240 : preferences.explorerHeight + (forward ? step : -step);
    else preferences.explorerWidth = event.key === "Home" ? 110 : event.key === "End" ? 420 : preferences.explorerWidth + (forward ? step : -step);
    applyExplorerSize();
    savePreferences();
  });
  applyExplorerSize();
}

function applyExplorerSize() {
  const editorBody = document.querySelector(".editor-body");
  const compact = matchMedia("(max-width: 600px)").matches;
  const maximum = compact ? Math.max(70, Math.min(240, editorBody.clientHeight - 180)) : Math.max(110, Math.min(420, editorBody.clientWidth - 220));
  const minimum = compact ? 70 : 110;
  const preference = compact ? "explorerHeight" : "explorerWidth";
  preferences[preference] = Math.round(Math.min(maximum, Math.max(minimum, Number(preferences[preference]) || minimum)));
  editorBody.style.setProperty(compact ? "--explorer-height" : "--explorer-width", `${preferences[preference]}px`);
  elements.explorerResizer.setAttribute("aria-orientation", compact ? "horizontal" : "vertical");
  elements.explorerResizer.setAttribute("aria-valuemin", String(minimum));
  elements.explorerResizer.setAttribute("aria-valuemax", String(maximum));
  elements.explorerResizer.setAttribute("aria-valuenow", String(preferences[preference]));
  elements.explorerResizer.setAttribute("aria-valuetext", `${preferences[preference]} pixels`);
}

function setupPreviewResizer() {
  let dragging = false;
  const updateFromPointer = (event) => {
    const bounds = elements.mainLayout.getBoundingClientRect();
    if (matchMedia("(max-width: 900px)").matches) preferences.workspaceHeight = event.clientY - bounds.top;
    else preferences.previewWidth = bounds.right - event.clientX;
    applyPreviewSize();
  };
  elements.previewResizer.addEventListener("pointerdown", (event) => {
    dragging = true;
    elements.previewResizer.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });
  elements.previewResizer.addEventListener("pointermove", (event) => { if (dragging) updateFromPointer(event); });
  elements.previewResizer.addEventListener("pointerup", () => { dragging = false; savePreferences(); });
  elements.previewResizer.addEventListener("pointercancel", () => { dragging = false; });
  elements.previewResizer.addEventListener("dblclick", () => {
    preferences.previewWidth = 341;
    preferences.workspaceHeight = 490;
    applyPreviewSize();
    savePreferences();
  });
  elements.previewResizer.addEventListener("keydown", (event) => {
    const compact = matchMedia("(max-width: 900px)").matches;
    const backward = compact ? event.key === "ArrowUp" : event.key === "ArrowRight";
    const forward = compact ? event.key === "ArrowDown" : event.key === "ArrowLeft";
    if (!backward && !forward && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    if (compact) preferences.workspaceHeight = event.key === "Home" ? 390 : event.key === "End" ? 700 : preferences.workspaceHeight + (forward ? step : -step);
    else preferences.previewWidth = event.key === "Home" ? 280 : event.key === "End" ? 700 : preferences.previewWidth + (forward ? step : -step);
    applyPreviewSize();
    savePreferences();
  });
  applyPreviewSize();
}

function applyPreviewSize() {
  const compact = matchMedia("(max-width: 900px)").matches;
  const minimum = compact ? 390 : 280;
  const maximum = compact ? Math.max(minimum, Math.min(700, innerHeight - 100)) : Math.max(minimum, Math.min(700, elements.mainLayout.clientWidth - 500));
  const preference = compact ? "workspaceHeight" : "previewWidth";
  preferences[preference] = Math.round(Math.min(maximum, Math.max(minimum, Number(preferences[preference]) || minimum)));
  elements.mainLayout.style.setProperty(compact ? "--workspace-height" : "--preview-width", `${preferences[preference]}px`);
  elements.previewResizer.setAttribute("aria-orientation", compact ? "horizontal" : "vertical");
  elements.previewResizer.setAttribute("aria-valuemin", String(minimum));
  elements.previewResizer.setAttribute("aria-valuemax", String(maximum));
  elements.previewResizer.setAttribute("aria-valuenow", String(preferences[preference]));
  elements.previewResizer.setAttribute("aria-valuetext", `${preferences[preference]} pixels`);
}

function openFloatingMeter() {
  elements.floatingMeter.append(elements.meterPanel);
  elements.meterPlaceholder.hidden = false;
  elements.floatMeter.disabled = true;
  elements.meterWindow.removeAttribute("fullscreen");
  const compact = innerWidth <= 600;
  elements.meterWindow.setAttribute("width", String(compact ? Math.min(180, innerWidth - 32) : 180));
  elements.meterWindow.setAttribute("height", String(compact ? Math.min(300, innerHeight - 120) : 300));
  elements.meterWindow.setAttribute("x", String(compact ? 16 : 48));
  elements.meterWindow.setAttribute("y", String(compact ? 56 : 48));
  elements.meterWindow.open = true;
}

function dockMeter() {
  if (elements.meterPanel.parentElement !== elements.dockedMeter) elements.dockedMeter.append(elements.meterPanel);
  elements.meterPlaceholder.hidden = true;
  elements.floatMeter.disabled = false;
}

function openFloatingKeyboard() {
  elements.keyboardWindow.removeAttribute("fullscreen");
  const compact = innerWidth <= 600;
  setKeyboardRange(preferences.midiRoot, Number(elements.midiPiano.getAttribute("note-count")) || 37);
  elements.keyboardWindow.setAttribute("x", String(compact ? 8 : Math.max(16, Math.round((innerWidth - elements.keyboardWindow.contentSize.width) / 2))));
  elements.keyboardWindow.setAttribute("y", String(compact ? 56 : Math.max(40, innerHeight - 190)));
  elements.keyboardWindow.open = true;
  requestAnimationFrame(() => elements.midiPiano.focus({ preventScroll: true }));
}

function openFloatingPatchView() {
  const view = elements.floatingView.querySelector(".patch-view-frame");
  if (!view) return;
  elements.patchWindow.removeAttribute("fullscreen");
  const compact = innerWidth <= 600;
  const preferredWidth = Number(elements.patchWindow.dataset.preferredWidth);
  const preferredHeight = Number(elements.patchWindow.dataset.preferredHeight);
  const compactScale = Math.min(1, (innerWidth - 26) / preferredWidth);
  elements.patchWindow.setAttribute("width", String(compact ? innerWidth - 26 : preferredWidth));
  elements.patchWindow.setAttribute("height", String(compact ? Math.min(preferredHeight * compactScale, innerHeight - 120) : preferredHeight));
  elements.patchWindow.setAttribute("x", String(compact ? 12 : 24));
  elements.patchWindow.setAttribute("y", String(compact ? 56 : 24));
  elements.patchWindow.open = true;
  showFloatingPatchTab("ui");
  elements.openPlugin.disabled = true;
  requestAnimationFrame(() => resizePatchView?.());
}

function openFloatingParameters() {
  if (!activeConnection) return;
  elements.patchWindow.removeAttribute("fullscreen");
  elements.patchWindow.heading = `${elements.patchName.textContent} · Plugin`;
  elements.patchWindow.setAttribute("x", String(innerWidth <= 600 ? 12 : 24));
  elements.patchWindow.setAttribute("y", String(innerWidth <= 600 ? 56 : 24));
  elements.patchWindow.open = true;
  showFloatingPatchTab("params");
  elements.openPlugin.disabled = true;
}

function showFloatingPatchTab(tab) {
  const showUI = tab === "ui";
  const frame = elements.floatingView.querySelector(".patch-view-frame");
  if (showUI && !frame) return;
  if (showUI) {
    dockParameters();
    if (frame) frame.hidden = false;
    const width = Number(elements.patchWindow.dataset.preferredWidth);
    const height = Number(elements.patchWindow.dataset.preferredHeight);
    const compact = innerWidth <= 600;
    const scale = Math.min(1, (innerWidth - 26) / width);
    elements.patchWindow.setContentSize(compact ? innerWidth - 26 : width, compact ? Math.min(height * scale, innerHeight - 120) : height);
  } else {
    if (frame) frame.hidden = true;
    elements.floatingView.append(elements.parameters);
    elements.parameters.hidden = false;
    const width = Math.min(440, innerWidth - 32);
    const columns = width <= 144 ? 1 : width <= 240 ? 2 : width <= 324 ? 3 : 4;
    const rows = Math.max(1, Math.ceil(elements.parameters.querySelectorAll("compost-knob").length / columns));
    elements.patchWindow.setContentSize(width, Math.min(520, innerHeight - 100, Math.max(140, rows * 126 + 14)));
  }
  elements.floatingUiTab.setAttribute("aria-selected", String(showUI));
  elements.floatingParamsTab.setAttribute("aria-selected", String(!showUI));
  elements.floatingUiTab.hidden = !frame;
}

function dockParameters() {
  if (elements.parameters.parentElement !== elements.parametersHome) elements.parametersHome.append(elements.parameters);
}

function openFloatingScope() {
  closeScopeSettings();
  elements.floatingScope.append(elements.scopePanel);
  elements.scopePlaceholder.hidden = false;
  elements.floatScope.disabled = true;
  elements.scopeWindow.removeAttribute("fullscreen");
  const compact = innerWidth <= 600;
  elements.scopeWindow.setAttribute("width", String(compact ? innerWidth - 40 : Math.min(620, innerWidth - 48)));
  elements.scopeWindow.setAttribute("height", String(compact ? Math.min(380, innerHeight - 140) : Math.min(460, innerHeight - 80)));
  elements.scopeWindow.setAttribute("x", String(compact ? 20 : Math.max(24, Math.round((innerWidth - 620) / 2))));
  elements.scopeWindow.setAttribute("y", String(compact ? 56 : 40));
  elements.scopeWindow.open = true;
}

function dockScope() {
  closeScopeSettings();
  if (elements.scopePanel.parentElement !== elements.dockedScope) elements.dockedScope.append(elements.scopePanel);
  elements.scopePlaceholder.hidden = true;
  elements.floatScope.disabled = false;
}

function openScopeSettings() {
  const bounds = elements.scopeSettingsToggle.getBoundingClientRect();
  const width = Math.min(560, innerWidth - 16);
  elements.scopeSettingsMenu.hidden = false;
  elements.scopeSettingsMenu.style.width = `${width}px`;
  const height = elements.scopeSettingsMenu.getBoundingClientRect().height;
  elements.scopeSettingsMenu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, bounds.right - width))}px`;
  elements.scopeSettingsMenu.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, bounds.bottom + 5))}px`;
  elements.scopeSettingsToggle.setAttribute("aria-expanded", "true");
}

function closeScopeSettings() {
  elements.scopeSettingsMenu.hidden = true;
  elements.scopeSettingsToggle.setAttribute("aria-expanded", "false");
}

function changeMIDIOctave(delta) {
  setKeyboardRange(preferences.midiRoot + delta, Number(elements.midiPiano.getAttribute("note-count")) || 37);
  elements.synthPiano.allNotesOff?.();
  elements.synthPiano.setAttribute("root-note", String(preferences.midiRoot));
}

function setKeyboardRange(root, count, anchorRight = null) {
  count = Math.min(81, Math.max(13, Math.round(count)));
  root = Math.min(127 - count, Math.max(0, Math.round(root)));
  preferences.midiRoot = root;
  elements.midiPiano.allNotesOff();
  elements.midiPiano.setAttribute("root-note", String(root));
  elements.midiPiano.setAttribute("note-count", String(count));
  elements.dockedMidiPiano.allNotesOff();
  elements.dockedMidiPiano.setAttribute("root-note", String(root));
  elements.midiOctaveLabel.textContent = `${noteName(root)} · ${count} notes`;
  elements.midiOctaveDown.disabled = preferences.midiRoot === 0;
  elements.midiOctaveUp.disabled = preferences.midiRoot === 127 - count;
  const width = Math.min(innerWidth - 16, elements.midiPiano.keyboardWidth || elements.keyboardWindow.contentSize.width || 560);
  const height = elements.keyboardWindow.contentSize.height || 120;
  elements.keyboardWindow.setContentSize(width, height);
  if (anchorRight !== null) elements.keyboardWindow.moveTo(anchorRight - elements.keyboardWindow.offsetWidth, elements.keyboardWindow.offsetTop);
  savePreferences();
  requestAnimationFrame(() => elements.midiPiano.focus({ preventScroll: true }));
}

function sendMIDIMessage(message, timestamp = performance.now()) {
  if (!midiInputTarget) return;
  const { connection, endpointID } = midiInputTarget;
  if (typeof connection.sendScheduledMIDIInputEvent === "function") connection.sendScheduledMIDIInputEvent(endpointID, message, timestamp);
  else connection.sendMIDIInputEvent(endpointID, message);
}

function paintTheme() {
  const light = document.documentElement.dataset.theme === "light";
  elements.theme.setAttribute("aria-pressed", String(light));
  elements.theme.setAttribute("aria-label", `Switch to ${light ? "dark" : "light"} theme`);
  elements.theme.title = `${light ? "Dark" : "Light"} theme`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#e4e5e2" : "#0a0b0c");
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage may be unavailable */ }
  paintTheme();
}

function saveDraft() {
  if (activeExample?.upstreamProject) {
    localStorage.removeItem(DRAFT_KEY);
    elements.draftState.textContent = "Official example";
    return;
  }
  const hasBinaryAssets = projectAssetFiles.some(({ content }) => typeof content !== "string");
  if (hasBinaryAssets) {
    localStorage.removeItem(DRAFT_KEY);
    elements.draftState.textContent = "Project open · binary files kept in this tab";
    return;
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify({
    source: sourceDoc,
    files: additionalSourceFiles,
    manifestPath,
    manifestDoc,
    primarySourcePath: primaryProjectSourcePath,
    assetFiles: projectAssetFiles,
    folders: projectFolders,
    name: elements.patchName.textContent,
  }));
  elements.draftState.textContent = "Draft saved locally";
}
function replaceSource(source, files = []) {
  sourceDoc = source;
  additionalSourceFiles = files;
  manifestPath = activeExample?.manifestPath || "main.cmajorpatch";
  manifestDoc = activeExample?.manifestText ?? null;
  primaryProjectSourcePath = firstManifestSourcePath(manifestDoc !== null ? JSON.parse(manifestDoc) : manifestFor(elements.patchName.textContent, activeExample));
  projectAssetFiles = [];
  projectFolders = [];
  projectResourceRoot = null;
  ++sourceRevision;
  lastCheckedSource = null;
  renderFileTree();
  void openProjectFile(projectFiles()[0]);
  scheduleAutoCheck();
}

function primarySourcePath() {
  return primaryProjectSourcePath;
}

function firstManifestSourcePath(manifest) {
  const source = manifest?.source;
  return Array.isArray(source) ? String(source[0] || "main.cmajor") : String(source || "main.cmajor");
}

function projectSourceFiles() {
  return [{ path: primarySourcePath(), content: sourceDoc }, ...additionalSourceFiles];
}

function baseProjectManifest() {
  return manifestDoc !== null
    ? JSON.parse(manifestDoc)
    : structuredClone(manifestFor(elements.patchName.textContent, activeExample));
}

function projectManifest() {
  const manifest = baseProjectManifest();
  if (manifestDoc !== null) return manifest;
  const paths = projectSourceFiles().map(({ path }) => path);
  manifest.source = paths.length === 1 ? paths[0] : paths;
  return manifest;
}

function projectFingerprint() {
  return JSON.stringify({ sources: projectSourceFiles(), manifestDoc });
}

function projectFiles() {
  const manifest = projectManifest();
  const files = [
    ...projectSourceFiles().map(({ path, content }) => ({ path, type: "source", editable: true, content })),
    { path: manifestPath, type: "manifest", editable: false, content: manifestDoc ?? JSON.stringify(manifest, null, 2) },
    ...projectAssetFiles.map(({ path, content }) => ({
      path,
      type: "resource",
      editable: typeof content === "string",
      content: typeof content === "string" ? content : `Binary resource · ${content.byteLength} bytes`,
    })),
  ];
  if (activeExample && manifest.view?.src && !files.some(({ path }) => path === manifest.view.src)) files.push({ path: manifest.view.src, type: "view", editable: false, url: new URL(manifest.view.src, new URL(activeExample.resourceRoot, location.href)).href });
  if (activeExample && manifest.worker && !files.some(({ path }) => path === manifest.worker)) files.push({ path: manifest.worker, type: "worker", editable: false, url: new URL(manifest.worker, new URL(activeExample.resourceRoot, location.href)).href });
  return files;
}

function compilerProjectFiles() {
  const manifest = manifestDoc ?? JSON.stringify(projectManifest());
  return [
    { path: manifestPath, content: manifest },
    ...projectSourceFiles(),
    ...projectAssetFiles,
  ];
}

function projectByteSize() {
  return [manifestDoc ?? JSON.stringify(projectManifest()), ...projectSourceFiles().map(({ content }) => content)]
    .reduce((size, content) => size + new TextEncoder().encode(content).byteLength, 0);
}

function isValidSourceFile(file) {
  return file && typeof file.path === "string" && typeof file.content === "string"
    && file.path.endsWith(".cmajor") && isSafeProjectPath(file.path);
}

function isSafeProjectPath(path) {
  const parts = path.split("/");
  return path.length <= 512 && !path.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(path)
    && parts.every((part) => part && part !== "." && part !== "..");
}

function beginExplorerEdit(kind, parentPath = "", oldPath = null) {
  closeExplorerContextMenu();
  if (oldPath?.endsWith(".cmajorpatch")) {
    showDiagnostic("error", "Could not rename manifest", "This project keeps its existing .cmajorpatch filename.");
    return;
  }
  pendingExplorerEdit = {
    kind,
    parentPath,
    oldPath,
    value: oldPath?.split("/").at(-1) || (kind === "file" ? "untitled.cmajor" : "folder"),
  };
  renderFileTree();
}

async function commitExplorerEdit(value) {
  const edit = pendingExplorerEdit;
  if (!edit) return;
  const enteredName = value.trim();
  const kind = !edit.oldPath && enteredName.endsWith("/") ? "folder" : edit.kind;
  const name = enteredName.replace(/\/+$/, "");
  if (!name) { pendingExplorerEdit = null; renderFileTree(); return; }
  const path = `${edit.parentPath ? `${edit.parentPath}/` : ""}${name}`;
  const occupied = [...projectFiles().map((file) => file.path), ...projectFolders];
  if (!isSafeProjectPath(path) || (kind === "file" && path.endsWith(".cmajorpatch"))) {
    showDiagnostic("error", `Could not ${edit.oldPath ? "rename" : "create"} ${kind}`, "Use a safe relative name. A project can only have its existing .cmajorpatch manifest.");
    return;
  }
  if (path !== edit.oldPath && occupied.includes(path)) {
    showDiagnostic("error", `Could not ${edit.oldPath ? "rename" : "create"} ${kind}`, `${path} already exists.`);
    return;
  }

  const previousActivePath = activeFile?.path;
  pendingExplorerEdit = null;
  if (edit.oldPath) renameProjectPath(edit.oldPath, path, kind === "folder");
  else if (kind === "folder") projectFolders.push(path);
  else {
    const candidate = { path, content: "" };
    const isSource = path.endsWith(".cmajor");
    if (isSource) additionalSourceFiles.push(candidate);
    else projectAssetFiles.push(candidate);
    if (isSource && manifestDoc !== null) {
      const manifest = projectManifest();
      const sources = Array.isArray(manifest.source) ? manifest.source.map(String) : [String(manifest.source)];
      manifest.source = [...sources, path];
      manifestDoc = JSON.stringify(manifest, null, 2);
    }
  }
  activeExample = null;
  ++sourceRevision;
  lastCheckedSource = null;
  elements.examples.value = "";
  const openPath = edit.oldPath
    ? previousActivePath === edit.oldPath ? path : kind === "folder" && previousActivePath?.startsWith(`${edit.oldPath}/`) ? `${path}${previousActivePath.slice(edit.oldPath.length)}` : previousActivePath
    : kind === "file" ? path : previousActivePath;
  activeFile = null;
  renderFileTree();
  if (openPath) await openProjectFile(projectFiles().find((file) => file.path === openPath));
  saveDraft();
  scheduleAutoCheck();
}

function renameProjectPath(oldPath, newPath, folder) {
  const rename = (path) => path === oldPath ? newPath : folder && path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
  primaryProjectSourcePath = rename(primaryProjectSourcePath);
  additionalSourceFiles.forEach((file) => { file.path = rename(file.path); });
  projectAssetFiles.forEach((file) => { file.path = rename(file.path); });
  projectFolders = projectFolders.map(rename);
  const replaceManifestValue = (value) => {
    if (typeof value === "string") return rename(value);
    if (Array.isArray(value)) return value.map(replaceManifestValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceManifestValue(child)]));
    return value;
  };
  if (manifestDoc !== null) manifestDoc = JSON.stringify(replaceManifestValue(projectManifest()), null, 2);
}

async function deleteProjectPath(path, folder) {
  const matches = (candidate) => candidate === path || (folder && candidate?.startsWith(`${path}/`));
  if (matches(manifestPath)) {
    showDiagnostic("error", "Could not delete manifest", "The active .cmajorpatch manifest must remain in the project.");
    return;
  }

  const sources = projectSourceFiles();
  const remainingSources = sources.filter((file) => !matches(file.path));
  if (!remainingSources.length) {
    showDiagnostic("error", "Could not delete source", "A playground project must keep at least one Cmajor source file.");
    return;
  }

  const removedCount = sources.length - remainingSources.length
    + projectAssetFiles.filter((file) => matches(file.path)).length;
  const label = folder ? `${path}/ and ${removedCount} contained file${removedCount === 1 ? "" : "s"}` : path;
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

  const previousActivePath = activeFile?.path;
  sourceDoc = remainingSources[0].content;
  primaryProjectSourcePath = remainingSources[0].path;
  additionalSourceFiles = remainingSources.slice(1);
  projectAssetFiles = projectAssetFiles.filter((file) => !matches(file.path));
  projectFolders = projectFolders.filter((candidate) => !matches(candidate));
  if (manifestDoc !== null) {
    const manifest = projectManifest();
    const paths = remainingSources.map((file) => file.path);
    manifest.source = paths.length === 1 ? paths[0] : paths;
    manifestDoc = JSON.stringify(manifest, null, 2);
  }

  activeExample = null;
  ++sourceRevision;
  lastCheckedSource = null;
  elements.examples.value = "";
  if (projectResourceRoot) {
    projectResourceRoot = await publishProjectFiles(compilerProjectFiles().map(({ path: filePath, content }) => ({
      path: filePath,
      bytes: typeof content === "string" ? new TextEncoder().encode(content) : content,
    })));
  }

  const openPath = matches(previousActivePath) ? primaryProjectSourcePath : previousActivePath;
  activeFile = null;
  renderFileTree();
  await openProjectFile(projectFiles().find((file) => file.path === openPath) || projectFiles()[0]);
  saveDraft();
  scheduleAutoCheck();
}

async function moveProjectPath(item, targetFolder) {
  const oldPath = item?.path;
  if (!oldPath || oldPath === manifestPath) return;
  if (item.kind === "folder" && (targetFolder === oldPath || targetFolder.startsWith(`${oldPath}/`))) {
    toast("A folder cannot be moved inside itself.", "error");
    return;
  }
  const newPath = `${targetFolder ? `${targetFolder}/` : ""}${oldPath.split("/").at(-1)}`;
  if (newPath === oldPath) return;
  const occupied = [...projectFiles().map((file) => file.path), ...projectFolders];
  if (!isSafeProjectPath(newPath) || occupied.includes(newPath)) {
    toast(`${newPath} already exists or is not a safe project path.`, "error");
    return;
  }

  const previousActivePath = activeFile?.path;
  renameProjectPath(oldPath, newPath, item.kind === "folder");
  activeExample = null;
  ++sourceRevision;
  lastCheckedSource = null;
  elements.examples.value = "";
  if (projectResourceRoot) {
    projectResourceRoot = await publishProjectFiles(compilerProjectFiles().map(({ path, content }) => ({
      path,
      bytes: typeof content === "string" ? new TextEncoder().encode(content) : content,
    })));
  }
  const openPath = previousActivePath === oldPath
    ? newPath
    : item.kind === "folder" && previousActivePath?.startsWith(`${oldPath}/`)
      ? `${newPath}${previousActivePath.slice(oldPath.length)}`
      : previousActivePath;
  activeFile = null;
  renderFileTree();
  if (openPath) await openProjectFile(projectFiles().find((file) => file.path === openPath));
  saveDraft();
  scheduleAutoCheck();
  toast(`Moved ${oldPath} to ${newPath}.`);
}

function beginProjectDrag(event, item) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(PROJECT_DRAG_TYPE, JSON.stringify(item));
  event.currentTarget.classList.add("dragging");
}

function finishProjectDrag(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".project-drop-target").forEach((element) => element.classList.remove("project-drop-target"));
}

function acceptProjectDrop(event, targetFolder) {
  if (![...(event.dataTransfer?.types || [])].includes(PROJECT_DRAG_TYPE)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.classList.add("project-drop-target");
}

function dropProjectItem(event, targetFolder) {
  if (![...(event.dataTransfer?.types || [])].includes(PROJECT_DRAG_TYPE)) return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove("project-drop-target");
  try { void moveProjectPath(JSON.parse(event.dataTransfer.getData(PROJECT_DRAG_TYPE)), targetFolder); }
  catch { toast("That project item could not be moved.", "error"); }
}

function openExplorerContextMenu(event, target) {
  event.preventDefault();
  explorerContextTarget = target;
  elements.explorerContextMenu.querySelector('[data-action="rename"]').disabled = !target?.path || target.kind === "file" && target.path.endsWith(".cmajorpatch");
  elements.explorerContextMenu.querySelector('[data-action="delete"]').disabled = !target?.path || target.path === manifestPath || target.kind === "folder" && manifestPath.startsWith(`${target.path}/`);
  elements.explorerContextMenu.hidden = false;
  elements.explorerContextMenu.style.left = `${Math.min(event.clientX, innerWidth - 158)}px`;
  elements.explorerContextMenu.style.top = `${Math.min(event.clientY, innerHeight - 164)}px`;
  elements.explorerContextMenu.querySelector("button:not(:disabled)")?.focus();
}

function closeExplorerContextMenu() {
  elements.explorerContextMenu.hidden = true;
  explorerContextTarget = null;
}

function renderFileTree() {
  const files = projectFiles();
  elements.fileTree.replaceChildren();
  const root = { folders: new Map(), files: [] };
  const addFolder = (path) => {
    let node = root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const folder of projectFolders) addFolder(folder);
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop();
    addFolder(parts.join("/")).files.push({ ...file, name });
  }
  const renderInlineEditor = (parent, parentPath) => {
    if (!pendingExplorerEdit || pendingExplorerEdit.parentPath !== parentPath) return;
    const row = document.createElement("form");
    row.className = "explorer-inline-edit";
    const input = document.createElement("input");
    input.setAttribute("aria-label", `${pendingExplorerEdit.oldPath ? "Rename" : "New"} ${pendingExplorerEdit.kind}`);
    input.value = pendingExplorerEdit.value;
    row.append(input);
    row.addEventListener("submit", (event) => { event.preventDefault(); void commitExplorerEdit(input.value); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); pendingExplorerEdit = null; renderFileTree(); }
    });
    input.addEventListener("blur", () => { if (pendingExplorerEdit) void commitExplorerEdit(input.value); }, { once: true });
    parent.append(row);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  };
  const renderNode = (node, parent, parentPath = "") => {
    renderInlineEditor(parent, parentPath);
    for (const [name, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      if (pendingExplorerEdit?.oldPath === path) continue;
      const details = document.createElement("details");
      details.className = "explorer-folder";
      details.dataset.path = path;
      const summary = Object.assign(document.createElement("summary"), { textContent: name });
      summary.draggable = true;
      summary.addEventListener("dragstart", (event) => beginProjectDrag(event, { kind: "folder", path }));
      summary.addEventListener("dragend", finishProjectDrag);
      summary.addEventListener("dragover", (event) => acceptProjectDrop(event, path));
      summary.addEventListener("dragleave", (event) => event.currentTarget.classList.remove("project-drop-target"));
      summary.addEventListener("drop", (event) => dropProjectItem(event, path));
      summary.addEventListener("contextmenu", (event) => openExplorerContextMenu(event, { kind: "folder", path }));
      details.append(summary);
      renderNode(folder, details, path);
      parent.append(details);
    }
    for (const file of node.files) {
      if (pendingExplorerEdit?.oldPath === file.path) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = file.name;
      button.dataset.path = file.path;
      button.draggable = file.path !== manifestPath;
      button.addEventListener("dragstart", (event) => beginProjectDrag(event, { kind: "file", path: file.path }));
      button.addEventListener("dragend", finishProjectDrag);
      button.setAttribute("aria-current", file.path === activeFile?.path ? "page" : "false");
      button.addEventListener("click", () => openProjectFile(file));
      button.addEventListener("contextmenu", (event) => openExplorerContextMenu(event, { kind: "file", path: file.path }));
      button.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openExplorerContextMenu(event, { kind: "file", path: file.path });
      });
      parent.append(button);
    }
  };
  renderNode(root, elements.fileTree);
  if (!activeFile) void openProjectFile(files[0]);
}

async function openProjectFile(file) {
  if (!file) return;
  const content = file.url ? await fetch(file.url).then((response) => {
    if (!response.ok) throw new Error(`Could not load ${file.path}`);
    return response.text();
  }) : file.content;
  switchingFile = true;
  activeFile = file;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
    effects: editableCompartment.reconfigure(EditorView.editable.of(file.editable)),
  });
  switchingFile = false;
  elements.activeFileName.textContent = file.path;
  elements.fileTree.querySelectorAll("button").forEach((button) => button.setAttribute("aria-current", String(button.dataset.path === file.path ? "page" : "false")));
}

function createCompilerWorker() {
  const worker = new Worker(new URL("./compiler-worker.js", import.meta.url), { type: "module" });
  const failed = (event) => resetCompilerWorker(event?.message || "The compiler Worker stopped unexpectedly.", worker);
  worker.addEventListener("error", failed);
  worker.addEventListener("messageerror", () => failed({ message: "The browser could not receive the compiler result." }));
  worker.addEventListener("message", ({ data }) => {
    if (data.type === "ready") return;
    const key = `${data.purpose}:${data.id}`;
    const request = compilerRequests.get(key);
    if (!request) return;
    if (data.type === "stage") {
      if (data.purpose === "build") {
        elements.build.textContent = `${data.stage}…`;
        showDiagnostic("busy", `${data.stage}…`, "Cmajor compilation is running in the browser Worker.");
      }
      return;
    }
    clearTimeout(request.timer);
    compilerRequests.delete(key);
    request.resolve(data);
  });
  return worker;
}

function resetCompilerWorker(message, failedWorker = compiler) {
  if (failedWorker !== compiler) return;
  compiler?.terminate();
  compiler = null;
  for (const [key, request] of compilerRequests) {
    clearTimeout(request.timer);
    request.resolve({ id: request.id, purpose: request.purpose, ok: false, cancelled: true, error: message });
    compilerRequests.delete(key);
  }
}

function compile(files, id, purpose = "build") {
  return new Promise((resolve) => {
    if (!compiler) compiler = createCompilerWorker();
    const key = `${purpose}:${id}`;
    const timer = setTimeout(() => {
      resetCompilerWorker("Compilation exceeded two minutes and the compiler Worker was restarted.", compiler);
    }, COMPILER_TIMEOUT);
    compilerRequests.set(key, { id, purpose, resolve, timer });
    const resourceRoot = activeExample?.resourceRoot
      ? new URL(activeExample.resourceRoot, location.href).href
      : projectResourceRoot;
    compiler.postMessage({ id, purpose, files, manifestPath, resourceRoot });
  });
}

function scheduleAutoCheck() {
  clearTimeout(autoCheckTimer);
  if (!preferences.autoCheck) return;
  if (projectByteSize() > AUTO_CHECK_SOURCE_LIMIT) {
    elements.checkState.textContent = "Auto-compile paused · large patch";
    return;
  }
  if (document.hidden) {
    elements.checkState.textContent = "Auto-compile waiting · tab hidden";
    return;
  }
  if (autoCheckRunning) {
    autoCheckPending = true;
    elements.checkState.textContent = "Auto-compile queued";
    return;
  }
  if (projectFingerprint() === lastCheckedSource) return;
  elements.checkState.textContent = "Auto-compile pending";
  autoCheckTimer = setTimeout(runAutoCheck, AUTO_CHECK_DELAY);
}

async function runAutoCheck() {
  const fingerprint = projectFingerprint();
  if (!preferences.autoCheck || document.hidden || fingerprint === lastCheckedSource) return;
  const files = compilerProjectFiles();
  const revision = sourceRevision;
  const epoch = diagnosticEpoch;
  const id = ++checkID;
  const started = performance.now();
  autoCheckRunning = true;
  autoCheckPending = false;
  elements.checkState.textContent = "Auto-compiling…";

  const result = await compile(files, id, "check");
  autoCheckRunning = false;
  const current = preferences.autoCheck && revision === sourceRevision && epoch === diagnosticEpoch;
  if (current) {
    lastCheckedSource = fingerprint;
    elements.compilerVersion.textContent = result.version || "";
    const elapsed = performance.now() - started;
    if (result.ok) {
      if (activeFile?.type === "source") editor.dispatch(setDiagnostics(editor.state, []));
      elements.checkState.textContent = `Compiled · ${elapsed.toFixed(0)} ms`;
      showDiagnostic("success", "Auto-compile passed", `Compiled in the browser Worker in ${elapsed.toFixed(0)} ms. Playback was not changed.`);
    } else {
      const diagnostics = activeFile?.type === "source" ? parseDiagnostics(result.error, editor.state.doc, activeFile.path) : [];
      if (activeFile?.type === "source") editor.dispatch(setDiagnostics(editor.state, diagnostics));
      elements.checkState.textContent = `Compile failed · ${diagnostics.length || 1} issue${diagnostics.length === 1 ? "" : "s"}`;
      showDiagnostic("error", "Auto-compile failed · old preview retained", result.error);
    }
  }
  if (autoCheckPending || projectFingerprint() !== lastCheckedSource) scheduleAutoCheck();
}

async function buildAndPlay() {
  const id = ++requestID;
  ++diagnosticEpoch;
  if (autoCheckRunning) resetCompilerWorker("Auto-compile was cancelled so Build & Play can run.");
  stopCPUTimer(true);
  clearTimeout(autoCheckTimer);
  autoCheckPending = false;
  const files = compilerProjectFiles();
  lastCheckedSource = projectFingerprint();
  const compileStarted = performance.now();
  elements.build.disabled = true;
  elements.build.textContent = "Compiling…";
  elements.audioState.textContent = activeConnection ? "Playing old build" : "Compiling";
  showDiagnostic("busy", "Compiling in browser…", "The Cmajor WebAssembly compiler is running in a dedicated Worker.");
  editor.dispatch(setDiagnostics(editor.state, []));

  let audioPreparation;
  try {
    audioPreparation = prepareAudioFromUserGesture();
  } catch (error) {
    showDiagnostic("error", "Audio unavailable", error instanceof Error ? error.message : String(error));
    elements.audioState.textContent = activeConnection ? "Playing old build" : "Stopped";
    finishBuildButton();
    return;
  }

  const result = await compile(files, id);
  const compileTime = performance.now() - compileStarted;
  if (id !== requestID) {
    if (audioPreparation.created && !activeConnection) await discardPreparedAudio(audioPreparation);
    finishBuildButton();
    return;
  }
  elements.compilerVersion.textContent = result.version || "";
  if (!result.ok) {
    if (audioPreparation.created && !activeConnection) await discardPreparedAudio(audioPreparation);
    const errorPath = firstDiagnosticPath(result.error);
    const errorFile = projectFiles().find((file) => file.type === "source" && file.path === errorPath);
    if (errorFile) await openProjectFile(errorFile);
    else if (activeFile?.type !== "source") await openProjectFile(projectFiles()[0]);
    const diagnostics = parseDiagnostics(result.error, editor.state.doc, activeFile.path);
    editor.dispatch(setDiagnostics(editor.state, diagnostics));
    elements.checkState.textContent = "Compiled by build · failed";
    showDiagnostic("error", "Build failed", result.error);
    elements.audioState.textContent = activeConnection ? "Playing old build" : "Stopped";
    finishBuildButton();
    return;
  }

  let next = null;
  let nextMeter = null;
  try {
    const manifest = projectManifest();
    const playbackManifest = structuredClone(manifest);
    const resourceRoot = activeExample?.resourceRoot
      ? new URL(activeExample.resourceRoot, location.href).href
      : projectResourceRoot;
    if (!resourceRoot) delete playbackManifest.worker;
    const playbackStarted = performance.now();
    await audioPreparation.ready;
    const generatedClass = evaluateGeneratedClass(result.code);
    next = new AudioWorkletPatchConnection(playbackManifest);
    if (projectResourceRoot) next.readResource = (path) => fetch(new URL(path, projectResourceRoot));
    await next.initialise({
      CmajorClass: generatedClass,
      audioContext,
      workletName: `cmajor-playground-${id}`,
      hostDescription: "cmajor-web",
      rootResourcePath: resourceRoot || undefined,
      cpuTimerBuffer: cpuTimerBuffer || undefined,
    });
    attachCPUMonitor(next);
    const outputChannels = Math.max(1, next.outputEndpoints.filter(({ purpose }) => purpose === "audio out").reduce((total, endpoint) => total + (endpoint.numAudioChannels || 0), 0));
    nextMeter = createOutputMeter(outputChannels);
    next.audioNode.connect(nextMeter).connect(outputGain);

    disposeConnection(activeConnection);
    disposeOutputMeter(outputMeterNode);
    activeConnection = next;
    outputMeterNode = nextMeter;
    resetMeter();
    resetCPU();
    renderParameters(next.inputEndpoints.filter(({ purpose }) => purpose === "parameter"), next);
    renderMIDIInput(next.inputEndpoints.find(({ purpose }) => purpose === "midi in"), next);
    renderAudioInput(next.inputEndpoints.filter(({ purpose }) => purpose === "audio in"), next);
    await renderCustomView(activeExample, next);
    elements.stop.disabled = false;
    elements.audioState.textContent = "Playing";
    elements.audioState.classList.add("playing");
    const playbackTime = performance.now() - playbackStarted;
    elements.checkState.textContent = `Built · ${compileTime.toFixed(0)} ms`;
    showDiagnostic("success", "Build succeeded", `Worker compile ${compileTime.toFixed(0)} ms · AudioWorklet start ${playbackTime.toFixed(0)} ms.`);
    window.__lastBuildTiming = { compileTime, playbackTime, exampleID: activeExample?.id || "edited" };
    startMeter();
    startCPUSample();
  } catch (error) {
    if (next !== activeConnection) disposeConnection(next);
    if (nextMeter !== outputMeterNode) disposeOutputMeter(nextMeter);
    showDiagnostic("error", "Playback failed", error instanceof Error ? error.message : String(error));
    elements.audioState.textContent = activeConnection ? "Playing old build" : "Stopped";
  } finally {
    finishBuildButton();
  }
}

function finishBuildButton() {
  elements.build.disabled = false;
  elements.build.innerHTML = '<span class="play-icon">▶</span> Build &amp; Play';
}

function evaluateGeneratedClass(code) {
  const result = [];
  const factory = new Function("result", `result.push(${code});`);
  factory(result);
  return result[0];
}

function prepareAudioFromUserGesture() {
  if (audioContext && audioContext.state !== "closed") {
    return { created: false, context: audioContext, ready: audioContext.resume() };
  }

  const context = new AudioContext({ latencyHint: "interactive" });
  audioContext = context;
  // Safari requires resume() to be called synchronously in the click handler,
  // before compilation or AudioWorklet module loading consumes user activation.
  const resume = context.resume();
  cpuTimerBuffer = crossOriginIsolated
    && typeof SharedArrayBuffer === "function"
    && typeof BigInt64Array === "function"
    && typeof Atomics === "object"
    ? new SharedArrayBuffer(8)
    : null;
  const ready = Promise.all([resume, context.audioWorklet.addModule(new URL("./output-meter-worklet.js", import.meta.url))]).then(() => {
    if (audioContext !== context || context.state === "closed") throw new Error("Audio preparation was cancelled.");
    outputGain = context.createGain();
    analyser = context.createAnalyser();
    analyser.fftSize = analyserSize();
    outputGain.gain.value = preferences.volume;
    outputGain.connect(analyser).connect(context.destination);
  });
  // Compilation can outlast a fast setup failure. Attach a handler now so
  // Safari does not report an unhandled rejection before buildAndPlay awaits it.
  ready.catch(() => {});
  return { created: true, context, ready };
}

async function discardPreparedAudio(preparation) {
  if (audioContext === preparation.context && !activeConnection) {
    audioContext = outputGain = analyser = null;
    cpuTimerBuffer = null;
    if (preparation.context.state !== "closed") await preparation.context.close();
  }
}

function disposeConnection(connection) {
  if (!connection) return;
  try { connection.audioNode?.disconnect(); } catch { /* already disconnected */ }
  connection.audioNode?.port.close();
}

function createOutputMeter(channelCount) {
  const node = new AudioWorkletNode(audioContext, "cmajor-output-meter", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCountMode: "explicit",
    channelCount,
    outputChannelCount: [channelCount],
  });
  node.port.addEventListener("message", ({ data }) => {
    const now = performance.now();
    for (let channel = 0; channel < 2; ++channel) {
      const sourceChannel = data.min.length === 1 ? 0 : channel;
      setChannelMinMax(meterChannels[channel], data.min[sourceChannel] ?? 0, data.max[sourceChannel] ?? 0, now);
    }
  });
  node.port.start();
  return node;
}

function disposeOutputMeter(node) {
  if (!node) return;
  try { node.disconnect(); } catch { /* already disconnected */ }
  node.port.close();
}

async function stopAudio(updateUI) {
  ++requestID;
  stopCPUTimer(false);
  cancelAnimationFrame(meterFrame);
  clearInterval(meterTimer);
  stopAudioSources();
  disposeConnection(activeConnection);
  disposeOutputMeter(outputMeterNode);
  activeConnection = null;
  outputMeterNode = null;
  if (audioContext && audioContext.state !== "closed") await audioContext.close();
  audioContext = outputGain = analyser = null;
  cpuTimerBuffer = null;
  if (updateUI) {
    elements.stop.disabled = true;
    elements.audioState.textContent = "Stopped";
    elements.audioState.classList.remove("playing");
    showDiagnostic("success", "Stopped", "AudioWorklet and AudioContext resources were released.");
    renderParameters([], null);
    renderMIDIInput(null, null);
    renderAudioInput([], null);
    clearCustomView();
    resetMeter();
    resetCPU();
    elements.scope.setSamples(new Float32Array(2));
    clearScopePersistence();
    elements.scopeFreeze.setAttribute("aria-pressed", "false");
    elements.scopeFreeze.textContent = "Freeze";
    updateScopeLabels();
  }
}

function renderMIDIInput(endpoint, connection) {
  elements.midiPiano.allNotesOff();
  changeMIDIOctave(0);
  elements.midiInput.hidden = !endpoint;
  if (!endpoint) elements.keyboardWindow.open = false;
  midiInputTarget = endpoint && connection ? { endpointID: endpoint.endpointID, connection } : null;
  if (endpoint) openFloatingKeyboard();
}

function renderAudioInput(endpoints, connection) {
  stopAudioSources();
  const channels = endpoints.reduce((total, endpoint) => total + (endpoint.numAudioChannels || 0), 0);
  audioInputTarget = channels && connection ? connection.audioNode : null;
  elements.audioInput.hidden = !audioInputTarget;
  elements.audioInputChannels.textContent = channels ? `${channels} channel${channels === 1 ? "" : "s"}` : "";
  if (audioInputTarget) updateAudioInputMode();
}

function updateAudioInputMode() {
  stopAudioSources();
  const mode = elements.audioSource.value;
  elements.impulseControls.hidden = mode !== "impulse";
  elements.synthControls.hidden = mode !== "synth";
  elements.deviceControls.hidden = mode !== "device";
  elements.wavControls.hidden = mode !== "wav";
  elements.inputStatus.textContent = {
    impulse: "Send a one-sample impulse to inspect an effect's response.",
    synth: "Touch the keys or focus the keyboard and use A–K.",
    device: "Permission is requested only when you enable the selected input.",
    wav: wavBuffer ? `Ready · ${wavBuffer.duration.toFixed(2)} s · ${wavBuffer.numberOfChannels} channel${wavBuffer.numberOfChannels === 1 ? "" : "s"}` : "Choose a WAV file from this device.",
  }[mode];
  if (mode === "device") void populateAudioDevices();
}

function stopAudioSources() {
  disableDeviceInput();
  stopWav();
  for (const note of [...synthVoices.keys()]) stopSynthNote(note, true);
  elements.synthPiano?.allNotesOff();
}

function fireImpulse() {
  if (!audioContext || !audioInputTarget) return;
  void audioContext.resume();
  const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
  buffer.getChannelData(0)[0] = 1;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioInputTarget);
  source.start();
  elements.inputStatus.textContent = "Impulse sent.";
}

function startSynthNote(note) {
  if (!audioContext || !audioInputTarget || synthVoices.has(note)) return;
  void audioContext.resume();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.type = elements.synthWaveform.value;
  oscillator.frequency.value = 440 * 2 ** ((note - 69) / 12);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
  oscillator.connect(gain).connect(audioInputTarget);
  oscillator.start();
  synthVoices.set(note, { oscillator, gain });
  elements.inputStatus.textContent = `${noteName(note)} · ${oscillator.frequency.value.toFixed(1)} Hz`;
}

function stopSynthNote(note, immediate = false) {
  const voice = synthVoices.get(note);
  if (!voice || !audioContext) return;
  const now = audioContext.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setTargetAtTime(0, now, immediate ? 0.001 : 0.035);
  voice.oscillator.stop(now + (immediate ? 0.01 : 0.2));
  synthVoices.delete(note);
}

function noteName(note) {
  return `${["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][note % 12]}${Math.floor(note / 12) - 1}`;
}

async function populateAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    elements.enableAudioInput.disabled = true;
    elements.inputStatus.textContent = "Audio input devices are unavailable in this browser.";
    return;
  }
  const selected = elements.audioDevice.value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(({ kind }) => kind === "audioinput");
  elements.audioDevice.replaceChildren(new Option("Default audio input", ""));
  devices.forEach((device, index) => elements.audioDevice.add(new Option(device.label || `Audio input ${index + 1}`, device.deviceId)));
  if ([...elements.audioDevice.options].some(({ value }) => value === selected)) elements.audioDevice.value = selected;
}

async function enableDeviceInput() {
  if (!navigator.mediaDevices?.getUserMedia || !audioContext || !audioInputTarget) return;
  const target = audioInputTarget;
  disableDeviceInput();
  elements.enableAudioInput.disabled = true;
  elements.inputStatus.textContent = "Requesting audio input…";
  try {
    const deviceId = elements.audioDevice.value;
    mediaInputStream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (elements.audioSource.value !== "device" || target !== audioInputTarget) {
      disableDeviceInput();
      return;
    }
    await audioContext.resume();
    mediaInputNode = audioContext.createMediaStreamSource(mediaInputStream);
    mediaInputNode.connect(target);
    elements.enableAudioInput.textContent = "Disable input";
    elements.inputStatus.textContent = "Live audio input connected.";
    await populateAudioDevices();
  } catch (error) {
    disableDeviceInput();
    elements.inputStatus.textContent = `Could not open audio input: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    elements.enableAudioInput.disabled = false;
  }
}

function disableDeviceInput() {
  try { mediaInputNode?.disconnect(); } catch { /* already disconnected */ }
  mediaInputStream?.getTracks().forEach((track) => track.stop());
  mediaInputNode = null;
  mediaInputStream = null;
  if (elements.enableAudioInput) elements.enableAudioInput.textContent = "Enable input";
}

async function loadWavFile() {
  stopWav();
  const file = elements.wavInput.files?.[0];
  if (!file || !audioContext) return;
  if (file.size > 100 * 1024 * 1024) {
    elements.inputStatus.textContent = "That WAV is over the 100 MiB import limit.";
    elements.wavInput.value = "";
    return;
  }
  elements.inputStatus.textContent = "Decoding WAV…";
  try {
    wavBuffer = await audioContext.decodeAudioData(await file.arrayBuffer());
    elements.playWav.disabled = false;
    elements.inputStatus.textContent = `${file.name} · ${wavBuffer.duration.toFixed(2)} s · ${wavBuffer.numberOfChannels} channel${wavBuffer.numberOfChannels === 1 ? "" : "s"}`;
  } catch {
    wavBuffer = null;
    elements.playWav.disabled = true;
    elements.inputStatus.textContent = "This file could not be decoded as WAV audio.";
  }
}

function playWav() {
  if (!wavBuffer || !audioContext || !audioInputTarget) return;
  stopWav();
  void audioContext.resume();
  wavSource = audioContext.createBufferSource();
  wavSource.buffer = wavBuffer;
  wavSource.loop = elements.loopWav.checked;
  wavSource.connect(audioInputTarget);
  wavSource.addEventListener("ended", () => { if (wavSource) stopWav(); });
  wavSource.start();
  elements.playWav.disabled = true;
  elements.stopWav.disabled = false;
  elements.inputStatus.textContent = `${elements.loopWav.checked ? "Looping" : "Playing"} WAV.`;
}

function stopWav(updateStatus = false) {
  if (wavSource) {
    try { wavSource.stop(); } catch { /* already stopped */ }
    try { wavSource.disconnect(); } catch { /* already disconnected */ }
  }
  wavSource = null;
  if (elements.playWav) elements.playWav.disabled = !wavBuffer;
  if (elements.stopWav) elements.stopWav.disabled = true;
  if (updateStatus) elements.inputStatus.textContent = "WAV stopped.";
}

async function renderCustomView(example, connection) {
  clearCustomView();
  const manifest = projectManifest();
  const root = example?.resourceRoot ? new URL(example.resourceRoot, location.href).href : projectResourceRoot;
  const viewPath = manifest.view?.src;
  const viewURL = viewPath && root && new URL(viewPath, root).href;
  if (!viewURL) {
    elements.openPlugin.disabled = false;
    openFloatingParameters();
    return;
  }

  try {
    const { default: createPatchView } = await import(/* @vite-ignore */ viewURL);
    const view = await createPatchView(connection);
    const { width = 500, height = 320, resizable = true } = manifest.view;
    elements.patchWindow.heading = `${manifest.name || "Patch"} · Patch UI`;
    elements.patchWindow.dataset.preferredWidth = String(width);
    elements.patchWindow.dataset.preferredHeight = String(height);
    elements.patchWindow.setAttribute("width", String(width));
    elements.patchWindow.setAttribute("height", String(height));
    elements.patchWindow.setAttribute("resizable", resizable ? "both" : "none");
    const frame = document.createElement("div");
    frame.className = "patch-view-frame";
    frame.append(view);
    elements.floatingView.append(frame);
    resizePatchView = () => {
      const host = frame.parentElement;
      if (!host) return;
      const scale = Math.min(1, host.clientWidth / width);
      frame.style.width = `${width * scale}px`;
      frame.style.height = `${height * scale}px`;
      view.style.width = `${width}px`;
      view.style.height = `${height}px`;
      view.style.transform = `scale(${scale})`;
      view.style.transformOrigin = "top left";
    };
    patchViewResizeObserver = new ResizeObserver(resizePatchView);
    patchViewResizeObserver.observe(elements.floatingView);
    elements.openPlugin.disabled = false;
    openFloatingPatchView();
  } catch (error) {
    console.error("Could not load the patch's custom view", error);
    elements.openPlugin.disabled = false;
    openFloatingParameters();
  }
}

function clearCustomView() {
  patchViewResizeObserver?.disconnect();
  patchViewResizeObserver = null;
  resizePatchView = null;
  dockParameters();
  elements.patchWindow.open = false;
  elements.floatingView.replaceChildren();
  elements.floatingUiTab.hidden = true;
  elements.openPlugin.disabled = true;
}

function renderParameters(endpoints, connection) {
  elements.parameters.replaceChildren();
  if (!endpoints.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = connection ? "This patch exposes no parameters." : "Build the patch to discover its parameters.";
    elements.parameters.append(empty); return;
  }
  for (const endpoint of endpoints) {
    const annotation = endpoint.annotation || {};
    const knob = document.createElement("compost-knob");
    knob.setAttribute("parameter-id", endpoint.endpointID);
    knob.setAttribute("label", annotation.name || endpoint.name || endpoint.endpointID);
    knob.setAttribute("min", annotation.min ?? 0);
    knob.setAttribute("max", annotation.max ?? 1);
    knob.setAttribute("value", annotation.init ?? endpoint.defaultValue ?? 0);
    knob.setAttribute("reset-value", annotation.init ?? endpoint.defaultValue ?? 0);
    if (annotation.step != null) knob.setAttribute("step", annotation.step);
    if (annotation.unit) knob.setAttribute("unit", annotation.unit);
    knob.setAttribute("editable", "");
    knob.addEventListener("parameter-begin", () => connection.sendParameterGestureStart(endpoint.endpointID));
    knob.addEventListener("parameter-edit", ({ detail }) => connection.sendEventOrValue(endpoint.endpointID, detail.value));
    knob.addEventListener("parameter-end", () => connection.sendParameterGestureEnd(endpoint.endpointID));
    const listener = (value) => { knob.value = value; };
    connection.addParameterListener(endpoint.endpointID, listener);
    connection.requestParameterValue(endpoint.endpointID);
    elements.parameters.append(knob);
  }
}

function startMeter() {
  cancelAnimationFrame(meterFrame);
  clearInterval(meterTimer);
  if (!analyser) return;
  meterTimer = setInterval(renderMeter, 25);
  let data = new Float32Array(analyser.fftSize);
  let previousTime = performance.now();
  const tick = (time = performance.now()) => {
    if (!analyser) return;
    if (data.length !== analyser.fftSize) data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    if (elements.scopeFreeze.getAttribute("aria-pressed") !== "true") {
      const samples = selectScopeSamples(data);
      if (samples) {
        paintScopePersistence(samples, time - previousTime);
        elements.scope.setSamples(samples);
      }
    }
    previousTime = time;
    meterFrame = requestAnimationFrame(tick);
  };
  tick();
}

function analyserSize() {
  return Math.min(32768, 2 ** Math.ceil(Math.log2(preferences.scopeSize * 2)));
}

function applyScopeSettings() {
  if (analyser) analyser.fftSize = analyserSize();
  elements.scope.setAttribute("value-range", String(preferences.scopeRange));
  elements.scope.setAttribute("y-offset", String(preferences.scopeOffset));
  const low = Number((preferences.scopeOffset - preferences.scopeRange).toFixed(3));
  const high = Number((preferences.scopeOffset + preferences.scopeRange).toFixed(3));
  elements.scope.setAttribute("y-marker-labels", `${low}:${low},${preferences.scopeOffset}:${preferences.scopeOffset},${high}:${high}`);
  elements.scope.setAttribute("y-markers", preferences.scopeTrigger === "free" ? String(preferences.scopeOffset) : `${preferences.scopeOffset},${preferences.scopeTriggerLevel}`);
  elements.scope.setAttribute("x-markers", preferences.scopeTrigger === "free" ? "" : String(preferences.scopeTriggerPosition));
  elements.scopeTriggerLevel.disabled = preferences.scopeTrigger === "free";
  elements.scopeTriggerPosition.disabled = preferences.scopeTrigger === "free";
  if (preferences.scopePersistence === 0) clearScopePersistence();
  updateScopeLabels();
  savePreferences();
}

function selectScopeSamples(data) {
  const count = Math.min(preferences.scopeSize, data.length);
  if (preferences.scopeTrigger === "free") return data.subarray(data.length - count);
  const before = Math.round(count * preferences.scopeTriggerPosition);
  const first = before;
  const last = data.length - (count - before);
  const level = preferences.scopeTriggerLevel;
  for (let index = last; index >= first; --index) {
    const rising = data[index - 1] < level && data[index] >= level;
    const falling = data[index - 1] > level && data[index] <= level;
    if ((preferences.scopeTrigger === "rising" && rising) || (preferences.scopeTrigger === "falling" && falling)) {
      return data.subarray(index - before, index - before + count);
    }
  }
  return null;
}

function paintScopePersistence(samples, elapsed) {
  const canvas = elements.scopePersistenceCanvas;
  const rect = canvas.parentElement.getBoundingClientRect();
  const ratio = devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d");
  if (preferences.scopePersistence <= 0) { context.clearRect(0, 0, width, height); return; }
  context.globalCompositeOperation = "destination-out";
  context.fillStyle = `rgba(0,0,0,${1 - Math.exp(-elapsed / (preferences.scopePersistence * 1000))})`;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 0.16;
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--sel");
  context.lineWidth = Math.max(1, ratio);
  context.beginPath();
  for (let index = 0; index < samples.length; ++index) {
    const x = (index / (samples.length - 1)) * width;
    const y = height * 0.5 - ((samples[index] - preferences.scopeOffset) / preferences.scopeRange) * height * 0.46;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.stroke();
  context.globalAlpha = 1;
}

function clearScopePersistence() {
  const canvas = elements.scopePersistenceCanvas;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

function updateScopeLabels() {
  const sampleRate = audioContext?.sampleRate || 48000;
  const duration = (preferences.scopeSize / sampleRate) * 1000;
  const trigger = preferences.scopeTrigger === "free" ? "Free run" : `${preferences.scopeTrigger} @ ${preferences.scopeTriggerLevel}`;
  elements.scopeDuration.textContent = `${preferences.scopeSize} samples · ${duration.toFixed(1)} ms · ${trigger}`;
  elements.scope.setAttribute("x-marker-labels", `0.5:${(duration / 2).toFixed(1)} ms`);
}

function resetMeter() {
  const now = performance.now();
  meterChannels = [createMeterChannel(now), createMeterChannel(now)];
  renderMeter(now);
}

function renderMeter(now = performance.now()) {
  elements.meter.setState({
    primaryLabel: "",
    holdLabel: "",
    unit: "",
    channels: meterChannels.map((channel) => ({
      label: "",
      primary: channel.currentLevel,
      over: channel.currentLevel,
      clipped: channel.currentLevel >= 0,
    })),
  });
}

function attachCPUMonitor(connection) {
  connection.audioNode.port.addEventListener("message", ({ data }) => {
    if (data.type === "cpu" && connection === activeConnection) updateCPU(data);
  });
}

function startCPUSample() {
  stopCPUTimer(false);
  cpuSampleReceived = false;
  cpuSampleComplete = false;
  if (!cpuTimerBuffer) return;
  cpuTimerWorker = new Worker(new URL("./cpu-timer-worker.js", import.meta.url), { type: "module" });
  cpuTimerWorker.postMessage(cpuTimerBuffer);
  cpuTimerStopTimeout = window.setTimeout(() => stopCPUTimer(true), 2500);
}

function stopCPUTimer(markSample) {
  clearTimeout(cpuTimerStopTimeout);
  cpuTimerStopTimeout = 0;
  cpuTimerWorker?.terminate();
  cpuTimerWorker = null;
  if (!markSample || !cpuTimerBuffer) return;
  if (cpuSampleReceived) {
    cpuSampleComplete = true;
  }
  else {
    elements.cpuLevel.textContent = "n/a";
    elements.cpuMeter.removeAttribute("aria-valuenow");
    elements.cpuMeter.setAttribute("aria-valuetext", "DSP CPU unavailable because the diagnostic timer did not run concurrently with the AudioWorklet");
  }
}

function resetCPU() {
  elements.cpuLevel.textContent = "—";
  elements.cpuBar.style.width = "0%";
  elements.cpuMeter.classList.remove("high", "timer-limited");
  elements.cpuMeter.removeAttribute("aria-valuenow");
  elements.cpuMeter.setAttribute("aria-valuetext", "Waiting for DSP CPU measurement");
}

function updateCPU({ level, timerResolution }) {
  const percentage = Math.min(Math.max(level * 100, 0), 100);
  const timerLimited = timerResolution >= 0.5;
  if (!timerLimited) {
    cpuSampleReceived = true;
    if (cpuTimerBuffer && !cpuTimerWorker) cpuSampleComplete = true;
  }
  const label = timerLimited ? "n/a" : level === 0 ? "<0.1%" : `${percentage.toFixed(1)}%`;
  elements.cpuLevel.textContent = label;
  elements.cpuBar.style.width = `${timerLimited ? 0 : percentage}%`;
  elements.cpuMeter.classList.toggle("high", level >= 0.8);
  elements.cpuMeter.classList.toggle("timer-limited", timerLimited);
  if (timerLimited) elements.cpuMeter.removeAttribute("aria-valuenow");
  else elements.cpuMeter.setAttribute("aria-valuenow", percentage.toFixed(1));
  elements.cpuMeter.setAttribute("aria-valuetext", timerLimited ? `DSP CPU unavailable because this AudioWorklet clock has ${timerResolution.toFixed(1)} millisecond resolution` : `${label} of the audio callback budget`);
}

function firstDiagnosticPath(message) {
  return message.match(/(?:^|\n)([^:\n]+):\d+:\d+:/)?.[1];
}

function parseDiagnostics(message, doc, activePath) {
  const diagnostics = [];
  const pattern = /(?:^|\n)([^:\n]+):(\d+):(\d+):\s*(?:(error|warning):\s*)?([^\n]+)/g;
  for (const match of message.matchAll(pattern)) {
    if (activePath && match[1] !== activePath) continue;
    const lineNumber = Math.min(Number(match[2]), doc.lines);
    const line = doc.line(lineNumber);
    const from = Math.min(line.to, line.from + Math.max(0, Number(match[3]) - 1));
    diagnostics.push({ from, to: Math.min(line.to, from + 1), severity: match[4] === "warning" ? "warning" : "error", message: match[5].trim() });
  }
  return diagnostics;
}

function showDiagnostic(kind, title, detail) {
  if (!elements.diagnosticOutput) return;
  elements.diagnosticOutput.hidden = kind === "success";
  elements.diagnosticOutput.className = `diagnostic-output ${kind}`;
  elements.diagnosticOutput.replaceChildren(Object.assign(document.createElement("strong"), { textContent: title }), Object.assign(document.createElement("span"), { textContent: detail }));
}

async function shareProject() {
  try {
    if (githubShareURL && sourceRevision === githubShareRevision) {
      await navigator.clipboard.writeText(githubShareURL);
      toast("Pinned GitHub project link copied. Audio will remain stopped when it opens.");
      return;
    }
    if (projectAssetFiles.some(({ content }) => typeof content !== "string")) {
      throw new Error("Projects with binary resource files are not placed in URL shares. The local project remains unchanged.");
    }
    const encoded = await encodeProject({
      source: sourceDoc,
      files: additionalSourceFiles,
      manifestPath,
      manifestDoc: manifestDoc ?? JSON.stringify(projectManifest(), null, 2),
      folders: projectFolders,
      resources: projectAssetFiles,
      name: elements.patchName.textContent,
    });
    const url = new URL(location.href); url.hash = `code=${encoded}`;
    history.replaceState(null, "", url);
    await navigator.clipboard.writeText(url.href);
    toast("Share link copied. Audio will remain stopped when it opens.");
  } catch (error) {
    elements.diagnosticOutput.hidden = true;
    toast(`Could not create share link: ${error.message}`, "error");
  }
}

function downloadSource() {
  const file = activeFile?.type === "source" ? projectSourceFiles().find(({ path }) => path === activeFile.path) : projectSourceFiles()[0];
  const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
  const anchor = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: file.path.split("/").at(-1) });
  anchor.click(); URL.revokeObjectURL(anchor.href);
}

async function importSource() {
  const file = elements.fileInput.files?.[0]; if (!file) return;
  elements.fileInput.value = "";
  await importSourceFile(file);
}

async function importSourceFile(file) {
  if (file.size > MAX_SOURCE_BYTES) { showDiagnostic("error", "Import refused", "The source file exceeds 256 KiB."); return; }
  const text = await file.text();
  let source = text;
  if (file.type === "application/json" || file.name.endsWith(".json")) {
    try { source = JSON.parse(text).source; } catch { source = null; }
    if (typeof source !== "string") { showDiagnostic("error", "Import failed", "JSON imports must contain a string source field."); return; }
  }
  activeExample = null;
  elements.patchName.textContent = file.name.replace(/\.[^.]+$/, "");
  replaceSource(source);
  if (file.name.endsWith(".cmajor") && isSafeProjectPath(file.name)) {
    primaryProjectSourcePath = file.name;
    renderFileTree();
    await openProjectFile(projectFiles()[0]);
  }
  elements.attribution.textContent = "Imported local source file.";
  saveDraft();
}

async function importDroppedItems(dataTransfer) {
  const itemEntries = [...(dataTransfer?.items || [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!itemEntries.length) {
    const files = [...(dataTransfer?.files || [])];
    if (files.length === 1 && /\.(?:cmajor|json)$/i.test(files[0].name)) return importSourceFile(files[0]);
    return importDroppedFiles(files);
  }

  if (itemEntries.length === 1 && itemEntries[0].isFile && /\.(?:cmajor|json)$/i.test(itemEntries[0].name)) {
    return importSourceFile(await droppedEntryFile(itemEntries[0]));
  }

  try {
    const entries = [];
    const state = { size: 0 };
    for (const entry of itemEntries) await readDroppedEntry(entry, "", entries, state);
    const firstPart = entries[0]?.path.split("/")[0];
    const hasCommonRoot = firstPart && entries.every(({ path }) => path.startsWith(`${firstPart}/`));
    if (hasCommonRoot) entries.forEach((entry) => { entry.path = entry.path.slice(firstPart.length + 1); });
    await loadProjectEntries(entries);
  } catch (error) {
    showDiagnostic("error", "Drop import failed", error?.message || "The dropped items could not be read.");
  }
}

async function importDroppedFiles(files) {
  if (files.length === 1 && /\.(?:cmajor|json)$/i.test(files[0].name)) return importSourceFile(files[0]);
  const entries = await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath || file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
  await loadProjectEntries(entries);
}

function droppedEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function droppedDirectoryBatch(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readDroppedEntry(entry, parentPath, entries, state) {
  const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await droppedEntryFile(entry);
    state.size += file.size;
    if (state.size > MAX_PROJECT_BYTES) throw new Error("The dropped project exceeds the 100 MiB in-browser limit.");
    entries.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const children = await droppedDirectoryBatch(reader);
    if (!children.length) break;
    for (const child of children) await readDroppedEntry(child, path, entries, state);
  }
}

async function importProjectFolder() {
  const selected = [...(elements.projectInput.files || [])];
  elements.projectInput.value = "";
  if (!selected.length) return;
  if (selected.reduce((size, file) => size + file.size, 0) > MAX_PROJECT_BYTES) {
    showDiagnostic("error", "Project import refused", "The selected project exceeds the 100 MiB in-browser limit.");
    return;
  }
  const browserPaths = selected.map((file) => file.webkitRelativePath || file.name);
  const root = browserPaths[0].split("/")[0];
  const hasCommonRoot = browserPaths.every((path) => path.startsWith(`${root}/`));
  const entries = await Promise.all(selected.map(async (file, index) => ({
    path: hasCommonRoot ? browserPaths[index].slice(root.length + 1) : browserPaths[index],
    file,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })));
  await loadProjectEntries(entries);
}

async function loadUpstreamExample(example) {
  const loadID = exampleLoadID;
  elements.examples.disabled = true;
  showDiagnostic("busy", `Loading ${example.name}…`, "Fetching the pinned upstream project files directly from GitHub.");
  try {
    const root = new URL(example.sourceRoot || example.resourceRoot, location.href);
    const entries = await Promise.all(example.upstreamProject.files.map(async (path) => {
      const url = new URL(path.split("/").map(encodeURIComponent).join("/"), root);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
      return { path, bytes: new Uint8Array(await response.arrayBuffer()) };
    }));
    if (loadID !== exampleLoadID) return;
    await loadProjectEntries(entries, { example });
  } catch (error) {
    if (loadID !== exampleLoadID) return;
    elements.examples.value = activeExample?.id || "";
    elements.patchName.textContent = activeExample?.name || "Project";
    elements.audioState.textContent = activeConnection ? "Previous patch playing" : "Stopped";
    showDiagnostic("error", `Could not load ${example.name}`, error instanceof Error ? error.message : String(error));
  } finally {
    if (loadID === exampleLoadID) elements.examples.disabled = false;
  }
}

async function openProjectFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    elements.projectInput.click();
    return;
  }

  try {
    const directory = await window.showDirectoryPicker({ mode: "read" });
    const entries = [];
    await readDirectoryEntries(directory, "", entries, { size: 0 });
    entries.sort((a, b) => a.path.localeCompare(b.path));
    await loadProjectEntries(entries);
  } catch (error) {
    if (error?.name === "AbortError") return;
    showDiagnostic("error", "Project import failed", error?.message || "The selected folder could not be read.");
  }
}

async function readDirectoryEntries(directory, parentPath, entries, state) {
  for await (const handle of directory.values()) {
    const path = parentPath ? `${parentPath}/${handle.name}` : handle.name;
    if (handle.kind === "directory") {
      await readDirectoryEntries(handle, path, entries, state);
      continue;
    }
    if (handle.kind !== "file") continue;
    const file = await handle.getFile();
    state.size += file.size;
    if (state.size > MAX_PROJECT_BYTES) throw new Error("The selected project exceeds the 100 MiB in-browser limit.");
    entries.push({ path, file, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
}

async function loadProjectEntries(entries, { example = null, selectedManifest = "", attribution = "" } = {}) {
  if (!entries.length) {
    showDiagnostic("error", "Project import failed", "The selected folder is empty.");
    return false;
  }
  const totalSize = entries.reduce((size, entry) => size + entry.bytes.byteLength, 0);
  if (totalSize > MAX_PROJECT_BYTES) {
    showDiagnostic("error", "Project import refused", "The selected project exceeds the 100 MiB in-browser limit.");
    return false;
  }
  if (entries.some(({ path }) => !isSafeProjectPath(path))) {
    showDiagnostic("error", "Project import refused", "The folder contains an unsafe relative path.");
    return false;
  }

  const manifests = entries.filter(({ path }) => path.endsWith(".cmajorpatch"));
  if (!manifests.length) {
    showDiagnostic("error", "Project import failed", "The selected project contains no .cmajorpatch manifest.");
    return false;
  }

  if (!selectedManifest && manifests.length > 1) {
    selectedManifest = await chooseProjectManifest(manifests.map(({ path }) => path), "Choose a Cmajor patch");
    if (!selectedManifest) return false;
  }
  const manifestEntry = manifests.find(({ path }) => path === selectedManifest) || manifests[0];
  let importedManifest;
  try {
    importedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestEntry.bytes));
  } catch {
    showDiagnostic("error", "Project import failed", `${manifestEntry.path} is not valid UTF-8 JSON.`);
    return false;
  }
  const manifestFolder = manifestEntry.path.split("/").slice(0, -1).join("/");
  const sourcePaths = (Array.isArray(importedManifest.source) ? importedManifest.source : [importedManifest.source])
    .filter((path) => path !== undefined && path !== null)
    .map((path) => resolveProjectPath(manifestFolder, String(path)));
  if (!sourcePaths.length) {
    showDiagnostic("error", "Project import failed", `${manifestEntry.path} does not list any source files.`);
    return false;
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const missing = sourcePaths.find((path) => !byPath.has(path));
  if (missing) {
    showDiagnostic("error", "Project import failed", `The manifest references missing source file ${missing}.`);
    return false;
  }

  let importedSources;
  try {
    importedSources = sourcePaths.map((path) => ({ path, content: new TextDecoder("utf-8", { fatal: true }).decode(byPath.get(path).bytes) }));
  } catch {
    showDiagnostic("error", "Project import failed", "Every manifest source must be a valid UTF-8 text file.");
    return false;
  }

  activeExample = example;
  projectResourceRoot = example?.resourceRoot ? new URL(example.resourceRoot, location.href).href : await publishProjectFiles(entries);
  sourceDoc = importedSources[0].content;
  primaryProjectSourcePath = importedSources[0].path;
  additionalSourceFiles = importedSources.slice(1);
  manifestPath = manifestEntry.path;
  manifestDoc = new TextDecoder().decode(manifestEntry.bytes);
  projectAssetFiles = entries
    .filter(({ path }) => path !== manifestPath && !sourcePaths.includes(path))
    .map(({ path, bytes }) => ({ path, content: bytes }));
  projectFolders = [];
  activeFile = null;
  ++sourceRevision;
  lastCheckedSource = null;
  elements.examples.value = example?.id || "";
  elements.patchName.textContent = typeof importedManifest.name === "string" ? importedManifest.name : manifestPath.replace(/\.cmajorpatch$/, "");
  elements.audioState.textContent = activeConnection ? "Previous patch playing" : "Ready";
  elements.audioState.classList.toggle("playing", Boolean(activeConnection));
  elements.attribution.textContent = attribution || example?.attribution || `Local project · ${entries.length} files · paths preserved verbatim.`;
  elements.fileActions.hidden = true;
  renderFileTree();
  await openProjectFile(projectFiles().find(({ path }) => path === sourcePaths[0]));
  saveDraft();
  scheduleAutoCheck();
  showDiagnostic("success", example ? `${example.name} loaded` : "Project loaded", `${manifestPath} and ${entries.length - 1} project files are ready for in-browser compilation.`);
  return true;
}

function resolveProjectPath(folder, relativePath) {
  const parts = `${folder ? `${folder}/` : ""}${relativePath}`.split("/");
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) return relativePath;
      resolved.pop();
    } else resolved.push(part);
  }
  return resolved.join("/");
}

function showProjectDialog(mode, { title, manifests = [], initialValue = "" } = {}) {
  elements.githubDialogTitle.textContent = title;
  elements.githubLocationFields.hidden = mode !== "location";
  elements.githubManifestFields.hidden = mode !== "manifest";
  elements.githubConfirm.textContent = mode === "location" ? "Find patches" : "Open patch";
  if (mode === "location") elements.githubLocation.value = initialValue;
  else elements.githubManifest.replaceChildren(...manifests.map((path) => new Option(path, path)));
  elements.githubDialog.showModal();
  (mode === "location" ? elements.githubLocation : elements.githubManifest).focus();
  return new Promise((resolve) => elements.githubDialog.addEventListener("close", () => {
    resolve(elements.githubDialog.returnValue === "confirm"
      ? (mode === "location" ? elements.githubLocation.value : elements.githubManifest.value)
      : "");
  }, { once: true }));
}

function chooseProjectManifest(manifests, title = "Choose a Cmajor patch") {
  if (manifests.length === 1) return Promise.resolve(manifests[0]);
  return showProjectDialog("manifest", { title, manifests });
}

async function requestGitHubProject() {
  elements.fileActions.hidden = true;
  elements.more.setAttribute("aria-expanded", "false");
  const input = await showProjectDialog("location", { title: "Open GitHub project" });
  if (!input) return;
  let project;
  try { project = parseGitHubProject(input); }
  catch (error) { toast(error.message, "error"); return; }
  await openGitHubProject(project);
}

async function openGitHubProject(project) {
  const label = `${project.owner}/${project.repo}`;
  beginProjectLoad(label);
  try {
    showDiagnostic("busy", `Loading ${label}…`, "Discovering Cmajor patch manifests on GitHub.");
    const discovery = await discoverGitHubProject(project);
    const selected = project.manifest || await chooseProjectManifest(discovery.manifests, `Choose a patch from ${label}`);
    if (!selected) {
      elements.patchName.textContent = activeExample?.name || "Project";
      elements.audioState.textContent = activeConnection ? "Previous patch playing" : "Stopped";
      return;
    }
    showDiagnostic("busy", `Loading ${selected.split("/").at(-1)}…`, `Fetching the selected patch at ${discovery.sha.slice(0, 7)}.`);
    const entries = await downloadGitHubPatch(discovery, selected, { maxBytes: MAX_PROJECT_BYTES });
    const localManifest = selected.split("/").at(-1);
    const loaded = await loadProjectEntries(entries, {
      selectedManifest: localManifest,
      attribution: `GitHub · ${label} at ${discovery.sha.slice(0, 7)} · ${selected}`,
    });
    if (!loaded) return;
    const canonical = { ...discovery, manifest: selected };
    const url = new URL(location.href);
    url.hash = githubProjectFragment(canonical);
    history.replaceState(null, "", url);
    githubShareURL = url.href;
    githubShareRevision = sourceRevision;
    toast(`Opened ${selected.split("/").at(-1)} from GitHub.`);
  } catch (error) {
    elements.patchName.textContent = activeExample?.name || "Project";
    elements.audioState.textContent = activeConnection ? "Previous patch playing" : "Stopped";
    showDiagnostic("error", `Could not load ${label}`, error instanceof Error ? error.message : String(error));
    toast(`Could not open GitHub project: ${error.message}`, "error");
  }
}

async function publishProjectFiles(entries) {
  if (!await projectFileService) return null;
  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
  if (!navigator.serviceWorker.controller) return null;

  const cache = await caches.open("cmajor-web-project-files-v1");
  if (projectResourceRoot) {
    for (const request of await cache.keys()) {
      if (request.url.startsWith(projectResourceRoot)) await cache.delete(request);
    }
  }
  const root = new URL(`/__cmajor_project__/${crypto.randomUUID()}/`, location.origin);
  const contentType = (path) => ({
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".wav": "audio/wav",
  })[path.slice(path.lastIndexOf(".")).toLowerCase()] || "application/octet-stream";
  await Promise.all(entries.map(({ path, bytes }) => {
    const url = new URL(path.split("/").map(encodeURIComponent).join("/"), root);
    return cache.put(url, new Response(bytes, { headers: { "content-type": contentType(path) } }));
  }));
  return root.href;
}

function toast(message, kind = "status") {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", kind === "error");
  elements.toast.classList.add("visible");
  setTimeout(() => elements.toast.classList.remove("visible"), kind === "error" ? 6000 : 3200);
}

if (import.meta.env.DEV) {
  window.__cmajorWebTest = {
    get sampleRate() { return audioContext?.sampleRate || 0; },
    get source() { return sourceDoc; },
    get audioContext() { return audioContext; },
    get connection() { return activeConnection; },
    replaceSource,
    getAudioSamples() {
      if (!analyser) return [];
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return [...samples];
    },
  };
}
