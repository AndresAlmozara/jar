import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
import {PRODUCT_FAMILIES} from "./datasets.mjs";

export function materializeProduct(family,root){const definition=PRODUCT_FAMILIES[family];if(!definition)throw Error("PRODUCT_FAMILY_UNKNOWN");for(const [relative,body] of Object.entries(definition.files)){const file=path.join(root,...relative.split("/"));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}return definition;}
const check=(id,pass,critical=true,details=null)=>({id,pass:Boolean(pass),critical,details});
export async function evaluateProduct(family,root){
  const run=spawnSync(process.execPath,["--test"],{cwd:root,encoding:"utf8",timeout:120000}),url=pathToFileURL(path.join(root,"src","index.js"));url.searchParams.set("diagnostic",`${Date.now()}-${Math.random()}`);let module,error=null;
  try{module=await import(url.href);}catch(caught){error=caught;}
  const checks=[check("module-load",!error,true,error?.message??null),check("public-tests",run.status===0,true,{exitCode:run.status,stdout:run.stdout?.slice(-2000),stderr:run.stderr?.slice(-2000)})];
  if(module){
    if(family==="m8-cache")checks.push(check("ttl-boundary",module.isFresh(0,1000,1000)===true&&module.isFresh(0,1001,1000)===false));
    if(family==="m8-redaction")checks.push(check("recursive-sensitive-keys",JSON.stringify(module.sanitize({token:"a",password:"b",deep:{secret:"c"},ok:"d"}))===JSON.stringify({token:"[REDACTED]",password:"[REDACTED]",deep:{secret:"[REDACTED]"},ok:"d"})));
    if(family==="m6-retry")checks.push(check("bounded-exponential",module.delay(0,2,10)===1&&module.delay(5,2,10)===10));
    if(family==="m6-merge")checks.push(check("nested-default-preservation",JSON.stringify(module.applyConfig({a:{b:1,c:2},list:[1]},{a:{b:3},list:[2]}))===JSON.stringify({a:{b:3,c:2},list:[2]})));
  }
  return{family,correct:checks.filter(x=>x.critical).every(x=>x.pass),passed:checks.filter(x=>x.pass).length,total:checks.length,checks};
}
export async function calibrateProducts(){
  const rows=[];
  for(const [family,definition] of Object.entries(PRODUCT_FAMILIES)){
    const starter=fs.mkdtempSync(path.join(os.tmpdir(),"jar-diag-starter-")),good=fs.mkdtempSync(path.join(os.tmpdir(),"jar-diag-good-"));
    try{materializeProduct(family,starter);materializeProduct(family,good);fs.writeFileSync(path.join(good,"src","index.js"),definition.knownGoodSource);const broken=await evaluateProduct(family,starter),knownGood=await evaluateProduct(family,good);rows.push({family,starterExpected:"INCORRECT",starterObserved:broken.correct?"CORRECT":"INCORRECT",knownGoodExpected:"CORRECT",knownGoodObserved:knownGood.correct?"CORRECT":"INCORRECT",pass:!broken.correct&&knownGood.correct,broken,knownGood});}
    finally{fs.rmSync(starter,{recursive:true,force:true});fs.rmSync(good,{recursive:true,force:true});}
  }
  return{status:rows.every(x=>x.pass)?"PASS":"FAIL",rows};
}
