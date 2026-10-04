// Offline only. Never imports the executable driver or launches any runtime.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { digest } from "./m11-runtime-preflight-semantics.mjs";
const root=new URL("../",import.meta.url);
const read=path=>readFile(new URL(path,root));
const json=async path=>JSON.parse(await read(path));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const bytes=await read(".jar/m11-runtime-preflight-output-v1/codex-runtime-preflight.json");
const receipt=JSON.parse(bytes);
if (sha(bytes)!=="7e7d57e45a2ae4ad330134ec02fffd2df92379384f768328331e025b75d6ae36") throw Error("Returned receipt identity changed");
const manifestBytes=await read(".jar/m11-runtime-preflight-input-v1/manifest.json");
if (sha(manifestBytes)!==receipt.package.manifestSha256) throw Error("Manifest mismatch");
for (const file of JSON.parse(manifestBytes).files) {
  if (sha(await read(`.jar/m11-runtime-preflight-input-v1/${file.relativePath}`))!==file.sha256) throw Error(`Historical file mismatch: ${file.relativePath}`);
}
const frozen=(await json("evidence/runtime/codex/configuration-review.json")).parsedConfig;
const inputs=await json("fixtures/m11-frozen/thread-inputs.json");
const toolSets=Object.fromEntries(["baseline","filtered"].map(kind=> {
  const names=inputs[`${kind}DynamicTools`].map(t=>t.name);
  const observed=receipt.driver.threads[kind];
  return [kind,{names,expectedHash:digest(names),observedHash:observed.toolNamesHash,match:digest(names)===observed.toolNamesHash&&names.length===observed.toolCount}];
}));
const configLayers=receipt.driver.effectiveConfig.layers;
console.log(JSON.stringify({
  schemaVersion:"m11.runtime-reconciliation.v1",rawReceiptSha256:sha(bytes),historicalPackageVerified:true,
  config:{classification:"FROZEN_EXPECTATION_BUG",cause:"Pinned ConfigRead API ToolsV2 omits both fields; raw response not persisted",userLayerHashMatches:configLayers.find(l=>l.type==="user")?.configHash===digest(frozen),sessionLayerHashMatches:configLayers.find(l=>l.type==="sessionFlags")?.configHash===digest({cli_auth_credentials_store:"ephemeral"}),frozenConfigChanged:false},
  toolSets,
  process:{unresolvedImagePids:receipt.processObservation.processes.filter(p=>!p.executablePath).map(p=>p.pid),consoleAuthenticodeEvidence:"NOT_COLLECTED"},
  exit:{codexExitCode:receipt.driver.shutdown.exitCode,nodeExitCode:null,nodeExitCodeMeasurement:"NOT_PERSISTED",sourceExpectedNodeExitCode:2,sourceReason:"Driver sets process.exitCode=2 on failed checks; Codex exit is separate"},
  result:"STILL_FAILS",remaining:["PROCESS_IMAGE_IDENTITY_INCOMPLETE","NODE_NUMERIC_EXIT_NOT_PERSISTED"],
  runtimeAdmission:"NOT_EVALUATED",safeForLoopbackCapture:false,m11_3:"NOT_PREPARED",newCodexLaunches:0,modelRequests:0,
},null,2));
