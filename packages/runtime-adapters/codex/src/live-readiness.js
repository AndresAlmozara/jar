import { CODEX_EFFECT_VERSION } from './isolated-effect.js';
import { authBoundary } from './auth-boundary.js';

/** No executable live path is exposed until authenticated dynamic-only exposure
 * and a permitted network boundary exist. User consent cannot manufacture them. */
export function liveReadiness({runtimeVersion=null,protocol=null,networkAuthorized=false,authMode=null,
  provider='offline',prepared=false,verifierSeparated=false,surfaces=null}={}){
  const auth=authBoundary(authMode);
  runtimeVersion=runtimeVersion===CODEX_EFFECT_VERSION?CODEX_EFFECT_VERSION:null;
  const supported=protocol?.dynamicTools===true&&protocol?.ephemeral===true&&protocol?.modelProvider===true;
  const blockers=['AUTHENTICATED_DYNAMIC_ONLY_BOUNDARY_UNVERIFIED','NETWORK_DISABLED_ISOLATION_HAS_NO_LIVE_PROVIDER',
    'GENERIC_CODEX_LIFECYCLE_ADAPTER_NOT_CONNECTED','LIVE_COMPLETION_VALIDATION_REQUIRED'];
  if(runtimeVersion!==CODEX_EFFECT_VERSION)blockers.unshift('PINNED_RUNTIME_NOT_VERIFIED');
  if(!supported)blockers.unshift('APP_SERVER_PROTOCOL_NOT_VERIFIED');
  if(!networkAuthorized)blockers.push('HUMAN_NETWORK_AUTHORIZATION_ABSENT');
  blockers.push('AUTH_STATE_UNKNOWN','HOST_DISCOVERY_NOT_ISOLATED','LIVE_TOOL_BOUNDARY_BLOCKED');
  if(!authMode)blockers.push('AUTH_MODE_NOT_SELECTED');
  if(authMode==='existing_codex_session')blockers.push('CACHED_AUTH_BOUND_TO_NORMAL_HOME');
  if(!prepared)blockers.push('OWNED_WORKSPACE_NOT_PREPARED');
  if(!verifierSeparated)blockers.push('HIDDEN_VERIFIER_NOT_PREPARED');
  return {schemaVersion:'jar.live-readiness.v1',status:'BLOCKED',providerKind:'live_codex_provider',
    providerMode:provider==='live'?'live':'offline',auth,
    runtimeFound:runtimeVersion!==null,appServerSurfaceAvailable:supported,
    workspaceManifestValid:prepared===true,ownedWorkspacePrepared:prepared===true,
    blindVerifierSeparated:verifierSeparated===true,capabilityInventoryValid:prepared===true,
    jarSelectedToolPlanPrepared:prepared===true,runtimeExposurePlanIssued:false,
    skillsState:surfaces?.skills?.status==='disabled'?'disabled':prepared?'prepared_not_delivered':'not_prepared',
    contextState:surfaces?.context?.status==='disabled'?'disabled':prepared?'prepared_not_delivered':'not_prepared',
    outputState:surfaces?.output?.delivery==='exact_passthrough'?'shadow_passthrough_prepared':'disabled',
    liveExecutionEnabled:false,normalConfigMutations:0,
    nativeToolBoundary:{status:'UNVERIFIED',strictJarOnly:false,observedTools:null,unavoidableTools:null,
      conditionalSurfaces:['exec_command','write_stdin','apply_patch','request_user_input_async',
        'send_message_to_user_async','clock','MCP_resources','extension_tools','hosted_tools'],
      reason:'Dynamic tools are appended to core, MCP and extension tools; real model metadata and host discovery are not frozen.'},
    runtimeVersion,pinnedVersion:CODEX_EFFECT_VERSION,protocolSupported:supported,authState:'UNKNOWN',
    authMechanism:authMode,networkAuthorized:networkAuthorized===true,networkEnabled:false,
    ephemeralSupported:protocol?.ephemeral===true,normalConfigMutationRequired:'unknown',credentialsCopied:false,
    externalProviderCalls:0,modelSessions:0,fullRequestCompleteness:'PARTIAL',blockers};
}
export function rejectLiveExecution(){throw Object.assign(new Error('LIVE_BOUNDARY_NOT_APPROVED_OR_IMPLEMENTED'),{code:'LIVE_BOUNDARY_NOT_APPROVED_OR_IMPLEMENTED'});}
