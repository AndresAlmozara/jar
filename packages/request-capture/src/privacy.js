export const MAX_BODY_BYTES = 262144;

// No source excerpts in errors: even invalid JSON may contain credentials/prompts.
export class CaptureInputError extends Error {
  constructor(code) { super(code); this.name = "CaptureInputError"; this.code = code; }
}

/** Bounded JSON decoder rejecting duplicate keys, excess depth and ambiguous UTF-8.
 * No getters, prototypes or caller-supplied objects cross this untrusted boundary.
 */
export function parseRequestJSON(raw, maxBytes = MAX_BODY_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BODY_BYTES)
    throw new CaptureInputError("invalid_bound");
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) throw new CaptureInputError("invalid_input");
  if (Buffer.byteLength(raw) > maxBytes) throw new CaptureInputError("body_too_large");
  let text;
  try { text = Buffer.isBuffer(raw) ? new TextDecoder("utf-8", {fatal:true}).decode(raw) : raw; }
  catch { throw new CaptureInputError("invalid_utf8"); }
  let pos = 0, nodes = 0;
  const fail = () => { throw new CaptureInputError("invalid_json"); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[pos] ?? "x")) pos++; };
  function string() {
    const start = pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === "\\") { pos++; continue; }
      if (char === '"') {
        try { return JSON.parse(text.slice(start, pos)); } catch { fail(); }
      }
    }
    fail();
  }
  function value(depth = 0) {
    if (depth > 48 || ++nodes > 20000) throw new CaptureInputError("structure_limit");
    space();
    if (text[pos] === '"') return string();
    if (text[pos] === "{" || text[pos] === "[") {
      const object = text[pos++] === "{", end = object ? "}" : "]";
      const result = object ? Object.create(null) : [], keys = new Set();
      space();
      if (text[pos] === end) { pos++; return result; }
      while (pos < text.length) {
        space();
        let key;
        if (object) {
          if (text[pos] !== '"') fail();
          key = string();
          if (keys.has(key)) throw new CaptureInputError("duplicate_json_key");
          keys.add(key); space();
          if (text[pos++] !== ":") fail();
        }
        const item = value(depth + 1);
        if (object) result[key] = item; else result.push(item);
        space();
        if (text[pos] === end) { pos++; return result; }
        if (text[pos++] !== ",") fail();
      }
      fail();
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!match) fail();
    pos += match[0].length;
    const result = JSON.parse(match[0]);
    if (typeof result === "number" && !Number.isFinite(result)) fail();
    return result;
  }
  const result = value(); space();
  if (pos !== text.length) fail();
  return result;
}

/** All values are discarded, including unknown provider headers. The capture
 * observation persists no headers at all. This is not arbitrary secret scanning.
 */
export function redactHeaders(headers = {}) {
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const result = Object.create(null);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
      || !/^[a-z0-9-]{1,100}$/i.test(entry[0])) throw new CaptureInputError("invalid_headers");
    result[entry[0].toLowerCase()] = "[REDACTED]";
  }
  return Object.freeze(result);
}
