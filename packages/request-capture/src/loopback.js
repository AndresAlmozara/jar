import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CAPTURE_MODE } from "./profiles.js";
import { captureFixtureRequest, serializeCapture } from "./capture.js";
import { MAX_BODY_BYTES } from "./privacy.js";

function bound(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("Invalid harness bound");
  return value;
}

/** A finite fixture sink, not a proxy or runtime launcher. No client, DNS lookup,
 * subprocess, disk write or forwarding capability exists in this module.
 */
export async function startFixtureCaptureServer(options = {}) {
  if (Object.keys(options).some(k => !["mode", "context", "maxBodyBytes", "maxRequests", "lifetimeMs", "requestTimeoutMs"].includes(k)))
    throw new TypeError("Unsupported harness option");
  if (options.mode !== CAPTURE_MODE || !options.context || options.context.mode !== CAPTURE_MODE)
    throw new TypeError("Only fixture capture is authorized");
  // Validate and detach caller context before binding. Raw requests/headers cannot
  // be smuggled through context, and there is no caller callback with raw access.
  if (Object.keys(options.context).some(k => !["mode", "runtime", "profileId", "providerProtocol", "requestScope",
    "invocationId", "turnId", "ordinal", "plan", "mappings", "unknownContributor"].includes(k)))
    throw new TypeError("Invalid harness context");
  const context = structuredClone(options.context);
  captureFixtureRequest({...context, raw:null});
  const maxBodyBytes = bound(options.maxBodyBytes ?? MAX_BODY_BYTES, MAX_BODY_BYTES);
  const maxRequests = bound(options.maxRequests ?? 1, 16);
  const lifetimeMs = bound(options.lifetimeMs ?? 3000, 30000);
  const requestTimeoutMs = bound(options.requestTimeoutMs ?? 1000, 10000);
  const fixtureToken = randomBytes(24).toString("hex"), records = [];
  let requests = 0, stopped = false, expiry;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = http.createServer({maxHeaderSize:8192});
  const sockets = new Set();
  server.maxConnections = 8;
  server.maxHeadersCount = 64;
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  function close(graceful = false) {
    if (!stopped) {
      stopped = true; clearTimeout(expiry);
      let grace;
      server.close(() => { clearTimeout(grace); resolveClosed(); });
      const destroy = () => { for (const socket of sockets) socket.destroy(); };
      // Allow a bounded flush of the controlled response while discarding an
      // already-in-flight upload. Idle/stalled clients cannot extend this grace.
      if (graceful) grace = setTimeout(destroy, 100);
      else destroy();
    }
    return closed;
  }
  const failSocket = socket => { socket.destroy(); void close(); };
  server.on("connect", (_req, socket) => failSocket(socket));
  server.on("upgrade", (_req, socket) => failSocket(socket));
  server.on("clientError", (_error, socket) => failSocket(socket));
  server.on("error", () => { void close(); });
  server.on("checkContinue", (_req, res) => {
    res.writeHead(417, {Connection:"close"}); res.end(); res.on("finish", () => { void close(); });
  });
  server.on("request", (req, res) => {
    requests++;
    const requestOrdinal = requests;
    let settled = false, bytes = 0, chunks = [];
    const timer = setTimeout(() => finish(408, null), requestTimeoutMs);
    function finish(status, observation) {
      if (settled) return;
      settled = true; clearTimeout(timer); chunks = [];
      if (stopped) { res.destroy(); return; }
      req.resume();
      if (observation) records.push(serializeCapture(observation));
      res.writeHead(status, {"Content-Type":"application/json", Connection:"close"});
      res.end(JSON.stringify({fixture:true, captured:status === 200}));
      // Any error terminates the entire bounded sink; no unsafe input is retained.
      if (status !== 200 || requests >= maxRequests) res.on("finish", () => { void close(true); });
    }
    req.on("error", () => finish(400, null));
    req.on("aborted", () => { clearTimeout(timer); chunks = []; void close(); });
    req.on("close", () => { clearTimeout(timer); chunks = []; });
    const supplied = req.headers["x-m11-fixture"];
    const authorized = typeof supplied === "string" && Buffer.byteLength(supplied) === Buffer.byteLength(fixtureToken)
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(fixtureToken));
    if (!authorized) { finish(403, null); return; }
    if (stopped || requests > maxRequests) { finish(429, null); return; }
    if (req.method !== "POST" || req.url !== "/v1/responses" || req.headers["content-encoding"]
      || req.headers["content-type"] !== "application/json") { finish(400, null); return; }
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) { finish(413, null); return; }
    req.on("data", chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBodyBytes) { finish(413, null); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks);
        const observation = captureFixtureRequest({...context, ordinal:(context.ordinal ?? 1) + requestOrdinal - 1,
          raw, headers:req.headers});
        // Diagnostic PARTIAL extraction remains available offline. The network
        // sink refuses malformed/unsupported wire structures without persistence.
        const harmless = new Set(["profile_partial", "unresolved_representation", "missing_required_container",
          "unreviewed_description_representation", "unknown_contributor", "deferred_tool", "dynamic_tool_search",
          "hosted_tool_settings_unvalidated", "uninterpreted_input_item", "scope_or_profile_mismatch"]);
        if (observation.issues.some(issue => !harmless.has(issue))) { finish(422, null); return; }
        finish(200, observation);
      } catch { finish(400, null); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  expiry = setTimeout(() => { void close(); }, lifetimeMs);
  return Object.freeze({host:address.address, port:address.port, fixtureToken, mode:CAPTURE_MODE,
    runtimeCaptureAuthorized:false, closed, close,
    observations:() => Object.freeze(records.map(line => JSON.parse(line)))});
}
