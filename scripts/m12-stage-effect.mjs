import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
const root=process.cwd(),dest=resolve('.jar/m12-effect-input-v1'),output=resolve('.jar/m12-effect-output-v1');
const hash=b=>createHash('sha256').update(b).digest('hex');
const old=JSON.parse(await readFile('.jar/m11-capture-input-v7/manifest.json','utf8'));
const paths=new Map(old.files.map(f=>[f.relativePath,resolve('.jar/m11-capture-input-v7',f.relativePath)]));
async function add(path){
  const rel=relative(root,path).replaceAll('\\','/');if(rel.startsWith('../'))throw Error('Escaped package');
  if(paths.get(rel)===path)return;
  paths.set(rel,path);
  if(/\.(mjs|js)$/.test(path)){
    const source=await readFile(path,'utf8');
    for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g))await add(resolve(dirname(path),match[1]));
  }
}
for(const path of ['scripts/m12-effect-spike.mjs','scripts/m12-effect-guest.ps1'])await add(resolve(path));
await mkdir(dest);await mkdir(output);
const files=[];
for(const [relativePath,source] of paths){const bytes=await readFile(source);await mkdir(dirname(resolve(dest,relativePath)),{recursive:true});
  await copyFile(source,resolve(dest,relativePath));files.push({relativePath,size:bytes.length,sha256:hash(bytes)});}
const manifest=JSON.stringify({schemaVersion:'m12.isolated-package.v1',files},null,2)+'\n';
await writeFile(resolve(dest,'m12-manifest.json'),manifest,{flag:'wx'});
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const wsb=`<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><MappedFolders><MappedFolder><HostFolder>${xml(dest)}</HostFolder><SandboxFolder>C:\\M11\\input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xml(output)}</HostFolder><SandboxFolder>C:\\M11\\output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\M11\\input\\scripts\\m12-effect-guest.ps1 -ExpectedManifestHash ${hash(manifest)}</Command></LogonCommand></Configuration>\n`;
await writeFile('.jar/m12-effect-v1.wsb',wsb,{flag:'wx'});
console.log(JSON.stringify({dest,output,manifestHash:hash(manifest),files:files.length}));
