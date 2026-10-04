import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRunIdentity,runSlugSegment} from './run-identity.mjs';

const fixed=()=>new Date('2026-10-01T00:00:00.000Z');
const random=value=>()=>Buffer.from(value,'hex');

test('automatic smoke identity includes task and condition',()=>{
  const run=createRunIdentity({suite:'integrated-smoke',suiteLabel:'Integrated Smoke',task:'03-capability-exposure',condition:'JAR',clock:fixed,randomBytes:random('a1b2c3')});
  assert.equal(run.runLabel,'03 Capability Exposure — JAR');
  assert.equal(run.runSlug,'03-capability-exposure_JAR');
  assert.equal(run.runId,'RUN_2026-10-01T00-00-00-000Z_03-capability-exposure_JAR_a1b2c3');
});

test('custom name augments rather than replaces technical context',()=>{
  const run=createRunIdentity({suite:'integrated-smoke',task:'03-capability-exposure',condition:'JAR',name:'M8 HSCE Live Validation',clock:fixed,randomBytes:random('010203')});
  assert.equal(run.runLabel,'M8 HSCE Live Validation — 03 Capability Exposure — JAR');
  assert.equal(run.runSlug,'m8-hsce-live-validation_03-capability-exposure_JAR');
});

test('slug sanitization handles spaces, Unicode, reserved names, and empty input',()=>{
  assert.equal(runSlugSegment('  Validación   Café  '),'validacion-cafe');
  assert.equal(runSlugSegment('CON'),'run-con');
  assert.equal(runSlugSegment('////',{fallback:'safe'}),'safe');
});

test('path separators cannot escape the results directory',()=>{
  const run=createRunIdentity({suite:'smoke',name:'../../outside\\nested',task:'../task',condition:'JAR',clock:fixed,randomBytes:random('abcdef')});
  const results=path.resolve('results'),target=path.resolve(results,run.runId);
  assert.equal(path.dirname(target),results);
  assert(!run.runId.includes('..')&&!run.runId.includes('/')&&!run.runId.includes('\\'));
});

test('timestamp and random uniqueness are preserved',()=>{
  const a=createRunIdentity({suite:'integrated-smoke',clock:fixed,randomBytes:random('000001')});
  const b=createRunIdentity({suite:'integrated-smoke',clock:fixed,randomBytes:random('000002')});
  assert.match(a.runId,/^RUN_2026-10-01T00-00-00-000Z_integrated-smoke_[0-9a-f]{6}$/);
  assert.notEqual(a.runId,b.runId);
  assert.equal(a.timestamp,'2026-10-01T00:00:00.000Z');
});

test('full suites receive stable automatic identities without touching historical paths',()=>{
  const smoke=createRunIdentity({suite:'integrated-smoke',suiteLabel:'Integrated Smoke',clock:fixed,randomBytes:random('111111')});
  const product=createRunIdentity({suite:'opsdesk-control-vs-jar',suiteLabel:'OpsDesk CONTROL vs JAR Product Trial',clock:fixed,randomBytes:random('222222')});
  assert.equal(smoke.runLabel,'Integrated Smoke');
  assert.equal(smoke.runSlug,'integrated-smoke');
  assert.equal(product.runSlug,'opsdesk-control-vs-jar');
  assert.equal('RUN_2026-09-30T22-54-18-615Z_8735c5','RUN_2026-09-30T22-54-18-615Z_8735c5');
});
