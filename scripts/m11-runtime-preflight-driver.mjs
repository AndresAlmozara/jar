import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareConfig } from "./m11-runtime-preflight-semantics.mjs";

const sha256 = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const stable = value => value && typeof value === "object"
  ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  : value;
const digest = value => sha256(JSON.stringify(stable(value)));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

const [codexPath, expectationsPath, resultPath, controlDir, ...extra] = process.argv.slice(2);
if (!codexPath || !expectationsPath || !resultPath || !controlDir || extra.length) throw new Error("Expected four explicit paths");
const expectations = JSON.parse(await readFile(expectationsPath, "utf8"));
const frozenReview = JSON.parse(await readFile(expectations.expectedConfigDocument, "utf8"));
const threadInputs = JSON.parse(await readFile(expectations.threadInputsDocument, "utf8"));
expectations.expectedConfig = frozenReview.parsedConfig;
expectations.threadStartCommon = threadInputs.threadStartCommon;
expectations.baselineDynamicTools = threadInputs.baselineDynamicTools;
expectations.filteredDynamicTools = threadInputs.filteredDynamicTools;
const leafCount = value => object(value) ? Object.values(value).reduce((sum, child) => sum + leafCount(child), 0) : 1;
expectations.expectedConfigLeafCount = leafCount(expectations.expectedConfig);
const allowedMethods = new Set(["initialize", "config/read", "model/list", "skills/list", "mcpServerStatus/list", "thread/start"]);
const outbound = [];
const notifications = new Map();
const pending = new Map();
let stdoutBuffer = "", stderrBytes = 0;
const stderrHash = createHash("sha256");

async function waitFor(path, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await access(path, constants.F_OK); return; } catch { await delay(25); }
  }
  throw new Error(`Observer acknowledgement missing: ${path}`);
}

const child = spawn(codexPath, expectations.codexArgs, {
  cwd: expectations.cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
await writeFile(resolve(controlDir, "spawned.json"), `${JSON.stringify({nodePid:process.pid,codexPid:child.pid})}\n`, {flag:"wx"});
await waitFor(resolve(controlDir, "observer-ready"));

child.stderr.on("data", chunk => { stderrBytes += chunk.length; stderrHash.update(chunk); });
child.stdin.on("error", () => {});
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  stdoutBuffer += chunk;
  if (stdoutBuffer.length > 4 * 1024 * 1024) child.stdin.destroy(new Error("Bounded stdout exceeded"));
  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { child.stdin.destroy(new Error("Non-JSON app-server output")); continue; }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pending.get(String(message.id));
      if (waiter) { pending.delete(String(message.id)); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(`RPC ${waiter.method} failed: ${message.error.code}`)) : waiter.resolve(message.result); }
    } else if (typeof message.method === "string") {
      if (message.id !== undefined) child.stdin.destroy(new Error(`Unexpected server request: ${message.method}`));
      else notifications.set(message.method, (notifications.get(message.method) ?? 0) + 1);
    }
  }
});

let nextId = 1;
function send(method, params) {
  if (!allowedMethods.has(method) || method === "turn/start") throw new Error(`Forbidden RPC: ${method}`);
  const id = nextId++;
  outbound.push({id, method, paramsHash:digest(params ?? null)});
  child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(String(id)); child.stdin.destroy(); reject(new Error(`RPC barrier timeout: ${method}`)); }, 30000);
    pending.set(String(id), {method, resolve:resolveRequest, reject, timer});
  });
}
child.once("exit", () => {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`App-server exited during RPC: ${waiter.method}`)); }
  pending.clear();
});

function layerSummary(layer) {
  const name = object(layer?.name) ? layer.name : {};
  return {
    type: typeof name.type === "string" ? name.type : "unknown",
    file: typeof name.file === "string" ? name.file : null,
    profile: typeof name.profile === "string" ? name.profile : null,
    version: typeof layer?.version === "string" ? layer.version : null,
    disabled: layer?.disabledReason !== undefined && layer.disabledReason !== null,
    configHash: digest(layer?.config ?? null),
    nonEmpty: object(layer?.config) && Object.keys(layer.config).length > 0,
  };
}

