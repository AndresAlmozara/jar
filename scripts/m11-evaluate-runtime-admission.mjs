import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { sha256 } from "../packages/core/src/hash.js";
import { CODEX_PROFILE } from "../packages/request-capture/src/profiles.js";
import { CODEX_RUNTIME_METADATA_POLICY } from "../packages/request-capture/src/codex-runtime-metadata-policy.js";
import { REQUIRED_CONTRIBUTORS, REQUIRED_LOCATIONS, evaluateRuntimeAdmission,
  runtimeProfileAdmissionCandidate } from "../packages/request-capture/src/admission.js";

const repository=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=path=>readFile(resolve(repository,path));
const json=async path=>JSON.parse(await read(path));
const rawHash=bytes=>createHash("sha256").update(bytes).digest("hex");
const exact=(actual,expected,label)=>{if(actual!==expected)throw new Error(`${label} mismatch`);};
const truth=(value,label)=>{if(value!==true)throw new Error(`${label} not verified`);};
const ABSENT=new Set(["builtins","host-skills","system-skills","plugins","extensions","mcp","mcp-instructions",
  "tool-search","deferred-tools","description.code-mode-typescript"]);
const ACTIVE=new Set(["synthetic-tools","dynamic-tools","contributor-generated-context"]);
const SOURCE_COMMIT="0d9c7cbfa6cf1489f55a8a9542b75ddd2c061807";
const BINARY_HASH="8f0554ede25bbc5450921897c468b2e84635aa513c5017457997af0954581f49";
const CONFIG_HASH="5d35e5fe48cd88a69f9a1ae02684766cbf34463d969f9dc8414b2450a6182fd5";
const BOUNDARY_HASH="6d1053241773dd9668dbc9aaaa6493ce7e0a6b48d5ea95da7bb6ace85a758fbd";
const DYNAMIC_HASH="83fbe2c8d80903224fd8f16aac72897e24f73650d8a0d15be68fac468a72d11b";
const MANIFEST_HASH="4248f345a8101f8f1fd430d3e69b04b490fdf622e7729f7fb5b288033f5d083d";

function wireTool(tool) {
  return {type:"function",name:tool.name,description:tool.description,strict:false,parameters:tool.inputSchema};
}
function evidence(ref,kind,artifactHash,candidate) {
  return {ref,kind,factsHash:candidate.factsHash,artifactHash,correlationId:candidate.correlationId};
}

