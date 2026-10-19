// Opt-in test: invokes both locally authenticated CLIs and consumes their usage.
// The MCP fixture returns a random proof; no Roblox game is changed or opened.
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {AgentRunner} from '../src/agent.js';
import {Store} from '../src/store.js';
import {Pipeline} from '../src/pipeline.js';
import {createApp} from '../src/app.js';

const store=new Store(':memory:');
const token=randomUUID(), callback=randomUUID(), autoexec=randomUUID();
const log={info(){},error(){}};
const proofs=new Map<string,string>();
let observedWorker='';
const mcp={
  async health(){}, async sessions(){return [];},async processes(){return [];},async execute(){},
  async tools(){return [{name:'get-metadata',description:'Read the proof value from this assigned worker.',inputSchema:{type:'object',properties:{workerId:{type:'string'}}}}];},
  async callTool(_name:string,args:Record<string,unknown>){observedWorker=String(args.workerId);return {proof:proofs.get(observedWorker)};},
};
const pipeline=new Pipeline(store,{async launch(){}},mcp,[],new Set(['123456']),log);
pipeline.online=true;
let runner:AgentRunner;
// The proxy delegates to the runner created after the ephemeral port is known.
const proxy={mcpRpc:(...args:Parameters<AgentRunner['mcpRpc']>)=>runner.mcpRpc(...args)} as AgentRunner;
const server=createApp(pipeline,token,callback,autoexec,'findings',log,proxy).listen(0,'127.0.0.1');
await new Promise<void>(resolve=>server.once('listening',resolve));
const address=server.address(); assert.ok(address && typeof address==='object');
runner=new AgentRunner(process.platform==='win32'?'codex.cmd':'codex','gpt-6.1-sol',`http://127.0.0.1:${address.port}`,callback,mcp,undefined,90_000);
try {
  for(const provider of ['codex','claude'] as const){
    const selection={provider,model:provider==='codex'?'gpt-6.1-sol':'sonnet'};
    runner.select(selection);
    const row=store.create('123456','123456',provider).session;
    store.transition(row.id,'launching');store.transition(row.id,'connected',null,provider);
    const proof=randomUUID(); proofs.set(row.worker_id,proof); observedWorker='';
    let thread='';
    const answer=await runner.run(row.worker_id,'Use get-metadata e responda somente com o valor exato de proof retornado pela ferramenta.', '', undefined,undefined,id=>{thread=id;},undefined,selection);
    assert.ok(answer.includes(proof),'CLI did not return the tool proof');
    assert.equal(observedWorker,row.worker_id);assert.ok(thread,'No CLI session ID received');
    const resumed=await runner.run(row.worker_id,'Sem chamar ferramentas: repita o valor de proof que você leu na mensagem anterior.', '',undefined,thread,undefined,undefined,selection);
    assert.ok(resumed.includes(proof),'CLI did not resume its own context');
    console.log(`${provider}: resposta real + MCP autenticado + worker isolado + retomada de contexto confirmados`);
  }
} finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
