import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRealAdmission, runtimeAdmissionReceipt } from "./m11-evaluate-runtime-admission.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const destination = resolve(root, ".jar/m11-capture-input-v7");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const admissionPath = "evidence/runtime/codex/admission.json";

let paths = ["runtime/codex.exe", "runtime/node.exe"]
  .map(path => [path, resolve(root, ".jar/m11-runtime-preflight-input-v2", path)])
  .concat([
    "fixtures/m11-frozen/config.toml",
    "fixtures/m11-frozen/model-catalog.json",
    "fixtures/m11-frozen/thread-inputs.json",
    "fixtures/m11-capture-runtime/baseline.json",
    "fixtures/m11-capture-runtime/filtered.json",
    "scripts/m11-runtime-capture-server.mjs",
    "scripts/m11-runtime-capture-driver.mjs",
    "scripts/m11-synthetic-responses.mjs",
    "scripts/m11-evaluate-runtime-admission.mjs",
    "scripts/m11-evaluate-capture.mjs",
    "scripts/m11-runtime-capture.ps1",
    "scripts/m11-capture-network-guard.ps1",
    "scripts/m11-capture-cleanup.ps1",
    "packages/core/src/hash.js",
    "packages/core/src/contracts.js",
    "packages/core/src/ids.js",
    "packages/capability-exposure/src/contracts.js",
    "packages/capability-exposure/src/policy-gate.js",
    "packages/capability-exposure/src/eligibility.js",
    "packages/capability-exposure/src/telemetry.js",
    "packages/runtime-adapters/src/contracts.js",
    "packages/request-capture/src/admission.js",
    "packages/request-capture/src/capture.js",
    "packages/request-capture/src/privacy.js",
    "packages/request-capture/src/profiles.js",
    "packages/request-capture/src/runtime-metadata-policy.js",
    "packages/request-capture/src/codex-runtime-metadata-policy.js",
    "evidence/runtime/codex/configuration-review.json",
    "evidence/runtime/codex/dependency-review.json",
    "evidence/runtime/codex/contributor-review.json",
    "evidence/runtime/codex/metadata-policy-audit.json",
    "evidence/runtime/codex/staging-review.json",
    ".jar/m11-entrypoint-output-v3/codex-entrypoint-preflight.json",
    ".jar/m11-runtime-preflight-output-v2/codex-runtime-preflight.json",
    ".jar/m11-runtime-preflight-input-v2/manifest.json",
  ].map(path => [path, resolve(root, path)]));

const dynamicManifest = JSON.parse(await readFile(resolve(root, ".jar/m11-runtime-preflight-input-v2/manifest.json"), "utf8"));
for (const file of dynamicManifest.files) {
  const path = `.jar/m11-runtime-preflight-input-v2/${file.relativePath}`;
  if (!paths.some(([existing]) => existing === path)) paths.push([path, resolve(root, path)]);
}

const admission = runtimeAdmissionReceipt(await buildRealAdmission());
const generated = new Map([[admissionPath, Buffer.from(`${JSON.stringify(admission, null, 2)}\n`)]]);
const files = [];
for (const [relativePath, source] of paths) {
  if (!(await stat(source)).isFile()) throw new Error(`Non-file source: ${relativePath}`);
  const bytes = await readFile(source);
  files.push({ relativePath, size:bytes.length, sha256:digest(bytes) });
}
for (const [relativePath, bytes] of generated)
  files.push({ relativePath, size:bytes.length, sha256:digest(bytes) });

await mkdir(destination);
for (const file of files) {
  const target = resolve(destination, file.relativePath);
  const rel = relative(destination, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Path escaped package");
  await mkdir(dirname(target), { recursive:true });
  if (generated.has(file.relativePath)) {
    await writeFile(target, generated.get(file.relativePath), { flag:"wx" });
  } else {
    await copyFile(resolve(root, file.relativePath), target, constants.COPYFILE_EXCL).catch(async error => {
      if (file.relativePath.startsWith("runtime/"))
        await copyFile(resolve(root, ".jar/m11-runtime-preflight-input-v2", file.relativePath), target, constants.COPYFILE_EXCL);
      else throw error;
    });
  }
}

const hashOf = path => files.find(file => file.relativePath === path).sha256;
const manifest = {
  schemaVersion:"m11.runtime-capture-package.v1",
  status:"READY_NOT_EXECUTED",
  safeForLoopbackCapture:true,
  runtimeAdmission:admission.outcome,
  admittedRuntimeProfileId:admission.admittedRuntimeProfileId,
  codexSha256:"8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49",
  endpoint:"http://127.0.0.1:43187/v1",
  networking:"DISABLED",
  modelRequestAuthorized:true,
  realToolCallsAuthorized:false,
  requiredBindings:[
    { path:"fixtures/m11-frozen/config.toml", sha256:"5d35e5fe48cd88a69f9a1ae02684766cbf34463d969f9dc8414b2450a6182fd5" },
    { path:"fixtures/m11-frozen/model-catalog.json", sha256:hashOf("fixtures/m11-frozen/model-catalog.json") },
    { path:"evidence/runtime/codex/metadata-policy-audit.json", sha256:hashOf("evidence/runtime/codex/metadata-policy-audit.json") },
    { path:".jar/m11-entrypoint-output-v3/codex-entrypoint-preflight.json", sha256:"6d1053241773dd9668dbc9aaaa6493ce7e0a6b48d5ea95da7bb6ace85a758fbd" },
    { path:".jar/m11-runtime-preflight-output-v2/codex-runtime-preflight.json", sha256:"83fbe2c8d80903224fd8f16aac72897e24f73650d8a0d15be68fac468a72d11b" },
  ],
  files,
};
const text = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(resolve(destination, "manifest.json"), text, { flag:"wx" });
for (const mode of ["baseline", "filtered"])
  await mkdir(resolve(root, `.jar/m11-capture-output-${mode}-v7`));
console.log(JSON.stringify({ destination, fileCount:files.length, manifestSha256:digest(text) }, null, 2));