let result;
let failure = null;
try {
  const initialized = await send("initialize", expectations.initializeParams);
  outbound.push({id:null,method:"initialized",paramsHash:digest(null)});
  child.stdin.write(`${JSON.stringify({method:"initialized"})}\n`);
  const config = await send("config/read", {cwd:expectations.cwd, includeLayers:true});
  const modelList = await send("model/list", {cursor:null, limit:100, includeHidden:true});
  const skills = await send("skills/list", {cwds:[expectations.cwd], forceReload:false});
  const mcp = await send("mcpServerStatus/list", {cursor:null, limit:100, detail:"full"});
  const baseline = await send("thread/start", {...expectations.threadStartCommon, dynamicTools:expectations.baselineDynamicTools});
  const filtered = await send("thread/start", {...expectations.threadStartCommon, dynamicTools:expectations.filteredDynamicTools});

  const layers = Array.isArray(config?.layers) ? config.layers.map(layerSummary) : [];
  const unexpectedLayers = layers.filter(layer => layer.nonEmpty && !["user", "sessionFlags"].includes(layer.type));
  const configComparison = compareConfig(expectations.expectedConfig, config?.config, layers, expectations.sourceCommit);
  const mismatches = configComparison.mismatchPaths;
  const models = Array.isArray(modelList?.data) ? modelList.data : [];
  const selectedModels = models.filter(model => model?.model === expectations.expectedModel || model?.id === expectations.expectedModel);
  const skillEntries = Array.isArray(skills?.data) ? skills.data : [];
  const skillCount = skillEntries.reduce((sum, entry) => sum + (Array.isArray(entry?.skills) ? entry.skills.length : 0), 0);
  const skillErrors = skillEntries.reduce((sum, entry) => sum + (Array.isArray(entry?.errors) ? entry.errors.length : 0), 0);
  const mcpData = Array.isArray(mcp?.data) ? mcp.data : [];
  const threadId = response => typeof response?.thread?.id === "string" ? response.thread.id : null;
  const baselineId = threadId(baseline), filteredId = threadId(filtered);
  const checks = {
    initialized: object(initialized),
    configSubsetMatch: mismatches.length === 0,
    configLayersPresent: Array.isArray(config?.layers),
    noUnexpectedNonemptyLayers: unexpectedLayers.length === 0,
    exactStaticModelResolved: selectedModels.length === 1 && models.length === 1,
    noSkills: skillCount === 0 && skillErrors === 0,
    noMcpServers: mcpData.length === 0,
    baselineThreadAccepted: baselineId !== null,
    filteredThreadAccepted: filteredId !== null,
  };
  result = {
    schemaVersion:"m11.runtime-preflight-driver.v1",
    barrier:"TWO_THREAD_START_RESPONSES_BEFORE_ANY_TURN_START",
    checks,
    passed:Object.values(checks).every(Boolean),
    protocol:{outbound, forbiddenMethodsPresent:outbound.some(entry => entry.method === "turn/start"), notifications:[...notifications].map(([method,count]) => ({method,count})).sort((a,b) => a.method.localeCompare(b.method))},
    initialization:{userAgent:typeof initialized?.userAgent === "string" ? initialized.userAgent : null, platformFamily:initialized?.platformFamily ?? null, platformOs:initialized?.platformOs ?? null},
    effectiveConfig:{requiredFieldCount:expectations.expectedConfigLeafCount, ...configComparison, mismatchPaths:mismatches.slice(0,64), layers, unexpectedLayerTypes:unexpectedLayers.map(layer => layer.type)},
    modelCatalog:{count:models.length, selectedCount:selectedModels.length, selectedProjectionHash:digest(selectedModels.map(model => ({id:model.id,model:model.model,hidden:model.hidden,isDefault:model.isDefault})))},
    skills:{entryCount:skillEntries.length, skillCount, errorCount:skillErrors},
    mcp:{serverCount:mcpData.length},
    threads:{baseline:{accepted:baselineId !== null,idHash:baselineId ? sha256(baselineId) : null,toolCount:expectations.baselineDynamicTools.length,toolNamesHash:digest(expectations.baselineDynamicTools.map(tool => tool.name))},filtered:{accepted:filteredId !== null,idHash:filteredId ? sha256(filteredId) : null,toolCount:expectations.filteredDynamicTools.length,toolNamesHash:digest(expectations.filteredDynamicTools.map(tool => tool.name))}},
    stderr:{bytes:stderrBytes,sha256:stderrHash.copy().digest("hex")},
    rawConfigPersisted:false,
    rawProtocolBodiesPersisted:false,
    modelRequests:0,
    turnStartRequests:0,
  };
  await writeFile(resolve(controlDir, "barrier.json"), `${JSON.stringify({barrier:result.barrier,passed:result.passed})}\n`, {flag:"wx"});
  await waitFor(resolve(controlDir, "barrier-observed"));
} catch (error) {
  failure = error instanceof Error ? error.message : "runtime preflight failure";
} finally {
  child.stdin.end();
}

const exit = await new Promise(resolveExit => {
  const timer = setTimeout(() => { child.kill(); resolveExit({code:null,signal:"FAILURE_CONTAINMENT_TIMEOUT"}); }, 10000);
  child.once("exit", (code, signal) => { clearTimeout(timer); resolveExit({code,signal}); });
});
if (!result) result = {schemaVersion:"m11.runtime-preflight-driver.v1",passed:false,failureCode:failure ?? "APP_SERVER_EXITED_BEFORE_BARRIER",modelRequests:0,turnStartRequests:0,rawConfigPersisted:false,rawProtocolBodiesPersisted:false};
result.shutdown = {method:"CLOSE_STDIN_AFTER_OBSERVER_ACKNOWLEDGED_RPC_BARRIER",exitCode:exit.code,signal:exit.signal,graceful:exit.code === 0 && exit.signal === null};
result.passed = result.passed === true && result.shutdown.graceful;
result.stderr = {bytes:stderrBytes,sha256:stderrHash.digest("hex")};
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {flag:"wx"});
if (!result.passed) process.exitCode = 2;
