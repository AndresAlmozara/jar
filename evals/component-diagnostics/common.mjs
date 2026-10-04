import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {atomic,iso} from "../smoke-test/lib/common.mjs";

export const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const REPO=path.resolve(ROOT,"../..");
const gitMarker=path.join(REPO,".git"),gitText=fs.existsSync(gitMarker)&&fs.statSync(gitMarker).isFile()?fs.readFileSync(gitMarker,"utf8").trim():null,
  gitDir=gitText?.startsWith("gitdir:")?path.resolve(REPO,gitText.slice(7).trim()):path.join(REPO,".git"),marker=gitDir.toLowerCase().lastIndexOf(`${path.sep}.git${path.sep}`),
  EVIDENCE_REPO=process.env.JAR_DIAGNOSTIC_EVIDENCE_REPO?path.resolve(process.env.JAR_DIAGNOSTIC_EVIDENCE_REPO):marker>=0?gitDir.slice(0,marker):REPO;
export const CAMPAIGN_ROOT=path.join(EVIDENCE_REPO,".jar","evaluation","component-diagnostics","m6-m8-permanent-v1");
export const STATE_PATH=path.join(CAMPAIGN_ROOT,"campaign-state.json");
export const SPEC_PATH=path.join(ROOT,"spec.json");
export const PLAN_PATH=path.join(ROOT,"campaign-plan.json");
export const sha=value=>crypto.createHash("sha256").update(typeof value==="string"||Buffer.isBuffer(value)?value:canonical(value)).digest("hex");
export const canonical=value=>JSON.stringify(value,Object.keys(value??{}).sort());
export const now=iso;
export const writeJson=(file,value)=>atomic(file,value);
export function readJson(file){return JSON.parse(fs.readFileSync(file,"utf8"));}
export function fileHash(file){return fs.existsSync(file)?sha(fs.readFileSync(file)):null;}
export function treeIdentity(root,{exclude=[]}={}){
  if(!fs.existsSync(root))return{exists:false,files:0,sha256:null};const rows=[];
  const walk=(dir,relative="")=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const rel=relative+entry.name,full=path.join(dir,entry.name);if(exclude.some(x=>rel===x||rel.startsWith(x+"/")))continue;if(entry.isDirectory())walk(full,rel+"/");else if(entry.isFile())rows.push({path:rel,bytes:fs.statSync(full).size,sha256:fileHash(full)});}};
  walk(root);return{exists:true,files:rows.length,sha256:sha(JSON.stringify(rows))};
}
export function loadSpec(){const spec=readJson(SPEC_PATH),copy=structuredClone(spec),expected=copy.freeze.specHash;delete copy.freeze.specHash;const actual=sha(JSON.stringify(copy));if(actual!==expected)throw Object.assign(Error("DIAGNOSTIC_SPEC_HASH_MISMATCH"),{code:"DIAGNOSTIC_SPEC_HASH_MISMATCH",expected,actual});return spec;}
