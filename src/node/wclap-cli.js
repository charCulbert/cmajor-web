import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportWclapFolder } from "./export-wclap.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

const usage = `Cmajor Web WCLAP exporter

Usage:
  cmajor-web export-wclap <manifest-or-folder>... [options]
  cmajor-web export <manifest-or-folder>... [options]

Options:
  -o, --out <directory>  Output directory (default: current directory)
      --json             Print machine-readable results to stdout
      --examples         Export all upstream examples (requires ../cmajor)
  -q, --quiet            Hide progress messages
  -h, --help             Show this help
  -v, --version          Show the package version

The pinned embedded Cmajor compiler is used locally; no browser or native cmaj install is needed.`;

export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === "export" || args[0] === "export-wclap") args.shift();
  else if (args[0] && !args[0].startsWith("-")) throw new Error(`Unknown command: ${args[0]}`);

  const options = { folders: [], outDir: ".", json: false, quiet: false, examples: false, help: false, version: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "-q" || arg === "--quiet") options.quiet = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--examples") options.examples = true;
    else if (arg === "-o" || arg === "--out") {
      if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error(`${arg} requires a directory`);
      options.outDir = args[++i];
    } else if (arg.startsWith("--out=")) {
      options.outDir = arg.slice("--out=".length);
      if (!options.outDir) throw new Error("--out requires a directory");
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.folders.push(arg);
  }
  return options;
}

export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((message) => console.log(message));
  const stderr = io.stderr ?? ((message) => console.error(message));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(error.message);
    stderr("Run cmajor-web --help for usage.");
    return 2;
  }

  if (options.help) { stdout(usage); return 0; }
  if (options.version) {
    stdout(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version);
    return 0;
  }
  if (options.examples) options.folders.push(...exampleFolders());
  if (!options.folders.length) {
    stderr("Provide at least one .cmajorpatch file or patch folder.");
    stderr("Run cmajor-web --help for usage.");
    return 2;
  }

  const results = [];
  for (const folder of options.folders) {
    const started = performance.now();
    try {
      const result = await exportWclapFolder(folder, {
        outDir: options.outDir,
        onStage: options.quiet || options.json ? undefined : (stage) => stderr(`${folder}: ${stage}…`),
      });
      results.push(result);
      if (!options.quiet && !options.json) {
        stdout(`OK  ${result.patch} -> ${result.outputPath} (${formatBytes(result.archiveBytes)}, ${formatSeconds(result.timings.totalMs)})`);
      }
    } catch (error) {
      const result = { ok: false, patch: folder, error: error instanceof Error ? error.message : String(error), timings: { totalMs: performance.now() - started } };
      results.push(result);
      if (!options.json) stderr(`FAIL  ${folder}: ${result.error}`);
    }
  }
  if (options.json) stdout(JSON.stringify({ ok: results.every((result) => result.ok), results }, null, 2));
  return results.every((result) => result.ok) ? 0 : 1;
}

function exampleFolders() {
  const catalog = JSON.parse(readFileSync(resolve(root, "src/generated/cmajor-example-catalog.json"), "utf8"));
  return [resolve(root, "examples/simple-fm"), ...catalog.map((project) => resolve(root, "../cmajor/examples/patches", project.directory))];
}

function formatBytes(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }
function formatSeconds(milliseconds) { return `${(milliseconds / 1000).toFixed(2)} s`; }
