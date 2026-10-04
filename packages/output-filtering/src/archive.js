import { assertFreshOutput, freshOutput, outputRecoveryRef } from "./contracts.js";

/** OutputArchive: store(observation) -> reference; recover(reference) -> exact
 * observation. Raw contents belong ONLY here, not normal telemetry. Explicit
 * release/clear invalidate references; no silent eviction. Process-local only.
 * Optional Map backing is useful for integrity tests; never a telemetry sink.
 */
export class MemoryOutputArchive {
  #entries;
  constructor({maxEntries = 32, maxChars = 1_000_000, backing = new Map()} = {}) {
    if (![maxEntries, maxChars].every(n => Number.isSafeInteger(n) && n > 0) || !(backing instanceof Map) || backing.size) throw new TypeError("Invalid archive configuration");
    this.maxEntries = maxEntries; this.maxChars = maxChars; this.#entries = backing;
  }
  store(observation) {
    assertFreshOutput(observation);
    const ref = outputRecoveryRef(observation);
    if (this.#entries.has(ref)) { this.recover(ref); return ref; }
    const chars = [...this.#entries.values()].reduce((sum, value) => sum + value.chars, 0);
    if (!Number.isSafeInteger(chars) || this.#entries.size >= this.maxEntries || chars + observation.chars > this.maxChars) throw new Error("Archive capacity unavailable");
    this.#entries.set(ref, structuredClone(observation));
    return ref;
  }
  recover(ref) {
    const value = this.#entries.get(ref);
    if (!value) throw new Error("Archive entry missing");
    assertFreshOutput(value);
    if (outputRecoveryRef(value) !== ref) throw new Error("Archive entry corrupt");
    // Rebuild gives consumers an immutable supported-text snapshot.
    return freshOutput(Object.fromEntries(["toolInvocationId", "capabilityId", "taskId", "sessionId", "sequence", "source", "parts"].map(key => [key, value[key]])));
  }
  release(ref) { return this.#entries.delete(ref); }
  clear() { this.#entries.clear(); }
  get size() { return this.#entries.size; }
}
