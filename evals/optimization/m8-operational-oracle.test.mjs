import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateOperationalFixtures} from './m8-operational-oracle.mjs';

test('M8-E1 independent executor-effect oracle exposes false substitutes without forcing a positive result',async()=>{
  const fixtures=JSON.parse(await readFile(new URL('./fixtures/m8-e1.json',import.meta.url),'utf8')),report=evaluateOperationalFixtures(fixtures);
  assert.ok(report.aggregate.h0.falseSufficient>0);assert.equal(report.aggregate.h1.falseSufficient,1);
  assert.equal(report.aggregate.h1.policyViolations,0);assert.equal(report.aggregate.h2.falseSufficient,0);
  assert.equal(report.aggregate.h2.policyViolations,0);assert.equal(report.gate.pass,true);
  const favorable=report.rows.find(row=>row.id==='favorable-workspace-execute');
  assert.deepEqual(favorable.h0.selected,['history','run']);assert.equal(favorable.h0.operationallySufficient,true);
  const denied=report.rows.find(row=>row.id==='permission-denied');assert.equal(denied.h1.declaredSufficient,false);
  assert.equal(denied.h2.declaredSufficient,false);assert.ok(!denied.h2.selected.includes('run'));
  const incompatible=report.rows.find(row=>row.id==='incompatible-providers');assert.equal(incompatible.h1.semanticCover,true);
  assert.equal(incompatible.h1.declaredSufficient,false);assert.equal(incompatible.h1.falseSufficient,false);
  const rejected=report.rows.find(row=>row.id==='semantic-false-rejection');
  assert.deepEqual(rejected.h2.selected,['history','run']);assert.equal(rejected.h2.operationallySufficient,true);
  const substitutes=report.rows.find(row=>row.id==='true-substitutes');
  assert.deepEqual(substitutes.h2.selected,['run-b']);
});
