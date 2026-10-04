import { readFile,writeFile,rename,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../../../core/src/hash.js';

export const RPC_MAX_BYTES=65536;
const code=value=>Object.assign(new Error(value),{code:value});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const requestKeys=['schemaVersion','runId','sequence','toolCallId','capabilityId','toolName','arguments','requestHash'];
const responseKeys=['schemaVersion','runId','sequence','toolCallId','requestHash','status','result','errorCode','timing','responseHash'];

export function makeRpcRequest({runId,sequence,toolCallId=randomUUID(),capabilityId,toolName,arguments:args={}}){
  const body={schemaVersion:'jar.sandbox-tool-request.v1',runId,sequence,toolCallId,capabilityId,toolName,arguments:args};
  const message={...body,requestHash:sha256(body)};
  if(Buffer.byteLength(JSON.stringify(message))>RPC_MAX_BYTES)throw code('RPC_REQUEST_OVERSIZED');
  return message;
}
export function validateRpcRequest(message){
  if(!exact(message,requestKeys)||message.schemaVersion!=='jar.sandbox-tool-request.v1'||typeof message.runId!=='string'
    ||!Number.isSafeInteger(message.sequence)||message.sequence<1||typeof message.toolCallId!=='string'
    ||typeof message.capabilityId!=='string'||typeof message.toolName!=='string'||!message.arguments
    ||typeof message.arguments!=='object'||Array.isArray(message.arguments))throw code('RPC_REQUEST_MALFORMED');
  const {requestHash,...body}=message;if(requestHash!==sha256(body))throw code('RPC_REQUEST_HASH_MISMATCH');return message;
}
export function makeRpcResponse(request,{status,result=null,errorCode=null,timing}){
  const body={schemaVersion:'jar.sandbox-tool-response.v1',runId:request.runId,sequence:request.sequence,
    toolCallId:request.toolCallId,requestHash:request.requestHash,status,result,errorCode,timing};
  const message={...body,responseHash:sha256(body)};
  if(Buffer.byteLength(JSON.stringify(message))>RPC_MAX_BYTES)throw code('RPC_RESPONSE_OVERSIZED');return message;
}
export function validateRpcResponse(message,request){
  if(!exact(message,responseKeys)||message.schemaVersion!=='jar.sandbox-tool-response.v1'
    ||!['success','error'].includes(message.status))throw code('RPC_RESPONSE_MALFORMED');
  const {responseHash,...body}=message;if(responseHash!==sha256(body))throw code('RPC_RESPONSE_HASH_MISMATCH');
  if(message.runId!==request.runId||message.sequence!==request.sequence||message.toolCallId!==request.toolCallId
    ||message.requestHash!==request.requestHash)throw code('RPC_RESPONSE_IDENTITY_MISMATCH');return message;
}
export async function writeRpcAtomic(directory,name,value){
  const text=JSON.stringify(value)+'\n';if(Buffer.byteLength(text)>RPC_MAX_BYTES)throw code('RPC_PAYLOAD_OVERSIZED');
  await mkdir(directory,{recursive:true});const temporary=join(directory,`.${name}.${randomUUID()}.tmp`),target=join(directory,name);
  await writeFile(temporary,text,{flag:'wx'});await rename(temporary,target);return target;
}
export async function readRpcBounded(path){
  const bytes=await readFile(path);if(bytes.length>RPC_MAX_BYTES)throw code('RPC_PAYLOAD_OVERSIZED');
  try{return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw code('RPC_JSON_MALFORMED');}
}

export function createSandboxToolCallback({runId,mapping,selectedIds,client}){
  const selected=new Set(selectedIds);let sequence=0;
  return async(name,args={})=>{
    const row=mapping.find(item=>item.native.name===name);
    if(!row||!selected.has(row.capability.id))throw code('TOOL_NOT_EXPOSED');
    const schema=row.native.inputSchema;
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(schema.properties,key))
      ||schema.required.some(key=>typeof args[key]!=='string'))throw code('TOOL_ARGUMENTS_INVALID');
    if(name==='workspace_run'&&!schema.properties.commandId.enum.includes(args.commandId))throw code('UNKNOWN_COMMAND');
    const request=makeRpcRequest({runId,sequence:++sequence,capabilityId:row.capability.id,toolName:name,arguments:args});
    const response=validateRpcResponse(await client.exchange(request),request);
    return response.status==='success'?{success:true,code:'OK',value:response.result}:{success:false,code:response.errorCode,value:null};
  };
}
