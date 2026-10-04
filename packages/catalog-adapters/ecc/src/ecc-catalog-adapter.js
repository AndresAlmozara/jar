import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "../../../core/src/hash.js";

const execFileAsync = promisify(execFile);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function firstParagraph(markdown) {
  const body = markdown.replace(/^---[\s\S]*?---\s*/m, "").split(/\r?\n/);
  const lines=[];
  for (const raw of body) {
    const line=raw.trim();
    if (!line) { if (lines.length) break; else continue; }
    if (/^#/.test(line)) continue;
    if (/^```/.test(line)) continue;
    lines.push(line);
  }
  return lines.join(" ").slice(0, 1200);
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return {};
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return {};
  const out={};
  for (const line of markdown.slice(3,end).split(/\r?\n/)) {
    const m=line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v=m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v=v.slice(1,-1);
    out[m[1]]=v;
  }
  return out;
}

function titleFromMarkdown(markdown, fallback) {
  const fm=parseFrontmatter(markdown);
  if (fm.name) return fm.name;
  const h=markdown.match(/^#\s+(.+)$/m);
  return h?.[1]?.trim() || fallback;
}

function collectSkills(root) {
  const skillsRoot=path.join(root,"skills");
  if (!fs.existsSync(skillsRoot)) return [];
  const items=[];
  for (const entry of fs.readdirSync(skillsRoot,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const skillFile=path.join(skillsRoot,entry.name,"SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const raw=fs.readFileSync(skillFile,"utf8");
    const fm=parseFrontmatter(raw);
    items.push({
      id: entry.name,
      name: titleFromMarkdown(raw, entry.name),
      description: fm.description || firstParagraph(raw),
      relativePath: path.relative(root,skillFile).replaceAll(path.sep,"/"),
      sourceHash: sha256(raw),
      metadata: fm,
    });
  }
  return items.sort((a,b)=>a.id.localeCompare(b.id));
}

function collectAgents(root) {
  const agentsRoot=path.join(root,"agents");
  if (!fs.existsSync(agentsRoot)) return [];
  const items=[];
  for (const entry of fs.readdirSync(agentsRoot,{withFileTypes:true})) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file=path.join(agentsRoot,entry.name);
    const raw=fs.readFileSync(file,"utf8");
    const id=entry.name.replace(/\.md$/i,"");
    items.push({id,name:titleFromMarkdown(raw,id),description:firstParagraph(raw),relativePath:path.relative(root,file).replaceAll(path.sep,"/"),sourceHash:sha256(raw)});
  }
  return items.sort((a,b)=>a.id.localeCompare(b.id));
}

async function gitProvenance(root) {
  let git_commit=null;
  let git_dirty=null;
  const gitArgs=["-c",`safe.directory=${root}`];
  try {
    const {stdout}=await execFileAsync("git",[...gitArgs,"rev-parse","HEAD"],{cwd:root,windowsHide:true});
    const commit=stdout.trim();
    if (commit) git_commit=commit;
  } catch {}
  try {
    const {stdout}=await execFileAsync("git",[...gitArgs,"status","--porcelain"],{cwd:root,windowsHide:true});
    git_dirty=stdout.split(/\r?\n/).some((line)=>line.trim().length>0);
  } catch {}
  return {type:"ecc",root,git_commit,git_dirty};
}

export class EccCatalogAdapter {
  constructor(eccRoot) { this.root=path.resolve(eccRoot); }

  async snapshot() {
    const componentsDoc=readJson(path.join(this.root,"manifests","install-components.json"),{components:[]});
    const modulesDoc=readJson(path.join(this.root,"manifests","install-modules.json"),{modules:[]});
    const profilesDoc=readJson(path.join(this.root,"manifests","install-profiles.json"),{profiles:{}});
    const skills=collectSkills(this.root);
    const agents=collectAgents(this.root);
    const components=Array.isArray(componentsDoc.components) ? componentsDoc.components : [];
    const modules=Array.isArray(modulesDoc.modules) ? modulesDoc.modules : [];
    const profiles=profilesDoc.profiles ?? {};
    const semantic={skills,agents,components,modules,profiles};
    return {
      version: "ecc.catalog.v1",
      source: await gitProvenance(this.root),
      hash: sha256(semantic),
      generatedAt: new Date().toISOString(),
      skills, agents, components, modules, profiles,
    };
  }

  async validate() {
    const snapshot=await this.snapshot();
    const errors=[];
    const warnings=[];
    if (!fs.existsSync(path.join(this.root,"skills"))) errors.push("missing canonical skills/ directory");
    if (snapshot.skills.length===0) errors.push("no canonical skills discovered");
    const ids=new Set();
    for (const s of snapshot.skills) {
      if (ids.has(s.id)) errors.push(`duplicate skill id: ${s.id}`);
      ids.add(s.id);
      if (!s.description) warnings.push(`skill has no routing description: ${s.id}`);
    }
    return {ok:errors.length===0,errors,warnings,counts:{skills:snapshot.skills.length,agents:snapshot.agents.length,components:snapshot.components.length,modules:snapshot.modules.length,profiles:Object.keys(snapshot.profiles).length},hash:snapshot.hash};
  }
}
