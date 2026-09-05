import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const revision = "4ba0924f3933d9650fb6a8f01f652a7236344604";
const checkout = mkdtempSync(path.join(tmpdir(), "cmajor-examples-"));
const output = path.resolve("public/cmajor-examples");
const catalogPath = path.resolve("src/generated/cmajor-example-catalog.json");

try {
  execFileSync("git", ["init", "--quiet", checkout]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/cmajor-lang/cmajor.git"]);
  execFileSync("git", ["-C", checkout, "fetch", "--quiet", "--depth=1", "origin", revision]);
  execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);

  const source = path.join(checkout, "examples/patches");
  rmSync(output, { recursive: true, force: true });
  cpSync(source, output, { recursive: true });

  const manifests = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".cmajorpatch")) manifests.push(file);
    }
  };
  const filesUnder = (directory) => {
    const files = [];
    const collect = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) collect(file);
        else files.push(path.relative(directory, file).split(path.sep).join("/"));
      }
    };
    collect(directory);
    return files.sort();
  };
  walk(source);
  const catalog = manifests.sort().map((manifestFile) => {
    const directory = path.dirname(manifestFile);
    const relativeDirectory = path.relative(source, directory).split(path.sep).join("/");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    return {
      id: `cmajor-${relativeDirectory.replaceAll("/", "-").toLowerCase()}`,
      name: manifest.name || path.basename(directory),
      directory: relativeDirectory,
      manifest: path.basename(manifestFile),
      files: filesUnder(directory),
    };
  });
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Synced ${catalog.length} Cmajor projects from ${revision}.`);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
