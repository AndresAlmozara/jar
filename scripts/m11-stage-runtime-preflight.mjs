import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePreflightManifest } from "./m11-runtime-preflight-semantics.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const destination = resolve(repository, ".jar/m11-runtime-preflight-input-v2");
const output = resolve(repository, ".jar/m11-runtime-preflight-output-v2");
const sourcePackage = resolve(repository, ".jar/m11-entrypoint-input-v3");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(rel)) throw new Error("Path escaped owned root");
};
async function regular(path) {
  const info = await stat(path);
  if (!info.isFile() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error(`Nonregular source: ${path}`);
}

const sources = new Map([
  ["runtime/codex.exe", resolve(sourcePackage, "runtime/codex.exe")],
  ["runtime/node.exe", resolve(sourcePackage, "runtime/node.exe")],
  ["frozen/config.toml", resolve(repository, "fixtures/m11-frozen/config.toml")],
  ["frozen/model-catalog.json", resolve(repository, "fixtures/m11-frozen/model-catalog.json")],
  ["frozen/thread-inputs.json", resolve(repository, "fixtures/m11-frozen/thread-inputs.json")],
  ["project/package.json", resolve(repository, "fixtures/m11-entrypoint/package.json")],
  ["project/experiment-plan.json", resolve(repository, "fixtures/m11-entrypoint/experiment-plan.json")],
  ["review/configuration-review.json", resolve(repository, "evidence/runtime/codex/configuration-review.json")],
  ["runtime-preflight/driver.mjs", resolve(repository, "scripts/m11-runtime-preflight-driver.mjs")],
  ["runtime-preflight/m11-runtime-preflight-semantics.mjs", resolve(repository, "scripts/m11-runtime-preflight-semantics.mjs")],
  ["runtime-preflight/observation.ps1", resolve(repository, "scripts/m11-runtime-preflight-observation.ps1")],
  ["runtime-preflight/expectations.json", resolve(repository, "fixtures/m11-runtime-preflight/expectations.json")],
  ["runtime-preflight/guest.ps1", resolve(repository, "scripts/m11-runtime-preflight.ps1")],
]);
const expected = new Map([
  ["runtime/codex.exe", "8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49"],
  ["runtime/node.exe", "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"],
]);
const files = [];
for (const [relativePath, sourcePath] of sources) {
  await regular(sourcePath);
  const bytes = await readFile(sourcePath), sha256 = digest(bytes);
  if (expected.has(relativePath) && expected.get(relativePath) !== sha256) throw new Error(`Pinned binary mismatch: ${relativePath}`);
  files.push({relativePath, size:bytes.length, sha256, sourcePath,
    role:relativePath.startsWith("runtime/") ? "pinned-runtime" : relativePath.startsWith("runtime-preflight/") ? "dynamic-preflight" : "frozen-input"});
}
files.sort((a,b) => a.relativePath.localeCompare(b.relativePath));
await mkdir(destination);
for (const file of files) {
  const target = resolve(destination, file.relativePath); inside(destination, target);
  await mkdir(dirname(target), {recursive:true});
  await copyFile(file.sourcePath, target, constants.COPYFILE_EXCL);
  if (digest(await readFile(target)) !== file.sha256) throw new Error(`Staged hash mismatch: ${file.relativePath}`);
}
const manifest = runtimePreflightManifest(files);
const text = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(resolve(destination, "manifest.json"), text, {flag:"wx"});
await mkdir(output);
console.log(JSON.stringify({destination,output,fileCount:files.length,manifestSha256:digest(Buffer.from(text))},null,2));
