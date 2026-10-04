import { readFile, lstat, mkdir, copyFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_CODEX_HASH = "8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49";
export const EXPECTED_CODEX_VERSION = "0.158.0-alpha.2.1";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Static PE import inventory only. Never loads or runs a binary/DLL. */
export function inspectPE(bytes) {
  const need = (offset, count) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > bytes.length) throw new Error("Invalid PE bounds");
    return offset;
  };
  const u16 = o => bytes.readUInt16LE(need(o, 2)), u32 = o => bytes.readUInt32LE(need(o, 4));
  if (u16(0) !== 0x5a4d) throw new Error("Not PE");
  const pe = u32(60);
  if (u32(pe) !== 0x4550 || u16(pe+4) !== 0x8664) throw new Error("Expected Windows x64 PE");
  const count = u16(pe+6), optionalSize = u16(pe+20), opt = pe+24;
  if (count > 96 || optionalSize < 240 || u16(opt) !== 0x20b) throw new Error("Unsupported PE layout");
  const sections = Array.from({length:count}, (_, i) => {
    const o = opt+optionalSize+i*40; need(o,40);
    return {rva:u32(o+12), size:u32(o+16), raw:u32(o+20)};
  });
  const at = rva => {
    const section = sections.find(s => rva >= s.rva && rva < s.rva+s.size);
    if (!section) throw new Error("Unmapped PE RVA");
    return need(section.raw+rva-section.rva, 1);
  };
  const name = rva => {
    const start = at(rva), end = bytes.indexOf(0,start);
    if (end < start || end-start > 256) throw new Error("Invalid PE import name");
    const value = bytes.toString("ascii",start,end).toLowerCase();
    if (!/^[a-z0-9_.-]+\.dll$/.test(value)) throw new Error("Invalid PE DLL name");
    return value;
  };
  const imports = [], delayedImports = [];
  for (const [index, stride, field, target] of [[1,20,12,imports], [13,32,4,delayedImports]]) {
    const rva = u32(opt+112+index*8), size = u32(opt+116+index*8);
    if (!rva) continue;
    const start = at(rva);
    let ended = false;
    for (let i=0; i<256 && (i+1)*stride <= size; i++) {
      const o = start+i*stride; need(o,stride);
      if (bytes.subarray(o,o+stride).every(b => b === 0)) { ended = true; break; }
      if (index === 13 && u32(o) !== 1) throw new Error("Unsupported delayed-import VA");
      target.push(name(u32(o+field)));
    }
    if (!ended) throw new Error("Unterminated PE import table");
  }
  return {platform:"windows", architecture:"x86_64", imports:[...new Set(imports)].sort(),
    delayedImports:[...new Set(delayedImports)].sort(), dynamicLoads:"NOT_ESTABLISHED_BY_PE_IMPORTS"};
}

function inside(root, path) {
  const rel = relative(root,path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(path) === resolve(root) || /^[A-Za-z]:/.test(rel))
    throw new Error("Path outside owned staging root");
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
    throw new Error("Nonregular staging source");
}

/** Explicit allowlist, not a repository/profile copy. Output must be a fresh child
 * of this repository's ignored .jar directory; existing output is never overwritten.
 * Returns generated manifest data to the caller; no secrets/config discovery.
 */
