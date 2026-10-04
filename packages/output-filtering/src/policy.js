export const OUTPUT_LIMITS = Object.freeze({minChars:3000, maxSegmentChars:1500, maxSegments:64});

/** Metadata is adapter-owned. Unknown output, stderr, structured/reference
 * material and any known failure bypass wholesale in V1. Regexes are extra
 * vetoes, never a certificate that arbitrary text is safe to transmit.
 */
export function outputBypass(observation, limits = OUTPUT_LIMITS) {
  if (!observation.supported) return "unsupported_content";
  if (observation.chars < limits.minChars) return "small_output";
  const source = observation.source;
  if (!["log", "progress"].includes(source.outputClass)
      || ["failed", "truncated", "sensitive", "completeRequested", "recoveryRead"].some(key => source[key])
      || observation.parts.some(part => part.channel === "stderr" && part.text !== "")) return "unsafe_output";
  if (observation.parts.some(part => /^\s*(?:[\[{]|<\?xml|diff --git|---\s*$)/m.test(part.text)
      || /(?:api[_-]?key|password|secret|token)\s*[:=]|\bBearer\s+\S+|-----BEGIN .*PRIVATE KEY-----/i.test(part.text)
      || /\b(?:error|failed|failure|exception|traceback)\b|^\s+at\s+\S+/im.test(part.text))) return "unsafe_output";
  return null;
}

export function outputHardKeeps(observation, segments) {
  return segments.filter((segment, index) => index === 0 || index === segments.length - 1
    || segment.start === segment.end
    || /\b(?:warn(?:ing)?|error|fail(?:ed|ure)?|exception|traceback|summary|passed|success|total)\b|\S+:\d+(?::\d+)?/i.test(
      observation.parts[segment.partIndex].text.slice(segment.start, segment.end))).map(s => s.id);
}

export function progressRetained(observation, segments, hardKeepIds) {
  const hard = new Set(hardKeepIds);
  return segments.filter((segment, index) => {
    if (hard.has(segment.id) || index === 0 || observation.source.outputClass !== "progress") return true;
    const previous = segments[index - 1];
    const text = observation.parts[segment.partIndex].text.slice(segment.start, segment.end);
    // Only exact adjacent repeats within the same part of this very narrow
    // progress grammar. Repeated evidence, warnings or arbitrary logs remain.
    return previous.partIndex !== segment.partIndex
      || !text.split(/\r\n|\r|\n/).filter(Boolean).every(line => /^progress: \d+\/\d+$/.test(line))
      || !text.startsWith("progress: ")
      || text !== observation.parts[previous.partIndex].text.slice(previous.start, previous.end);
  }).map(s => s.id);
}
