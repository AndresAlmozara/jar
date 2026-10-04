import { sha256, stableStringify } from "../../core/src/hash.js";
import { freeze } from "../../capability-exposure/src/contracts.js";

const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const closed = (value, fields) => {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !fields.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")))
    throw new TypeError("Invalid runtime metadata policy fields");
};
const label = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:/,-]{1,200}$/.test(value))
    throw new TypeError("Invalid runtime metadata policy label");
  return value;
};

/** Generic closed policy descriptor. Validators remain adapter-owned and are
 * referenced by ID; this module never knows runtime-specific wire field names.
 */
export function runtimeMetadataBindingPolicy(input) {
  closed(input, ["policyId", "policyVersion", "runtimeFamily", "runtimeVersion", "providerProtocol",
    "requestScope", "sourceCommit", "allowedDynamicFields"]);
  if (!Array.isArray(input.allowedDynamicFields) || input.allowedDynamicFields.length === 0
    || input.allowedDynamicFields.length > 16) throw new TypeError("Invalid dynamic field policy");
  const allowedDynamicFields = input.allowedDynamicFields.map(field => {
    closed(field, ["path", "required", "validator", "semanticClassification", "sourcePin"]);
    if (typeof field.required !== "boolean") throw new TypeError("Invalid dynamic field requirement");
    return {path:label(field.path), required:field.required, validator:label(field.validator),
      semanticClassification:label(field.semanticClassification), sourcePin:label(field.sourcePin)};
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(allowedDynamicFields.map(field => field.path)).size !== allowedDynamicFields.length)
    throw new TypeError("Duplicate dynamic field path");
  const body = {policyId:label(input.policyId), policyVersion:label(input.policyVersion),
    runtimeFamily:label(input.runtimeFamily), runtimeVersion:label(input.runtimeVersion),
    providerProtocol:label(input.providerProtocol), requestScope:label(input.requestScope),
    sourceCommit:label(input.sourceCommit), allowedDynamicFields};
  return freeze({...body, evidenceHash:sha256(body)});
}

/** Evaluates only fields explicitly named by a closed policy. Unknown paths are
 * never treated as dynamic, and adapter validators return normalized metadata.
 */
export function validateRuntimeMetadataBindings({policy, request, runtimeIdentity, validateField}) {
  if (!plain(request) || !plain(runtimeIdentity) || typeof validateField !== "function")
    throw new TypeError("Invalid runtime metadata validation input");
  const issues = [], observations = [], failures = [];
  for (const field of policy.allowedDynamicFields) {
    const present = Object.hasOwn(request, field.path);
    if (!present) {
      if (field.required) {
        issues.push(`missing_dynamic_field:${field.path}`);
        failures.push({path:field.path, reasonCode:"REQUIRED_FIELD_MISSING", unknownKeyCount:0});
      }
      continue;
    }
    try {
      const normalizedShape = validateField(field.validator, request[field.path], request, runtimeIdentity);
      observations.push({path:field.path, policyId:policy.policyId, policyVersion:policy.policyVersion,
        shapeFingerprint:sha256(normalizedShape), validatedRuntimeIdentity:{...runtimeIdentity},
        sourceEvidence:field.sourcePin, semanticClassification:field.semanticClassification});
    } catch (error) {
      issues.push(`invalid_dynamic_field:${field.path}`);
      failures.push({path:field.path,
        reasonCode:typeof error?.runtimeMetadataCode === "string" ? error.runtimeMetadataCode : "FIELD_INVALID",
        unknownKeyCount:Number.isSafeInteger(error?.unknownKeyCount) && error.unknownKeyCount >= 0 ? error.unknownKeyCount : 0});
    }
  }
  return freeze({issues:[...new Set(issues)].sort(), observations:observations.sort((a,b) => a.path.localeCompare(b.path)),
    failures:failures.sort((a,b) => a.path.localeCompare(b.path))});
}

export function policyMatchesRuntime(policy, identity) {
  return plain(identity) && stableStringify({runtimeFamily:policy.runtimeFamily,
    runtimeVersion:policy.runtimeVersion, providerProtocol:policy.providerProtocol,
    requestScope:policy.requestScope}) === stableStringify(identity);
}
