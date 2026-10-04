import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeCampaignState,readCampaignState,appendDecision} from './campaign-store.mjs';

test('campaign state replacement and decision append are durable and resumable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'jar-campaign-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const state=join(root,'campaign-state.json'),decisions=join(root,'decisions.jsonl');
  await writeCampaignState(state,{revision:1});await writeCampaignState(state,{revision:2});
  await appendDecision(decisions,{id:'d1'});await appendDecision(decisions,{id:'d2'});
  assert.deepEqual(await readCampaignState(state),{revision:2});
  assert.deepEqual((await readFile(decisions,'utf8')).trim().split('\n').map(JSON.parse),[{id:'d1'},{id:'d2'}]);
});
