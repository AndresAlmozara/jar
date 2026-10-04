import { sha256 } from '../../../core/src/hash.js';
import { resolve, join } from 'node:path';

export const LIVE_RUNTIME_HASH='fcd5eafefb4ff4a607f244e099e0974f66e17966b6ffda6948de2ef3a7a79530';
export const LIVE_RUNTIME_VERSION='0.159.2';
const disabled=['apps','plugins','remote_plugin','hooks','browser_use','computer_use','image_generation',
  'multi_agent','multi_agent_v2','memories','memory_tool','code_mode','code_mode_only','js_repl',
  'shell_tool','unified_exec','view_image','request_permissions_tool','skill_search','tool_search',
  'remote_models','api_key_model_discovery','responses_websockets','responses_websockets_v2',
  'shell_snapshot','shell_snapshot_v2','auth_elicitation','daemon_auto_start','recommended_plugins',
  'context_management','token_budget','current_time_reminder','sleep_tool','send_message_to_user_async',
  'tool_suggest','deferred_executor','goals','agent_message_board'];
export function environmentAuth(envKey='JAR_ACCESS_TOKEN',environment=process.env){
  if(typeof envKey!=='string'||!/^JAR_[A-Z][A-Z0-9_]{0,59}$/.test(envKey))throw Error('ENV_KEY_INVALID');
  const present=typeof environment[envKey]==='string'&&environment[envKey].trim().length>0;
  return {authMode:'environment',envKey,credentialPresent:present,authState:present?'provided_not_provider_validated':'absent',
    credentialPersistedInRepo:false,credentialPersistedByJar:false,providerAccessVerified:false};
}
export function jevEnvironmentAuth(environment=process.env){
  const present=typeof environment.TYPESAFE_API_KEY==='string'&&environment.TYPESAFE_API_KEY.trim().length>0;
  return {provider:'typesafe',mode:'live',model:'jev-latest',envKey:'TYPESAFE_API_KEY',credentialPresent:present,
    authState:present?'present':'absent',credentialPersistedByJar:false,credentialLoggedByJar:false,usage:null};
}
export function nativeBaseline(model){
  if(typeof model!=='string'||!/^[-a-zA-Z0-9.]{1,80}$/.test(model))throw Error('MODEL_REQUIRED');
  const body={schemaVersion:'jar.native-baseline.v1',runtimeHash:LIVE_RUNTIME_HASH,model,
    provider:'jar_live',providerEndpoint:'https://api.openai.com/v1',wireApi:'responses',
    nativeBaselineToolIds:['update_plan'],
    conditional:['request_user_input_async','send_message_to_user_async','clock','test_sync_tool'],
    disabled:['exec_command','write_stdin','apply_patch','view_image','MCP','apps','plugins','hooks','web_search',
      'browser','computer','image_generation','multi_agent','memory'],
    classificationEvidence:'intended baseline from source classification; exact host configuration not runtime-observed',
    baselineDirectObserved:false,effectiveObservedToolIds:null,
    disabledFeatures:disabled,environmentAccess:false,approvalPolicy:'never',
    sandbox:{implementation:'host-app-server-no-environments',filesystem:'read-only',networkAccess:false,
      workspaceExecutorNetworkEnforced:false},
    toolObservability:'PARTIAL: app-server events show use, not complete outbound request tools'};
  return Object.freeze({...body,id:sha256(body)});
}
export function assertBaselinePair(control,assist){
  const {id:c,...cb}=control,{id:a,...ab}=assist;
  if(c!==sha256(cb)||a!==sha256(ab)||c!==a)throw Error('PAIR_INVALID');
  return true;
}
export function liveProfile({workspaceRoot,codexHome,model,envKey='JAR_ACCESS_TOKEN',providerBaseUrl='https://api.openai.com/v1'}){
  environmentAuth(envKey,{});const baseline=nativeBaseline(model);
  if(providerBaseUrl!=='https://api.openai.com/v1'&&!/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/.test(providerBaseUrl))throw Error('PROVIDER_ENDPOINT_REJECTED');
  const workspace=resolve(workspaceRoot),home=resolve(codexHome);
  if(home===workspace||home.startsWith(workspace+'\\')||home.startsWith(workspace+'/'))throw Error('PROFILE_INSIDE_MODEL_WORKSPACE');
  const config={model,model_provider:'jar_live',cli_auth_credentials_store:'ephemeral',approval_policy:'never',
    approvals_reviewer:'user',sandbox_mode:'read-only',
    allow_login_shell:false,project_doc_max_bytes:0,project_doc_fallback_filenames:[],
    project_root_markers:[],include_environment_context:false,include_apps_instructions:false,
    check_for_update_on_startup:false,notify:[],web_search:'disabled',
    'history.persistence':'none','analytics.enabled':false,'feedback.enabled':false,
    'otel.exporter':'none','otel.metrics_exporter':'none','otel.trace_exporter':'none','otel.log_user_prompt':false,
    log_dir:join(home,'logs'),sqlite_home:join(home,'state'),
    'skills.include_instructions':false,'skills.bundled.enabled':false,'cloud.skills.enabled':false,
    'agents.enabled':false,'tools.update_plan.enabled':true,'tools.experimental_request_user_input.enabled':false,
    'shell_environment_policy.inherit':'none','shell_environment_policy.set':{},
    'shell_environment_policy.include_only':[],mcp_servers:{},plugins:{},marketplaces:{},
    'model_providers.jar_live.name':'JAR Responses',
    'model_providers.jar_live.base_url':providerBaseUrl,
    'model_providers.jar_live.wire_api':'responses','model_providers.jar_live.env_key':envKey,
    'model_providers.jar_live.requires_openai_auth':false,'model_providers.jar_live.supports_websockets':false,
    'model_providers.jar_live.request_max_retries':0,'model_providers.jar_live.stream_max_retries':0,
    'model_providers.jar_live.stream_idle_timeout_ms':30000,
    ...Object.fromEntries(disabled.map(name=>['features.'+name,false]))};
  const value=v=>typeof v==='object'&&!Array.isArray(v)?'{ '+Object.entries(v).map(([k,x])=>JSON.stringify(k)+' = '+value(x)).join(', ')+' }':JSON.stringify(v);
  const toml=Object.entries(config).map(([k,v])=>k+' = '+value(v)).join('\n')+'\n';
  return {baseline,config,toml,configHash:sha256(toml),workspaceRoot:workspace,codexHome:home,
    thread:{cwd:workspace,model,modelProvider:'jar_live',sandbox:'read-only',approvalPolicy:'never',approvalsReviewer:'user',
      ephemeral:true,environments:[],selectedCapabilityRoots:[]},
    writableRoots:[workspace],toolNetwork:null};
}
