import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [codexPath, planPath, inputsPath, statePath, ...extra] = process.argv.slice(2);
if (!codexPath || !planPath || !inputsPath || !statePath || extra.length) throw new Error("Expected Codex, plan, inputs and state paths");

const state = {
  schemaVersion: "m11.capture-driver-state.v2", status: "RUNNING", failureCode: null,
  driverProcessStarted: true, codexProcessStarted: false, codexExitCode: null,
  initializedObserved: false, threadStartObserved: false, turnStartObserved: false,
  turnCompletedObserved: false, turnStartRpcAccepted: false, turnStartedNotificationObserved: false,
  turnCompletedNotificationObserved: false, turnTerminalStatus: null,
  rawProtocolBodiesPersisted: false, promptsPersisted: false,
};
let stateWrites = Promise.resolve();
const persistState = () => { const snapshot = `${JSON.stringify(state)}\n`; stateWrites = stateWrites.then(() => writeFile(statePath, snapshot)); return stateWrites; };
const fail = code => Object.assign(new Error(code), { m11Code: code });
const normalize = error => typeof error?.m11Code === "string" ? error.m11Code : "DRIVER_PROTOCOL_FAILURE";

let child, childExit = null, codexStderrBytes = 0;
const codexStderrHash = createHash("sha256");
const testMode = process.env.NODE_ENV === "test" && typeof process.env.M11_CAPTURE_TEST_CODEX_SCRIPT === "string";
const rpcTimeoutMs = testMode ? Number(process.env.M11_CAPTURE_TEST_TIMEOUT_MS ?? 30000) : 30000;
try {
  let plan, inputs;
  try { plan = JSON.parse(await readFile(planPath, "utf8")); inputs = JSON.parse(await readFile(inputsPath, "utf8")); }
  catch { throw fail("DRIVER_SCRIPT_START_FAILURE"); }
  if (!plan || !inputs?.threadStartCommon || !Array.isArray(inputs[plan.dynamicToolsKey]) || typeof inputs.syntheticUserText !== "string") throw fail("DRIVER_SCRIPT_START_FAILURE");

  const executable = testMode ? process.execPath : codexPath;
  const executableArgs = testMode ? [process.env.M11_CAPTURE_TEST_CODEX_SCRIPT] : ["-c", "cli_auth_credentials_store=\"ephemeral\"", "app-server", "--stdio", "--strict-config"];
  child = spawn(executable, executableArgs, {
    cwd: inputs.threadStartCommon.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(fail("CODEX_PROCESS_START_FAILURE"))); });
  state.codexProcessStarted = true; await persistState();
  child.stderr.on("data", chunk => { codexStderrBytes += chunk.length; codexStderrHash.update(chunk); });
  child.stdin.on("error", () => {});

  let buffer = "", id = 0, turnSettled = false, resolveTurn, rejectTurn;
  const pending = new Map();
  const turnCompleted = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  turnCompleted.catch(() => {});
  const rejectProtocol = () => { if (!turnSettled) { turnSettled = true; rejectTurn(fail("DRIVER_PROTOCOL_FAILURE")); } };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { child.kill(); rejectProtocol(); return; }
    for (;;) {
      const newline = buffer.indexOf("\n"); if (newline < 0) break;
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { child.kill(); rejectProtocol(); continue; }
      if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
        const waiter = pending.get(String(message.id));
        if (waiter) { pending.delete(String(message.id)); clearTimeout(waiter.timer); message.error ? waiter.reject(fail(waiter.failureCode)) : waiter.resolve(message.result); }
      } else if (message.id !== undefined && message.method) { child.kill(); rejectProtocol(); }
      else if (message.method === "turn/started") {
        state.turnStartedNotificationObserved = true; persistState().catch(rejectProtocol);
      } else if (message.method === "turn/completed" && !turnSettled) {
        turnSettled = true;
        state.turnCompletedNotificationObserved = true;
        state.turnTerminalStatus = ["completed","failed","interrupted"].includes(message.params?.turn?.status) ? message.params.turn.status.toUpperCase() : "UNKNOWN";
        if (message.params?.turn?.status !== "completed") persistState().then(() => rejectTurn(fail("TURN_COMPLETED_WITH_FAILURE")), rejectTurn);
        else { state.turnCompletedObserved = true; persistState().then(() => resolveTurn(message.params), rejectTurn); }
      }
    }
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(fail(waiter.failureCode)); }
    pending.clear();
    if (!turnSettled) { turnSettled = true; rejectTurn(fail(state.turnStartRpcAccepted ? "TURN_COMPLETION_NOT_OBSERVED" : "DRIVER_EXITED_NONZERO")); }
  });
  const send = (method, params, failureCode) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(String(requestId)); reject(fail("DRIVER_TIMEOUT")); }, rpcTimeoutMs); timer.unref();
    pending.set(String(requestId), { resolve, reject, method, failureCode, timer });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });

  await send("initialize", { clientInfo: { name: "m11-runtime-capture", title: "M11 runtime capture", version: "1.0.0" }, capabilities: { experimentalApi: true } }, "CODEX_INITIALIZE_FAILURE");
  state.initializedObserved = true; await persistState();
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const thread = await send("thread/start", { ...inputs.threadStartCommon, dynamicTools: inputs[plan.dynamicToolsKey] }, "THREAD_START_FAILURE");
  const threadId = thread?.thread?.id; if (typeof threadId !== "string") throw fail("THREAD_START_FAILURE");
  state.threadStartObserved = true; await persistState();
  await send("turn/start", { threadId, input: [{ type: "text", text: inputs.syntheticUserText, textElements: [] }], cwd: inputs.threadStartCommon.cwd, approvalPolicy: "never" }, "TURN_START_RPC_FAILURE");
  state.turnStartObserved = true; state.turnStartRpcAccepted = true; await persistState();
  await Promise.race([turnCompleted,new Promise((_,reject)=>setTimeout(()=>reject(fail("TURN_COMPLETION_NOT_OBSERVED")),rpcTimeoutMs))]);
  child.stdin.end();
  if (!childExit) childExit = await new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  state.codexExitCode = childExit.code;
  if (childExit.code !== 0 || childExit.signal !== null) throw fail("DRIVER_EXITED_NONZERO");
  state.status = "SUCCEEDED"; await persistState();
} catch (error) {
  state.failureCode = normalize(error); state.status = "FAILED"; state.codexExitCode = childExit?.code ?? null;
  try { if (child && child.exitCode === null) child.kill(); } catch {}
  try { await persistState(); } catch {}
  process.stderr.write(`${state.failureCode}\n`); process.exitCode = 2;
} finally {
  if (child) { state.codexStderrBytes = codexStderrBytes; state.codexStderrSha256 = codexStderrHash.digest("hex"); try { await persistState(); } catch {} }
}
