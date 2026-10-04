import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

// Explicit opt-in parser subprocess, not an agent/runtime probe. No shell,
// imports from user directories, filesystem output, or source in diagnostics.
const program = `import json, sys, tomllib
try:
    result = tomllib.loads(sys.stdin.buffer.read().decode('utf-8'))
except (tomllib.TOMLDecodeError, UnicodeDecodeError):
    sys.stdout.write('{"state":"malformed"}')
else:
    sys.stdout.write(json.dumps({"state":"parsed","value":result}, default=str))
`;

export function createPythonTomlParser(executable) {
  if (typeof executable !== "string" || !isAbsolute(executable)) throw new TypeError("Explicit absolute Python executable required");
  return text => {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1024 * 1024)
      throw Object.assign(new TypeError("TOML input exceeds bound"), {parserState:"unsupported"});
    let reply;
    try {
      reply = JSON.parse(execFileSync(executable, ["-I", "-B", "-c", program], {
        input:text, encoding:"utf8", timeout:5000, maxBuffer:4 * 1024 * 1024,
        windowsHide:true, stdio:["pipe", "pipe", "pipe"],
      }));
    } catch {
      throw Object.assign(new Error("TOML parser unavailable or failed"), {parserState:"unavailable"});
    }
    if (reply.state === "malformed") throw Object.assign(new TypeError("Malformed TOML"), {parserState:"malformed"});
    if (reply.state !== "parsed" || !reply.value || typeof reply.value !== "object" || Array.isArray(reply.value))
      throw Object.assign(new Error("Invalid TOML parser response"), {parserState:"unavailable"});
    return reply.value;
  };
}
