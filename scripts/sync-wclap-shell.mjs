#!/usr/bin/env node
// Vendors a built wclap-cmajor-shell bundle into public/wclap-shell/ and writes the file
// list the browser exporter needs (it cannot enumerate a directory over HTTP).
//
//   node scripts/sync-wclap-shell.mjs [path/to/Cmajor Shell.wclap]
//
// Defaults to the sibling checkout's build output.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "../wclap-cmajor-shell/build-wclap/artifacts/Cmajor Shell.wclap");
const target = resolve("public/wclap-shell");
if (!existsSync(join(source, "module.wasm"))) {
  console.error(`No shell bundle at ${source}. Build wclap-cmajor-shell first (cmake --preset wclap && cmake --build --preset wclap).`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const files = [];
const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else files.push(relative(target, p).split("\\").join("/")); } };
walk(target);

let version = "unknown";
try { version = execSync("git describe --always --dirty", { cwd: resolve(source, "../../.."), encoding: "utf8" }).trim(); } catch {}
const moduleBytes = readFileSync(join(target, "module.wasm")).length;
writeFileSync(join(target, "manifest.json"), JSON.stringify({ version, moduleBytes, files }, null, 2) + "\n");
console.log(`Vendored wclap-cmajor-shell ${version}: ${files.length} files, module.wasm ${moduleBytes} bytes -> public/wclap-shell/`);
