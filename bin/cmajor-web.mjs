#!/usr/bin/env node
import { run } from "../src/node/wclap-cli.js";

process.exitCode = await run(process.argv.slice(2));
