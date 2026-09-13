#!/usr/bin/env node
// Backwards-compatible entry point. Prefer: cmajor-web export-wclap <patch-folder>...
import { run } from "../src/node/wclap-cli.js";

process.exitCode = await run(["export-wclap", ...process.argv.slice(2)]);
