import { test, expect } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

test('live updates preserve drafts, focus and scroll; disconnected games leave the workspace; stream reconnects', async ({ page }, info) => {
  test.setTimeout(30_000);
  const sessions = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'old'].map((alias, i, rows) => ({ group_id: i < 4 ? 'same-game-group' : i < 7 ? 'multi-game-group' : 'old-group', group_mode: i < 4 ? 'same-game' : 'multi-game', id: alias, account_alias: alias, worker_id: `worker-${alias}`, place_id: `${123456+i}`, status: i===rows.length-1 ? 'failed' : 'connected', retry_count: 1 }));
  let snapshot = { mcp_online: true, sessions, runs: [{ id:'run',session_id:'alpha',worker_id:'worker-alpha',prompt:'Observação',response:'Linha de resultado\n'.repeat(100),status:'running',updated_at:1 }] };
  let stream: ServerResponse | undefined;
  let connections=0;
  let choice={provider:'codex',model:'test'};
  let agentPolicy: {filename:string;content:string} | null = null;
  let groupLaunch: {link:string;aliases:string[]} | undefined;
  const server=createServer((req,res)=>{
    const path=req.url!;
    if (path==='/events') {
      connections++; stream=res; res.writeHead(200,{'content-type':'text/event-stream'}); res.write(`data: ${JSON.stringify(snapshot)}\n\n`); return;
    }
    if (path==='/agent-settings') { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{choice=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({selection:choice}));});return; }
    if (path==='/agent-policy') {
      if (req.method === 'POST') { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{agentPolicy=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({policy:agentPolicy}));}); }
      else {res.setHeader('content-type','application/json');res.end(JSON.stringify({policy:agentPolicy}));}
      return;
    }
    if (path==='/config') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({accounts:['alpha','beta','gamma'].map(alias=>({alias,username:alias})),agent:{configured:true,provider:choice.provider==='claude'?'Claude Code':'Codex CLI',model:choice.model,selection:choice,providers:[{id:'codex',label:'Codex CLI',installed:true,models:[{id:'test',label:'Test model'}]},{id:'claude',label:'Claude Code',installed:true,models:[{id:'sonnet',label:'Sonnet'},{id:'opus',label:'Opus'}]}]}})); return; }
    if (path==='/launch-group') { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{groupLaunch=JSON.parse(body);res.statusCode=202;res.setHeader('content-type','application/json');res.end(JSON.stringify({sessions:groupLaunch!.aliases.map(alias=>({session:{id:alias,group_id:'same-game-group'}}))}));});return; }
    if (path==='/status' || path==='/prompts') { res.setHeader('content-type','application/json'); res.end(JSON.stringify(path==='/status'?snapshot:{runs:snapshot.runs})); return; }
    const files: Record<string,string>={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
    if (!files[path]) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(`public/${files[path]}`));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if (!address || typeof address==='string') throw new Error('No server address');
  const errors: string[]=[]; page.on('pageerror',error=>errors.push(error.message));
  let navigations=0; page.on('framenavigated',frame=>{if(frame===page.mainFrame()) navigations++;});
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.locator('#navSessionCount')).toHaveText('2');
    await page.locator('[data-view="group"]').click();
    await expect(page.locator('#accountChoices .account-choice')).toHaveCount(3);
    await expect(page.locator('#accountChoices input:checked')).toHaveCount(3);
    await page.screenshot({path:info.outputPath('multi-account-launch.png'),fullPage:true});
    await page.locator('#groupGame').fill('https://www.roblox.com/games/123456/Test');
    await page.locator('#groupLaunchButton').click();
    await expect.poll(()=>groupLaunch).toEqual({link:'https://www.roblox.com/games/123456/Test',aliases:['alpha','beta','gamma']});
    await page.locator('[data-view="console"]').click();
    await expect(page.locator('.worker-terminal')).toHaveCount(7);
    await expect(page.locator('.worker-terminal:visible')).toHaveCount(4);
    await expect(page.locator('#batchTerminalOutput')).toContainText('[alpha]');
    await expect(page.locator('#batchTerminalOutput')).not.toContainText('[epsilon]');
    await page.locator('#workspaceTabs [data-group-id="multi-game-group"]').click();
    await expect(page.locator('.worker-terminal:visible')).toHaveCount(3);
    await expect(page.locator('#batchTerminalOutput')).toContainText('[epsilon]');
    await expect(page.locator('#batchTerminalOutput')).not.toContainText('[alpha]');
    await expect(page.locator('.worker-terminal[data-session-id="alpha"]')).toBeHidden();
    await page.locator('#workspaceTabs [data-group-id="same-game-group"]').click();
    const input=page.locator('.worker-terminal[data-session-id="alpha"] textarea');
    const output=page.locator('.worker-terminal[data-session-id="alpha"] .worker-terminal-output');
    await input.fill('Meu rascunho ainda não enviado');
    await output.evaluate(element=>{element.scrollTop=100;});
    snapshot.runs[0]!.updated_at=2; snapshot.runs[0]!.response+='Atualização recebida';
    stream!.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    await expect(output).toContainText('Atualização recebida');
    await expect(input).toBeFocused(); await expect(input).toHaveValue('Meu rascunho ainda não enviado');
    expect(await output.evaluate(element=>element.scrollTop)).toBe(100);
    sessions[1]!.status='disconnected'; stream!.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    await expect(page.locator('.worker-terminal')).toHaveCount(6);
    await expect(page.locator('#navSessionCount')).toHaveText('2');
    await expect(page.locator('#historyCount')).toHaveText('2');
    // A normal EOF must reconnect, just like a network failure.
    stream!.end();
    await expect(page.locator('#feedState')).toContainText('Reconectando');
    await expect(input).toBeDisabled();
    await expect.poll(()=>connections).toBe(2);
    await expect(page.locator('#feedState')).toContainText('ao vivo');
    await expect(input).toBeEnabled(); await expect(input).toHaveValue('Meu rascunho ainda não enviado');
    expect(navigations).toBe(1); expect(errors).toEqual([]);
    await page.locator('[data-view="agents"]').click();
    await expect(page.locator('#activeAgentProvider')).toHaveText('Codex CLI');
    await page.locator('#policyContent').fill('# AGENTS.md\n\nInstruções de teste ainda não salvas.');
    await page.locator('[data-view="console"]').click();
    await page.locator('[data-view="agents"]').click();
    await expect(page.locator('#policyContent')).toHaveValue('# AGENTS.md\n\nInstruções de teste ainda não salvas.');
    await page.locator('#saveAgentPolicy').click();
    await expect(page.locator('#policyMessage')).toContainText('AGENTS.md salvo');
    expect(agentPolicy).toEqual({filename:'AGENTS.md',content:'# AGENTS.md\n\nInstruções de teste ainda não salvas.'});
    await page.locator('#agentProvider').selectOption('claude');
    await expect(page.locator('#agentModel')).toHaveValue('sonnet');
    await page.locator('#agentModel').selectOption('opus');
    await page.locator('#saveAgentSettings').click();
    await expect(page.locator('#model')).toHaveText('Claude Code · opus');
    expect(choice).toEqual({provider:'claude',model:'opus'});
    await expect(page.locator('#activeAgentModel')).toHaveText('opus');
    await page.locator('[data-view="console"]').click();
    await expect(input).toHaveValue('Meu rascunho ainda não enviado');
    await page.screenshot({path:info.outputPath('minimal-black-live.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.locator('[data-view="sessions"]').click();
    await expect(page.locator('#sessions .session')).toHaveCount(2);
    await expect(page.locator('#sessionHistory')).not.toHaveAttribute('open','');
    await page.locator('#sessionHistory summary').click();
    await expect(page.locator('#historySessions .session')).toHaveCount(2);
    await page.screenshot({path:info.outputPath('mobile-sessions.png'),fullPage:true});
  } finally { await page.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