export async function buildRealAdmission() {
  const paths={boundary:".jar/m11-entrypoint-output-v3/codex-entrypoint-preflight.json",
    dynamic:".jar/m11-runtime-preflight-output-v2/codex-runtime-preflight.json",
    manifest:".jar/m11-runtime-preflight-input-v2/manifest.json",config:"fixtures/m11-frozen/config.toml",
    catalog:"fixtures/m11-frozen/model-catalog.json",inputs:"fixtures/m11-frozen/thread-inputs.json",
    frozen:"evidence/runtime/codex/configuration-review.json",
    dependency:"evidence/runtime/codex/dependency-review.json",
    contributors:"evidence/runtime/codex/contributor-review.json",
    policy:"evidence/runtime/codex/metadata-policy-audit.json",
    staging:"evidence/runtime/codex/staging-review.json"};
  const [boundaryBytes,dynamicBytes,manifestBytes,configBytes,catalogBytes,inputBytes,frozenBytes,dependencyBytes,
    contributorBytes,policyBytes,stagingBytes]=await Promise.all(Object.values(paths).map(read));
  const boundary=JSON.parse(boundaryBytes), dynamic=JSON.parse(dynamicBytes), manifest=JSON.parse(manifestBytes);
  const inputs=JSON.parse(inputBytes), catalog=JSON.parse(catalogBytes), frozen=JSON.parse(frozenBytes);
  const contributors=JSON.parse(contributorBytes), policy=JSON.parse(policyBytes), staging=JSON.parse(stagingBytes);

  exact(rawHash(boundaryBytes),BOUNDARY_HASH,"boundary receipt");
  exact(rawHash(dynamicBytes),DYNAMIC_HASH,"dynamic receipt");
  exact(rawHash(manifestBytes),MANIFEST_HASH,"dynamic manifest");
  exact(rawHash(configBytes),CONFIG_HASH,"frozen config");
  exact(dynamic.package.manifestSha256,MANIFEST_HASH,"receipt package");
  exact(dynamic.package.codexSha256,BINARY_HASH,"runtime binary");
  exact(manifest.sourceCommit,SOURCE_COMMIT,"source pin");
  exact(manifest.expectedCodexVersion,"0.158.0-alpha.2.1","runtime version");
  exact(manifest.files.length,13,"manifest file count");
  for(const file of manifest.files) exact(rawHash(await read(`.jar/m11-runtime-preflight-input-v2/${file.relativePath}`)),file.sha256,`staged ${file.relativePath}`);

  exact(boundary.schemaVersion,"m11.codex.entrypoint-preflight.v3","boundary schema");
  exact(boundary.gateB,"PREFLIGHT_PASS_PENDING_RUNTIME","boundary gate");
  truth(boundary.identity.files.every(file=>file.match),"boundary identities");
  truth(boundary.identity.dependencies.every(dep=>dep.exists||dep.apiSetContract),"guest dependencies");
  truth(boundary.configSources.filter(row=>!row.owned).every(row=>!row.exists),"normal config roots absent");
  truth(boundary.auth.paths.every(row=>!row.exists)&&boundary.auth.credentialEnvironmentNames.length===0&&boundary.auth.savedCredentialCount===0,"credentials absent");
  truth(boundary.network.activeAdapters===0&&boundary.network.ipv4DefaultRoutes===0,"boundary network absent");
  exact(boundary.loopback,"VERIFIED_OWNED_TCP_ONLY","guest loopback");

  exact(dynamic.gateB,"DYNAMIC_PREFLIGHT_PASS_PENDING_HOST_ADMISSION","dynamic gate");
  for(const [name,value] of Object.entries(dynamic.checks)) truth(value,`dynamic check ${name}`);
  for(const [name,value] of Object.entries(dynamic.driver.checks)) truth(value,`driver check ${name}`);
  truth(dynamic.driver.passed,"driver passed"); truth(!dynamic.driver.protocol.forbiddenMethodsPresent,"forbidden RPC absent");
  exact(dynamic.driverLifecycle,"COMPLETED_PASS","driver lifecycle"); exact(dynamic.nodeExitCode,0,"node exit");
  truth(dynamic.driver.shutdown.graceful&&dynamic.driver.shutdown.exitCode===0&&dynamic.driver.shutdown.signal===null,"Codex shutdown");
  truth(dynamic.driver.modelRequests===0&&dynamic.driver.turnStartRequests===0&&dynamic.modelRequests===0&&dynamic.turnStartRequests===0,"no model request");
  truth(dynamic.driver.rawConfigPersisted===false&&dynamic.driver.rawProtocolBodiesPersisted===false&&dynamic.rawConfigsPersisted===false&&dynamic.rawRequestsPersisted===false,"raw evidence absent");
  truth(dynamic.driver.effectiveConfig.exactLayers&&dynamic.driver.effectiveConfig.mismatchPaths.length===0&&dynamic.driver.effectiveConfig.unexpectedLayerTypes.length===0,"effective config");
  exact(dynamic.driver.effectiveConfig.layers.find(x=>x.type==="user")?.configHash,sha256(frozen.parsedConfig),"effective user layer");
  exact(dynamic.driver.modelCatalog.count,1,"model count"); exact(dynamic.driver.modelCatalog.selectedCount,1,"selected model count");
  exact(dynamic.driver.modelCatalog.selectedProjectionHash,"fa99285e721b489c60a19d5c0392adf5dff27241a3a790fba41a26bae502a435","model projection");
  truth(dynamic.driver.skills.skillCount===0&&dynamic.driver.skills.errorCount===0&&dynamic.driver.mcp.serverCount===0,"skills and MCP absent");
  const names=kind=>inputs[`${kind}DynamicTools`].map(tool=>tool.name);
  for(const kind of ["baseline","filtered"]){const row=dynamic.driver.threads[kind];truth(row.accepted,`${kind} accepted`);exact(row.toolCount,names(kind).length,`${kind} count`);exact(row.toolNamesHash,sha256(names(kind)),`${kind} names`);}
  const methods=dynamic.driver.protocol.outbound.map(row=>row.method);
  truth(JSON.stringify(methods)===JSON.stringify(["initialize","initialized","config/read","model/list","skills/list","mcpServerStatus/list","thread/start","thread/start"]),"bounded RPC sequence");
  truth(dynamic.processObservation.unexpected.length===0&&dynamic.processObservation.processes.filter(x=>x.classification==="EXPECTED_RUNTIME_PROCESS").length===2&&dynamic.processObservation.processes.filter(x=>x.classification==="EXPECTED_OS_INFRASTRUCTURE").length===2,"process tree");
  truth(dynamic.processObservation.processes.filter(x=>x.name==="conhost.exe").every(x=>x.imageSha256===dynamic.consoleIdentity.sha256&&x.executablePath?.toLowerCase()==="c:\\windows\\system32\\conhost.exe"&&/^\\\?\?\\C:\\Windows\\system32\\conhost\.exe 0x[0-9a-f]+$/i.test(x.consoleCommandLine)),"console identity");
  truth(dynamic.consoleIdentity.signatureStatus==="Valid"&&dynamic.consoleIdentity.signer.startsWith("CN=Microsoft Windows,"),"console signer");
  truth(dynamic.networkObservation.apiAvailable&&dynamic.networkObservation.connections.length===0&&dynamic.networkObservation.externalConnections.length===0&&dynamic.networkObservation.activeAdapters===0&&dynamic.networkObservation.ipv4DefaultRoutes===0,"runtime network absent");
  truth(dynamic.filesystemObservation.writes.every(row=>["EXPECTED_RUNTIME_WRITE","EXPECTED_OBSERVER_WRITE"].includes(row.classification)),"write ledger");
  truth(dynamic.filesystemObservation.forbiddenBefore.every(row=>!row.exists)&&dynamic.filesystemObservation.forbiddenAfter.every(row=>!row.exists)&&dynamic.filesystemObservation.forbiddenCreated.length===0,"forbidden roots absent");
  exact(contributors.sourceCommit,SOURCE_COMMIT,"contributor source"); exact(contributors.configSha256,CONFIG_HASH,"contributor config");
  exact(policy.policy.evidenceHash,CODEX_RUNTIME_METADATA_POLICY.evidenceHash,"metadata evidence"); exact(policy.policy.sourceCommit,SOURCE_COMMIT,"metadata source");
  exact(staging.runtimeMetadataPolicy.evidenceHash,CODEX_RUNTIME_METADATA_POLICY.evidenceHash,"staging policy");
  exact(catalog.models.length,1,"frozen catalog count"); exact(catalog.models[0].slug,"m11-synthetic-direct","frozen model");
  truth(catalog.models[0].tool_mode==="direct"&&!catalog.models[0].supports_search_tool&&!catalog.models[0].use_responses_lite,"direct catalog");

  const allTools=inputs.baselineDynamicTools.map(wireTool);
  const instruction=catalog.models[0].model_messages.instructions_template;
  exact(instruction,frozen.parsedConfig.developer_instructions,"instruction source");
  const userMessage={type:"message",role:"user",content:[{type:"input_text",text:inputs.syntheticUserText}]};
  const developerMessage={type:"message",role:"developer",content:[{type:"input_text",text:instruction}]};
  const refs=["boundary-receipt","dynamic-preflight","frozen-config","model-catalog","thread-inputs","dependency-closure",
    "contributor-ledger","metadata-policy","tool-set-runtime","process-tree-runtime","network-runtime","write-runtime"];
  const input={runtimeFamily:"codex",runtimeVersion:"0.158.0-alpha.2.1",sourceCommit:SOURCE_COMMIT,
    providerProtocol:"openai-responses-http",requestScope:"initial-request-static-context",baseProfileId:CODEX_PROFILE.id,
    evidenceClass:"runtime_preflight",binaryHash:BINARY_HASH,configHash:CONFIG_HASH,
    correlationId:`m11-real-preflight-v2-${DYNAMIC_HASH.slice(0,16)}`,
    locations:REQUIRED_LOCATIONS.map(id=>({id,state:id==="tools"||id==="input.messages"||id==="instructions"?"VERIFIED":"EXCLUDED"})),
    contributors:REQUIRED_CONTRIBUTORS.map(id=>({id,state:ACTIVE.has(id)?"ACTIVE":ABSENT.has(id)?"EXCLUDED":"UNKNOWN"})),
    toolMode:"direct",toolSearch:"disabled",deferred:"disabled",
    contextHashes:[sha256(instruction),sha256(userMessage),sha256(developerMessage)],
    expectedTools:allTools.map(tool=>({nativeId:tool.name,definitionHash:sha256(tool),namespaceDescriptionHash:null,requiredInCapture:false})),
    runtimeMetadataPolicyId:CODEX_RUNTIME_METADATA_POLICY.policyId,evidenceRefs:refs};
  const candidate=runtimeProfileAdmissionCandidate(input);
  const evidenceRecords=[
    evidence("boundary-receipt","runtime_process",rawHash(boundaryBytes),candidate),
    evidence("dynamic-preflight","runtime_process",rawHash(dynamicBytes),candidate),
    evidence("frozen-config","local_config",rawHash(configBytes),candidate),
    evidence("model-catalog","local_config",rawHash(catalogBytes),candidate),
    evidence("thread-inputs","local_config",rawHash(inputBytes),candidate),
    evidence("dependency-closure","official_source",rawHash(dependencyBytes),candidate),
    evidence("contributor-ledger","official_source",rawHash(contributorBytes),candidate),
    evidence("metadata-policy","runtime_metadata_policy",CODEX_RUNTIME_METADATA_POLICY.evidenceHash,candidate),
    evidence("tool-set-runtime","runtime_process",sha256(dynamic.driver.threads),candidate),
    evidence("process-tree-runtime","runtime_process",sha256({consoleIdentity:dynamic.consoleIdentity,processObservation:dynamic.processObservation}),candidate),
    evidence("network-runtime","runtime_process",sha256(dynamic.networkObservation),candidate),
    evidence("write-runtime","runtime_process",sha256(dynamic.filesystemObservation),candidate),
  ];
  const outcome=evaluateRuntimeAdmission(input,evidenceRecords);
  exact(outcome.state,"ADMITTED_COMPLETE_FOR_SCOPE","runtime admission");
  return {schemaVersion:"m11.runtime-admission-receipt.v1",createdFrom:"OFFLINE_HOST_EVALUATION",
    candidate,outcome,evidenceRecords,evidenceArtifacts:{
      boundaryReceipt:{ref:paths.boundary,sha256:rawHash(boundaryBytes)},dynamicPreflight:{ref:paths.dynamic,sha256:rawHash(dynamicBytes)},
      dynamicManifest:{ref:paths.manifest,sha256:rawHash(manifestBytes)},frozenConfig:{ref:paths.config,sha256:rawHash(configBytes)},
      modelCatalog:{ref:paths.catalog,sha256:rawHash(catalogBytes)},threadInputs:{ref:paths.inputs,sha256:rawHash(inputBytes)},
      dependencyClosure:{ref:paths.dependency,sha256:rawHash(dependencyBytes)},contributorLedger:{ref:paths.contributors,sha256:rawHash(contributorBytes)},
      runtimeMetadataPolicy:{ref:paths.policy,sha256:rawHash(policyBytes),evidenceHash:CODEX_RUNTIME_METADATA_POLICY.evidenceHash},
      stagingManifest:{ref:paths.staging,sha256:rawHash(stagingBytes)}},
    validatedFacts:{sourceCommit:SOURCE_COMMIT,baselineToolNamesHash:sha256(names("baseline")),filteredToolNamesHash:sha256(names("filtered")),
      processTreeComplete:true,networkComplete:true,writeLedgerComplete:true,forbiddenRootsAbsent:true,noTurnStart:true,noModelRequest:true},
    missingEvidence:[],contradictoryEvidence:[],runtimeCaptureAuthorized:false};
}

export function runtimeAdmissionReceipt(result) {
  return {
    schemaVersion:result.schemaVersion,
    createdFrom:result.createdFrom,
    candidateId:result.candidate.id,
    factsHash:result.candidate.factsHash,
    outcomeId:result.outcome.id,
    outcome:result.outcome.state,
    admittedRuntimeProfileId:result.outcome.admittedProfileId,
    scope:result.candidate.facts.requestScope,
    evidence:Object.fromEntries(result.evidenceRecords.map(record => [record.ref, record.artifactHash])),
    missingEvidence:result.missingEvidence,
    contradictoryEvidence:result.contradictoryEvidence,
    runtimeCaptureAuthorized:result.runtimeCaptureAuthorized,
  };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  console.log(JSON.stringify(runtimeAdmissionReceipt(await buildRealAdmission()),null,2));
