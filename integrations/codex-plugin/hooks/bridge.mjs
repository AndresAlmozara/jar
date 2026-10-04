#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function homeDirectory() {
  return process.env.JAR_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".jar");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

function diagnostic(error) {
  try {
    const root = process.env.PLUGIN_DATA || path.join(homeDirectory(), "logs");
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(path.join(root, "hook-errors.jsonl"), `${JSON.stringify({at:new Date().toISOString(),code:error?.code || "JAR_HOOK_FAILURE",message:String(error?.message || error).slice(0,500)})}\n`);
  } catch {}
}

try {
  const raw = await readStdin();
  const event = JSON.parse(raw || "{}");
  const currentPath = path.join(homeDirectory(), "current.json");
  const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  if (current.schema !== "jar.current.v1" || !path.isAbsolute(current.runtimeRoot)) throw Object.assign(new Error("invalid active runtime pointer"), {code:"JAR_RUNTIME_POINTER_INVALID"});
  const modulePath = path.join(current.runtimeRoot, current.entrypoint);
  const runtime = await import(`${pathToFileURL(modulePath).href}?identity=${encodeURIComponent(current.contentHash)}`);
  const output = await runtime.handleCodexHook(event, {
    current,
    jarHome: homeDirectory(),
    pluginRoot: process.env.PLUGIN_ROOT || null,
    pluginData: process.env.PLUGIN_DATA || null
  });
  if (output !== null && output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  diagnostic(error);
  process.stdout.write(`${JSON.stringify({systemMessage:`JAR V1 hook failure: ${error?.code || "JAR_HOOK_FAILURE"}`})}\n`);
}
