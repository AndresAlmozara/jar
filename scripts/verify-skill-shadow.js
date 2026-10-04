import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EccCatalogAdapter } from "../packages/catalog-adapters/ecc/src/ecc-catalog-adapter.js";
import { SkillShadowTournament, deriveEccHierarchy } from "../packages/skill-routing/src/index.js";
import { createSkillStrategies, offlineSkillEngine } from "../bin/skill-shadow.js";

const root=process.argv[2];
if(!root)throw Error("ECC root argument required");
const status=()=>execFileSync("git",["-c",`safe.directory=${root}`,"status","--porcelain"],{cwd:root,windowsHide:true,encoding:"utf8"});
const beforeStatus=status();
const adapter=new EccCatalogAdapter(root),validation=await adapter.validate();assert.equal(validation.ok,true);
const catalog=await adapter.snapshot(),before=structuredClone(catalog),hierarchy=deriveEccHierarchy(catalog);
assert.equal(hierarchy.supported,true);assert.ok(catalog.source.git_commit);
assert.equal(new Set(hierarchy.groups.flatMap(g=>g.memberIds)).size,catalog.skills.length);
assert.equal(hierarchy.groups.reduce((sum,g)=>sum+g.memberIds.length,0),catalog.skills.length);
const result=await new SkillShadowTournament().run({task:{id:"real-ecc-offline",text:"Fix a failing PostgreSQL migration and add regression tests."},catalog,strategies:createSkillStrategies(offlineSkillEngine())});
assert.equal(result.results.length,5);assert.ok(result.results.every(r=>r.proposal.decision.outcome!=="error"));
assert.deepEqual(catalog,before);assert.equal((await adapter.snapshot()).hash,catalog.hash);assert.equal(validation.hash,catalog.hash);assert.equal(status(),beforeStatus);
console.log(JSON.stringify({mode:"offline-synthetic",skills:catalog.skills.length,catalog_hash:catalog.hash,source:catalog.source,groups:hierarchy.groups.length,mapped:catalog.skills.length,unmapped:hierarchy.unmappedSkillIds,multiply_mapped:hierarchy.multiplyMappedSkillIds,read_only:true,outcomes:result.results.map(r=>({strategy:r.strategy_id,outcome:r.proposal.decision.outcome}))},null,2));
