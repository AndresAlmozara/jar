import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "../../core/src/hash.js";
import { positiveLimit } from "./contracts.js";

const exec=promisify(execFile);
export class LocalRepositoryAdapter {
  constructor(root,{maxFiles=500}={}) { this.root=path.resolve(root);this.maxFiles=positiveLimit(maxFiles,"maxFiles"); }
  async snapshot() {
    let root=this.root;
    try { root=await fs.realpath(root);if(!(await fs.stat(root)).isDirectory())throw Error("not directory"); }
    catch { return {id:sha256(root),repositoryId:sha256(root),root,status:"unavailable",files:[],error:{code:"repository_unavailable"}}; }
    const repositoryId=sha256(root),git={commit:null,dirty:null,statusHash:null};
    try {
      const opts={cwd:root,windowsHide:true,timeout:10000,maxBuffer:4*1024*1024};
      const prefix=["-c",`safe.directory=${root}`];
      git.commit=(await exec("git",[...prefix,"rev-parse","HEAD"],opts)).stdout.trim();
      const status=(await exec("git",[...prefix,"status","--porcelain=v1","-z","--untracked-files=all"],opts)).stdout;
      git.dirty=Boolean(status);git.statusHash=sha256(status);
    } catch { /* Non-Git directories remain supported; unknown provenance stays null. */ }
    let files;
    try {
      let stdout;
      try { ({stdout}=await exec("rg",["--no-config","--files","--null","--glob","!.jar/**","--glob","!.git/**"],{cwd:root,windowsHide:true,timeout:15000,maxBuffer:8*1024*1024})); }
      catch(error){if(error.code===1&&error.stdout==="")stdout="";else throw error}
      files=[...new Set(stdout.split("\0").filter(Boolean).map(p=>p.replaceAll("\\","/")))].sort();
    } catch { return {id:sha256({repositoryId,git}),repositoryId,root,git,status:"error",files:[],error:{code:"repository_discovery_failed"}}; }
    const id=sha256({repositoryId,git,files});
    return {id,repositoryId,root,git,status:"ready",files:files.slice(0,this.maxFiles),discoveredCount:files.length,discoveryTruncated:files.length>this.maxFiles,error:null,capturedAt:new Date().toISOString()};
  }
}

export async function readRepositoryFile(repository,relativePath,maxBytes) {
  if(typeof relativePath!=="string"||path.isAbsolute(relativePath)||relativePath.split(/[\\/]/).includes(".."))throw Object.assign(Error("unsafe path"),{code:"unsafe_candidate_path"});
  const resolved=await fs.realpath(path.join(repository.root,relativePath));
  const relative=path.relative(repository.root,resolved);
  if(relative.startsWith(`..${path.sep}`)||relative===".."||path.isAbsolute(relative))throw Object.assign(Error("outside root"),{code:"unsafe_candidate_path"});
  const handle=await fs.open(resolved,"r");
  try {
    const info=await handle.stat();if(!info.isFile()||info.size>maxBytes)return null;
    const buffer=Buffer.alloc(maxBytes+1);let total=0;
    while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead}
    if(total>maxBytes||buffer.subarray(0,total).includes(0))return {text:null,byteLength:total};
    const bytes=buffer.subarray(0,total);
    let text;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes)}catch{return {text:null,byteLength:total}}
    return {text,byteLength:bytes.length,sourceHash:sha256(bytes.toString("base64"))};
  } finally {await handle.close()}
}
