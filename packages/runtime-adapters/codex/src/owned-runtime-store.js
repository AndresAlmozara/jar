import {createHash,randomBytes} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {chmod,copyFile,mkdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile as execFileCallback} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {sha256 as stableSha256} from '../../../core/src/hash.js';

const execFile=promisify(execFileCallback);
const VERSION=/\bcodex-cli\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/;
const HASH=/^[a-f0-9]{64}$/;
const VERSION_VALUE=/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function failure(code,details={}){return Object.assign(Error(code),{code,details});}
function assertIdentity({version,sha256}){
  if(!VERSION_VALUE.test(version??''))throw failure('OWNED_RUNTIME_VERSION_INVALID');
  if(!HASH.test(sha256??''))throw failure('OWNED_RUNTIME_HASH_INVALID');
}
export function ownedRuntimeRoot(repo){return join(resolve(repo),'.jar','runtimes','codex');}
export function ownedRuntimePaths(repo,identity){
  assertIdentity(identity);const root=ownedRuntimeRoot(repo),directory=join(root,identity.version,identity.sha256);
  return{root,directory,executable:join(directory,process.platform==='win32'?'codex.exe':'codex'),manifest:join(directory,'manifest.json'),activePin:join(root,'ACTIVE.json'),pinHistory:join(root,'pins')};
}
export async function hashRuntimeFile(file){
  const hash=createHash('sha256');await new Promise((yes,no)=>{const stream=createReadStream(file);stream.on('data',chunk=>hash.update(chunk));stream.once('error',no);stream.once('end',yes);});return hash.digest('hex');
}
async function defaultVersionReader(source,environment){
  const{stdout='',stderr=''}=await execFile(source,['--version'],{windowsHide:true,timeout:10000,maxBuffer:16384,env:{SystemRoot:environment.SystemRoot,WINDIR:environment.WINDIR}});const match=`${stdout} ${stderr}`.match(VERSION);if(!match)throw failure('CODEX_VERSION_UNRECOGNIZED');return match[1];
}
export async function discoverRuntimeIdentity(sourcePath,{environment=process.env,versionReader=defaultVersionReader,hashReader=hashRuntimeFile}={}){
  const source=resolve(sourcePath),info=await stat(source);if(!info.isFile())throw failure('RUNTIME_SOURCE_NOT_FILE');
  const [version,digest]=await Promise.all([versionReader(source,environment),hashReader(source)]);if(!VERSION_VALUE.test(version??''))throw failure('CODEX_VERSION_UNRECOGNIZED');
  return{sourcePath:source,version,sha256:digest,size:info.size};
}
export function validateAdmissionProof(proof,identity){
  assertIdentity(identity);if(!proof||typeof proof!=='object')throw failure('NATIVE_BASELINE_PROOF_REQUIRED');
  const{id,...body}=proof;
  if(id!==`native_baseline_proof_${stableSha256(body)}`)throw failure('NATIVE_BASELINE_PROOF_INTEGRITY_FAILED');
  if(proof.schemaVersion!=='jar.native-baseline-proof.v1'||proof.status!=='NATIVE_BASELINE_VERIFIED')throw failure('NATIVE_BASELINE_NOT_VERIFIED');
  if(proof.runtimeVersion!==identity.version||proof.runtimeHash!==identity.sha256||proof.runtimeSize!==identity.size)throw failure('NATIVE_BASELINE_RUNTIME_MISMATCH');
  const nativeBaselineHash=proof.control?.nativeBaselineHash;
  if(!HASH.test(nativeBaselineHash??'')||nativeBaselineHash!==proof.assist?.nativeBaselineHash||proof.baselineHashesEqual!==true)throw failure('NATIVE_BASELINE_CONTRACT_MISMATCH');
  if(proof.control?.lifecycle?.providerRequestObserved!==true||proof.assist?.lifecycle?.providerRequestObserved!==true)throw failure('NATIVE_BASELINE_LIFECYCLE_INCOMPLETE');
  if(proof.security?.externalProviderCalls!==0||proof.security?.inferenceCalls!==0)throw failure('NATIVE_BASELINE_EXTERNAL_INFERENCE_DETECTED');
  return{proofId:id,nativeBaselineHash};
}
function validateContractReceipt(receipt){
  if(receipt?.status!=='PASS'||!Array.isArray(receipt.tests)||!receipt.tests.length||receipt.tests.some(value=>typeof value!=='string'||!value))throw failure('RUNTIME_CONTRACT_TESTS_REQUIRED');
  return{status:'PASS',tests:[...receipt.tests],completedAt:receipt.completedAt};
}
async function readJson(file){return JSON.parse(await readFile(file,'utf8'));}
function validateManifest(manifest,identity){
  const{id,...body}=manifest;
  if(id!==`owned_codex_runtime_${stableSha256(body)}`)throw failure('OWNED_RUNTIME_MANIFEST_INTEGRITY_FAILED');
  if(manifest.schemaVersion!=='jar.owned-codex-runtime.v1'||manifest.status!=='ADMITTED'||manifest.version!==identity.version||manifest.sha256!==identity.sha256)throw failure('OWNED_RUNTIME_MANIFEST_MISMATCH');
  if(!Number.isSafeInteger(manifest.size)||manifest.size<1||!HASH.test(manifest.nativeBaselineHash??'')||typeof manifest.nativeBaselineProofId!=='string')throw failure('OWNED_RUNTIME_MANIFEST_INVALID');
  validateContractReceipt(manifest.contractTests);return manifest;
}
export async function verifyOwnedRuntime(repo,identity){
  const paths=ownedRuntimePaths(repo,identity);let manifest;
  try{manifest=validateManifest(await readJson(paths.manifest),identity);}catch(error){if(error.code==='ENOENT')throw failure('OWNED_RUNTIME_NOT_ADMITTED');throw error;}
  const info=await stat(paths.executable).catch(()=>null);if(!info?.isFile()||info.size!==manifest.size)throw failure('OWNED_RUNTIME_SIZE_MISMATCH');
  const actualHash=await hashRuntimeFile(paths.executable);if(actualHash!==identity.sha256)throw failure('OWNED_RUNTIME_HASH_MISMATCH',{expected:identity.sha256,actual:actualHash});
  return{path:paths.executable,version:identity.version,sha256:identity.sha256,size:manifest.size,available:true,owned:true,manifestId:manifest.id,manifest};
}
export async function admitOwnedRuntime({repo,sourcePath,proofPath,contractTests,admittedAt=new Date().toISOString(),environment=process.env,versionReader,hashReader}){
  const identity=await discoverRuntimeIdentity(sourcePath,{environment,versionReader,hashReader}),proof=await readJson(resolve(proofPath)),baseline=validateAdmissionProof(proof,identity),receipt=validateContractReceipt(contractTests),paths=ownedRuntimePaths(repo,identity);
  try{return{status:'ALREADY_ADMITTED',candidate:await verifyOwnedRuntime(repo,identity)};}catch(error){if(error.code!=='OWNED_RUNTIME_NOT_ADMITTED')throw error;}
  await mkdir(join(paths.root,identity.version),{recursive:true});const temporary=paths.directory+'.admitting-'+randomBytes(6).toString('hex');await mkdir(temporary,{recursive:false});
  const executable=join(temporary,process.platform==='win32'?'codex.exe':'codex'),manifestPath=join(temporary,'manifest.json');
  try{
    await copyFile(identity.sourcePath,executable,fsConstants.COPYFILE_EXCL);const copiedHash=await hashRuntimeFile(executable);if(copiedHash!==identity.sha256)throw failure('OWNED_RUNTIME_COPY_HASH_MISMATCH',{expected:identity.sha256,actual:copiedHash});
    const body={schemaVersion:'jar.owned-codex-runtime.v1',status:'ADMITTED',runtimeFamily:'codex',sourcePath:identity.sourcePath,version:identity.version,sha256:identity.sha256,size:identity.size,nativeBaselineProofId:baseline.proofId,nativeBaselineHash:baseline.nativeBaselineHash,admittedAt,contractTests:receipt};
    const manifest={id:`owned_codex_runtime_${stableSha256(body)}`,...body};await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});await chmod(executable,0o555);await chmod(manifestPath,0o444);
    await rename(temporary,paths.directory);return{status:'ADMITTED',candidate:await verifyOwnedRuntime(repo,identity)};
  }catch(error){await rm(temporary,{recursive:true,force:true});if(error.code==='EEXIST')return{status:'ALREADY_ADMITTED',candidate:await verifyOwnedRuntime(repo,identity)};throw error;}
}
async function atomicJson(file,value){await mkdir(dirname(resolve(file)),{recursive:true});const temporary=file+'.new-'+randomBytes(6).toString('hex');try{await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await rename(temporary,file);}finally{await rm(temporary,{force:true});}}
export async function pinOwnedRuntime({repo,version,sha256,pinnedAt=new Date().toISOString()}){
  const identity={version,sha256};const candidate=await verifyOwnedRuntime(repo,identity),paths=ownedRuntimePaths(repo,identity);let previous=null;try{previous=await readJson(paths.activePin);}catch(error){if(error.code!=='ENOENT')throw error;}
  const pin={schemaVersion:'jar.owned-codex-runtime-pin.v1',runtimeFamily:'codex',version,sha256,manifestId:candidate.manifestId,pinnedAt,previous:previous?{version:previous.version,sha256:previous.sha256,manifestId:previous.manifestId}:null};
  await mkdir(paths.pinHistory,{recursive:true});const history=join(paths.pinHistory,`${pinnedAt.replace(/[:.]/g,'-')}_${sha256}.json`);await writeFile(history,JSON.stringify(pin,null,2)+'\n',{flag:'wx'});await atomicJson(paths.activePin,pin);return{pin,candidate};
}
export async function resolvePinnedOwnedRuntime(repo,{version,sha256}={}){
  const root=ownedRuntimeRoot(repo),pinPath=join(root,'ACTIVE.json');let pin;try{pin=await readJson(pinPath);}catch(error){if(error.code==='ENOENT')throw failure('OWNED_RUNTIME_PIN_REQUIRED');throw failure('OWNED_RUNTIME_PIN_INVALID');}
  if(pin.schemaVersion!=='jar.owned-codex-runtime-pin.v1'||pin.runtimeFamily!=='codex')throw failure('OWNED_RUNTIME_PIN_INVALID');
  assertIdentity(pin);if(version!==undefined&&pin.version!==version)throw failure('OWNED_RUNTIME_PIN_VERSION_MISMATCH',{expected:version,actual:pin.version});if(sha256!==undefined&&pin.sha256!==sha256)throw failure('OWNED_RUNTIME_PIN_HASH_MISMATCH',{expected:sha256,actual:pin.sha256});
  const candidate=await verifyOwnedRuntime(repo,pin);if(candidate.manifestId!==pin.manifestId)throw failure('OWNED_RUNTIME_PIN_MANIFEST_MISMATCH');return candidate;
}