export async function stageM11({repository, destination, codexBinary, nodeBinary}) {
  repository = resolve(repository); destination = resolve(destination);
  const owned = resolve(repository,".jar"); inside(owned,destination);
  if (dirname(destination) !== owned) throw new Error("Staging destination must be a direct owned child");
  await mkdir(owned,{recursive:true});
  if (resolve(await realpath(owned)).toLowerCase() !== owned.toLowerCase()) throw new Error("Linked staging parent");
  await regular(codexBinary); await regular(nodeBinary);
  const codex = await readFile(codexBinary), node = await readFile(nodeBinary);
  if (digest(codex) !== EXPECTED_CODEX_HASH) throw new Error("Pinned Codex hash mismatch");
  const identities = {codex:inspectPE(codex), node:inspectPE(node)};
  const sources = new Map([
    ["runtime/codex.exe", {source:codexBinary,role:"audited-codex-runtime",provenance:"user-pinned-local-binary"}],
    ["runtime/node.exe", {source:nodeBinary,role:"capture-harness-node",provenance:"bundled-codex-workspace-node"}],
    ["preflight/codex-entrypoint-preflight.ps1", {source:resolve(repository,"scripts/codex-entrypoint-preflight.ps1"),role:"metadata-only-preflight",provenance:"repository"}],
    ["frozen/config.toml", {source:resolve(repository,"fixtures/m11-frozen/config.toml"),role:"frozen-runtime-config",provenance:"repository-fixture"}],
    ["frozen/model-catalog.json", {source:resolve(repository,"fixtures/m11-frozen/model-catalog.json"),role:"frozen-model-catalog",provenance:"repository-fixture"}],
    ["frozen/thread-inputs.json", {source:resolve(repository,"fixtures/m11-frozen/thread-inputs.json"),role:"frozen-thread-inputs",provenance:"repository-fixture"}],
    ["project/package.json", {source:resolve(repository,"fixtures/m11-entrypoint/package.json"),role:"synthetic-project",provenance:"repository-fixture"}],
    ["project/experiment-plan.json", {source:resolve(repository,"fixtures/m11-entrypoint/experiment-plan.json"),role:"nonexecutable-plan",provenance:"repository-fixture"}],
  ]);
  const visit = async rel => {
    const dest = `project/${rel.replaceAll("\\","/")}`;
    if (sources.has(dest)) return;
    const source = resolve(repository,rel); inside(repository,source); await regular(source);
    const text = await readFile(source,"utf8");
    sources.set(dest,{source,role:"capture-library",provenance:"repository"});
    // The owned JS graph uses static relative imports only. Fail on unreviewed loaders.
    if (/\bimport\s*\(|\brequire\s*\(/.test(text)) throw new Error("Dynamic module dependency requires review");
    for (const match of text.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      if (match[1].startsWith("node:")) continue;
      if (!match[1].startsWith(".")) throw new Error("External module dependency requires review");
      await visit(relative(repository,resolve(dirname(source),match[1])));
    }
  };
  for (const file of ["admission.js","capture.js","loopback.js"]) await visit(`packages/request-capture/src/${file}`);
  const files = [];
  for (const [path,entry] of [...sources].sort(([a],[b]) => a.localeCompare(b))) {
    await regular(entry.source);
    const bytes = await readFile(entry.source);
    files.push({relativePath:path, role:entry.role, size:bytes.length, sha256:digest(bytes),
      sourceProvenance:entry.provenance, sourcePath:entry.source});
  }
  if (files.find(f => f.relativePath === "runtime/codex.exe").sha256 !== EXPECTED_CODEX_HASH)
    throw new Error("Codex changed during inspection");
  // No output exists until every source has been inspected successfully.
  await mkdir(destination); // exclusive: EEXIST is a safe refusal
  for (const file of files) {
    const target = resolve(destination,file.relativePath); inside(destination,target);
    await mkdir(dirname(target),{recursive:true});
    await copyFile(file.sourcePath,target,1); // COPYFILE_EXCL
    if (digest(await readFile(target)) !== file.sha256) throw new Error("Staged bytes mismatch");
  }
  return {schemaVersion:"m11.staging-manifest.v1", status:"STATIC_STAGED_PENDING_GUEST_PREFLIGHT",
    expectedCodexVersion:EXPECTED_CODEX_VERSION, versionBasis:"user-pinned-version-and-sha256; no new execution",
    destination, identities, files, executableClosure:"PARTIAL_DYNAMIC_HELPERS_AND_GUEST_OS_UNVERIFIED",
    runtimeCaptureAuthorized:false};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository,destination,codexBinary,nodeBinary,...extra] = process.argv.slice(2);
  if (!repository || !destination || !codexBinary || !nodeBinary || extra.length) throw new Error("Expected four explicit paths");
  console.log(JSON.stringify(await stageM11({repository,destination,codexBinary,nodeBinary}),null,2));
}
