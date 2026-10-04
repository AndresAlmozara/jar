import { sha256 } from "../../core/src/hash.js";
import { assertFreshOutput } from "./contracts.js";

function segment(observation, partIndex, start, end, index) {
  return Object.freeze({id:`segment_${sha256({observationId:observation.id, partIndex, start, end})}`,
    observationId:observation.id, index, partIndex, channel:observation.parts[partIndex].channel, start, end});
}

/** Complete line-aligned ranges. Never insert delimiters or truncate a long line.
 * A long line is one oversized segment; callers must KEEP, not send a prefix.
 * Limit overflow throws before returning any partial segmentation.
 */
export function segmentOutput(observation, {maxChars = 1500, maxSegments = 64} = {}) {
  assertFreshOutput(observation);
  if (!observation.supported) return [];
  if (![maxChars, maxSegments].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError("Invalid segment limits");
  const segments = [];
  const add = (partIndex, start, end) => {
    if (segments.length >= maxSegments) throw new RangeError("Output segmentation limit");
    segments.push(segment(observation, partIndex, start, end, segments.length));
  };
  observation.parts.forEach((part, partIndex) => {
    let start = 0, end = 0;
    for (const match of part.text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)) {
      if (end > start && end + match[0].length - start > maxChars) { add(partIndex, start, end); start = end; }
      end += match[0].length;
    }
    add(partIndex, start, end);
  });
  return Object.freeze(segments);
}

export function validateSegments(observation, segments) {
  if (!Array.isArray(segments)) throw new TypeError("Segments required");
  if (!observation.supported) {
    if (segments.length) throw new TypeError("Opaque content cannot be segmented");
    return segments;
  }
  let cursor = 0;
  observation.parts.forEach((part, partIndex) => {
    let offset = 0, count = 0;
    while (cursor < segments.length && segments[cursor].partIndex === partIndex) {
      const s = segments[cursor], expected = segment(observation, partIndex, s.start, s.end, cursor);
      if (!Number.isSafeInteger(s.end) || s.start !== offset || s.end < s.start || s.end > part.text.length
          || (s.end === s.start && part.text.length !== 0)
          || Object.keys(expected).some(key => s[key] !== expected[key])
          || (s.end < part.text.length && (!/[\r\n]/.test(part.text[s.end - 1])
            || (part.text[s.end - 1] === "\r" && part.text[s.end] === "\n")))) throw new TypeError("Invalid output segment range");
      offset = s.end; cursor++; count++;
    }
    if (offset !== part.text.length || count === 0 || (part.text.length === 0 && count !== 1)) throw new TypeError("Incomplete output segmentation");
  });
  if (cursor !== segments.length) throw new TypeError("Invalid output segment order");
  return segments;
}

export function reconstructOutput(observation, segments, retainedIds) {
  validateSegments(observation, segments);
  const retained = new Set(retainedIds), known = new Set(segments.map(s => s.id));
  if (retained.size !== retainedIds.length || retainedIds.some(id => !known.has(id))) throw new TypeError("Invalid retained segment identity");
  return observation.parts.map((part, partIndex) => ({...part,
    text:segments.filter(s => s.partIndex === partIndex && retained.has(s.id)).map(s => part.text.slice(s.start, s.end)).join("")}));
}
