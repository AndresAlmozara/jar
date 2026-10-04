import { sha256 } from '../../../core/src/hash.js';

const SAFE_NAMES=new Set(['update_plan']);
const CONDITIONAL_NAMES=new Set(['request_user_input_async','send_message_to_user_async','clock','test_sync_tool']);
const DANGEROUS=/(shell|command|exec|terminal|write|patch|delete|remove|filesystem|file_path|filepath|path|network|http|url|browser|computer|credential|secret|token|mcp|agent|process)/i;

const toolName=tool=>tool?.name??tool?.function?.name;
const toolSchema=tool=>tool?.parameters??tool?.input_schema??tool?.inputSchema??tool?.function?.parameters;

export function summarizeProviderTool(tool){
  const name=toolName(tool),schema=toolSchema(tool),type=tool?.type;
  if(typeof name!=='string'||!name||typeof type!=='string'||!schema||typeof schema!=='object'||Array.isArray(schema))
    throw Error('PROVIDER_TOOL_INVALID');
  return {name,type,schemaHash:sha256(schema),semanticHash:sha256({name,type,description:tool.description??tool.function?.description??'',schema})};
}

export function providerDynamicTool(dynamicTool){
  const project=value=>Array.isArray(value)?value.map(project):value&&typeof value==='object'?Object.fromEntries(Object.entries(value)
    .filter(([key])=>!['minLength','maxLength'].includes(key)).map(([key,item])=>[key,project(item)])):value;
  return {type:'function',name:dynamicTool.name,description:dynamicTool.description,strict:false,parameters:project(dynamicTool.inputSchema)};
}

export function classifyNativeTool(tool){
  const summary=summarizeProviderTool(tool),semanticText=JSON.stringify({description:tool.description??tool.function?.description??'',schema:toolSchema(tool)});
  if(DANGEROUS.test(summary.name)||DANGEROUS.test(semanticText))return {...summary,source:'codex_native',classification:'UNEXPECTED_DANGEROUS'};
  if(SAFE_NAMES.has(summary.name))return {...summary,source:'codex_native',classification:'SAFE_BASELINE'};
  if(CONDITIONAL_NAMES.has(summary.name))return {...summary,source:'codex_native',classification:'CONDITIONAL_BASELINE'};
  return {...summary,source:'codex_native',classification:'UNKNOWN'};
}

export function observeProviderTools({body,dynamicTools=[]}){
  if(!body||!Array.isArray(body.tools))throw Error('PROVIDER_TOOLS_MISSING');
  const expected=new Map(dynamicTools.map(tool=>{const provider=providerDynamicTool(tool);return [tool.name,summarizeProviderTool(provider)];}));
  const native=[],dynamic=[],names=new Set();
  for(const tool of body.tools){
    const summary=summarizeProviderTool(tool);if(names.has(summary.name))throw Error('PROVIDER_TOOL_DUPLICATE');names.add(summary.name);
    const match=expected.get(summary.name);
    if(match){
      // Codex may normalize function metadata while projecting dynamicTools to
      // Responses. Registration identity plus the exact schema hash is the
      // fail-closed attribution boundary; a schema change is never accepted.
      if(match.schemaHash!==summary.schemaHash){const error=Error('DYNAMIC_TOOL_SCHEMA_MISMATCH');
        error.safeDiagnostic={name:summary.name,expectedSchema:toolSchema(providerDynamicTool(dynamicTools.find(item=>item.name===summary.name))),observedSchema:toolSchema(tool)};throw error;}
      dynamic.push({...summary,source:'jar_dynamic',classification:'JAR_DYNAMIC'});
    }else native.push(classifyNativeTool(tool));
  }
  const canonical=rows=>rows.map(({name,type,schemaHash,semanticHash})=>({name,type,schemaHash,semanticHash}));
  return {native,dynamic,effective:[...native,...dynamic].map(row=>({...row})),
    nativeBaselineHash:sha256(canonical(native)),dynamicToolSetHash:sha256(canonical(dynamic)),
    effectiveObservedHash:sha256(canonical([...native,...dynamic]))};
}

export function equivalentCapabilityWarnings({candidateNames,selectedNames,nativeTools}){
  const selected=new Set(selectedNames),nativeNames=new Set(nativeTools.map(tool=>tool.name));
  return candidateNames.filter(name=>!selected.has(name)).map(name=>({dynamicCapability:name,dynamicCapabilityWithheld:true,nativeEquivalentPresent:nativeNames.has(name)}));
}

export function assessBaselinePair({control,assist,candidateNames=[],selectedNames=[]}){
  const baselineEqual=control.nativeBaselineHash===assist.nativeBaselineHash;
  const rejected=[...control.native,...assist.native].filter(tool=>['UNEXPECTED_DANGEROUS','UNKNOWN'].includes(tool.classification));
  const warnings=equivalentCapabilityWarnings({candidateNames,selectedNames,nativeTools:assist.native});
  return {status:!baselineEqual?'PAIR_INVALID':rejected.length?'NATIVE_BASELINE_UNSAFE':'NATIVE_BASELINE_VERIFIED',
    baselineEqual,rejected,warnings};
}

export function validateNativeBaselineProof(proof,{runtimeHash,model,intendedConfigHash,profile}={}){
  if(!proof||proof.schemaVersion!=='jar.native-baseline-proof.v1')return false;
  const {id,...body}=proof;if(id!==`native_baseline_proof_${sha256(body)}`||proof.status!=='NATIVE_BASELINE_VERIFIED')return false;
  const profileMatches=profile?proof.providerId===profile.config.model_provider
    &&proof.intendedProviderEndpoint===profile.config['model_providers.jar_live.base_url']
    &&proof.wireApi===profile.config['model_providers.jar_live.wire_api']
    &&proof.sandboxPolicy===profile.thread.sandbox&&proof.approvalPolicy===profile.thread.approvalPolicy
    &&proof.ephemeral===profile.thread.ephemeral&&sha256(proof.environments)===sha256(profile.thread.environments)
    &&sha256(proof.selectedCapabilityRoots)===sha256(profile.thread.selectedCapabilityRoots)
    &&sha256(proof.disabledFeatures)===sha256(profile.baseline.disabledFeatures):proof.intendedConfigHash===intendedConfigHash;
  return proof.runtimeHash===runtimeHash&&proof.model===model&&profileMatches
    &&proof.control?.nativeBaselineHash===proof.assist?.nativeBaselineHash
    &&proof.control?.native?.every(tool=>['SAFE_BASELINE','CONDITIONAL_BASELINE'].includes(tool.classification))
    &&proof.assist?.native?.every(tool=>['SAFE_BASELINE','CONDITIONAL_BASELINE'].includes(tool.classification));
}
