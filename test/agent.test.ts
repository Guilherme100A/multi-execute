import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cliResult,validModel} from '../src/agent.js';
import {Store} from '../src/store.js';

test('CLI streams extract each provider session, final answer and errors',()=>{
  assert.equal(cliResult(JSON.stringify({type:'thread.started',thread_id:'codex-thread'}),'codex').thread,'codex-thread');
  assert.equal(cliResult(JSON.stringify({type:'system',subtype:'init',session_id:'claude-thread'}),'claude').thread,'claude-thread');
  assert.equal(cliResult(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'mcp__roblox__get-metadata'}]}}),'claude').text,'→ mcp__roblox__get-metadata');
  assert.equal(cliResult(JSON.stringify({type:'result',result:'confirmed',is_error:false}),'claude').final,'confirmed');
  assert.match(cliResult(JSON.stringify({type:'result',is_error:true,errors:['Not authenticated']}),'claude').error!,/Not authenticated/);
  for(const value of ['sonnet','claude-opus-5','gpt-6.1-sol','sonnet[1m]']) assert.equal(validModel(value),true);
  for(const value of ['--shell','bad model','$(whoami)','',null]) assert.equal(validModel(value),false);
});

test('agent choice and run identity persist; contexts remain separate by CLI and model',()=>{
  const store=new Store(':memory:');
  try {
    store.setAgentSettings({provider:'claude',model:'sonnet'});
    assert.deepEqual({...store.agentSettings()},{provider:'claude',model:'sonnet'});
    const row=store.create('123456','123456','alpha').session;
    const run=store.createPrompt(row,'hello',{provider:'claude',model:'sonnet'});
    assert.equal(run.provider,'claude'); assert.equal(run.model,'sonnet');
    store.setAgentThread(`${row.worker_id}:codex:model-a`,'codex-thread');
    store.setAgentThread(`${row.worker_id}:claude:sonnet`,'claude-thread');
    assert.equal(store.agentThread(`${row.worker_id}:codex:model-a`),'codex-thread');
    assert.equal(store.agentThread(`${row.worker_id}:claude:sonnet`),'claude-thread');
    assert.equal(store.agentThread(`${row.worker_id}:claude:opus`),undefined);
  } finally {store.close();}
});
