const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('pipeline-token') || '';
let selected = null;
let lastRuns = '';

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function connect() {
  const config = await loadConfig();
  $('model').textContent = config.agent.configured ? config.agent.model : 'OPENAI NÃO CONFIGURADA';
  $('login').hidden = true; $('dashboard').hidden = false;
  await refresh();
}

async function loadConfig() {
  const config = await api('/config');
  $('account').replaceChildren(...config.accounts.map(row => new Option(`${row.alias} (${row.username})`, row.alias)));
  return config;
}

async function refreshRam() {
  $('accountMessage').textContent = 'Consultando o RAM local…';
  try {
    const data = await api('/accounts/ram');
    $('ramAccount').replaceChildren(...data.accounts.map(username => new Option(username, username)));
    $('accountMessage').textContent = data.accounts.length ? `${data.accounts.length} conta(s) encontrada(s) no RAM.` : 'Nenhuma conta encontrada no RAM.';
  } catch (error) { $('accountMessage').textContent = error.message; }
}

async function loadPolicy() {
  const data = await api('/agent-policy');
  $('policyFilename').textContent = data.policy ? `${data.policy.filename} · salvo globalmente` : 'Nenhum arquivo salvo';
  $('policyContent').value = data.policy?.content || '';
}

function sessionCard(row) {
  const card = document.createElement('article');
  card.className = `session${selected === row.id ? ' selected' : ''}`;
  const top = document.createElement('div'); top.className = 'session-top';
  const name = document.createElement('span'); name.className = 'session-name'; name.textContent = row.account_alias;
  const status = document.createElement('span'); status.className = `status ${row.status}`; status.textContent = row.status;
  top.append(name, status);
  const meta = document.createElement('div'); meta.className = 'session-meta';
  meta.textContent = `Place ${row.place_id}\n${row.worker_id}`;
  card.append(top, meta);
  if (['failed','disconnected'].includes(row.status) && row.retry_count === 0) {
    const retry = document.createElement('button'); retry.className = 'retry'; retry.textContent = 'Tentar novamente';
    retry.onclick = async event => { event.stopPropagation(); await api(`/sessions/${row.id}/retry`, { method:'POST' }); await refresh(); };
    card.append(retry);
  }
  card.onclick = () => { selected = row.id; refresh().catch(showFatal); };
  return card;
}

function renderRuns(runs) {
  const signature = JSON.stringify(runs.map(r => [r.id,r.status,r.updated_at]));
  if (signature === lastRuns) return; lastRuns = signature;
  const output = $('terminalOutput'); output.replaceChildren();
  if (!runs.length) { const p=document.createElement('p'); p.className='hint'; p.textContent='Nenhum prompt enviado ainda.'; output.append(p); return; }
  [...runs].reverse().forEach(run => {
    const entry=document.createElement('div'); entry.className=`entry ${run.status}`;
    const head=document.createElement('div'); head.className='entry-head';
    const worker=document.createElement('span'); worker.textContent=run.worker_id;
    const state=document.createElement('span'); state.textContent=run.status.toUpperCase(); head.append(worker,state);
    const user=document.createElement('div'); user.className='user'; user.textContent=`> ${run.prompt}`;
    const result=document.createElement('div'); result.textContent=run.response || run.error || (run.status === 'running' ? 'Analisando…' : 'Na fila…');
    entry.append(head,user,result); output.append(entry);
  });
  output.scrollTop=output.scrollHeight;
}

async function refresh() {
  const [status, prompts] = await Promise.all([api('/status'), api('/prompts')]);
  $('healthDot').className=`dot ${status.mcp_online ? 'online':'offline'}`;
  $('healthText').textContent=status.mcp_online ? 'MCP online' : 'MCP offline · fila pausada';
  $('sessionCount').textContent=String(status.sessions.length);
  if (selected && !status.sessions.some(row => row.id === selected)) selected=null;
  if (status.sessions.length) $('sessions').replaceChildren(...status.sessions.map(sessionCard));
  else { const empty=document.createElement('div'); empty.className='sessions-empty'; empty.textContent='Nenhuma sessão criada. Adicione uma conta e abra um jogo.'; $('sessions').replaceChildren(empty); }
  renderRuns(prompts.runs.filter(run => $('broadcast').checked || !selected || run.session_id === selected));
}

function showFatal(error) { $('healthDot').className='dot offline'; $('healthText').textContent=error.message; }
$('loginForm').onsubmit = async event => { event.preventDefault(); token=$('token').value.trim(); try { await connect(); sessionStorage.setItem('pipeline-token',token); } catch(error) { $('loginError').textContent=error.message; } };
$('launchForm').onsubmit = async event => { event.preventDefault(); $('launchButton').disabled=true; $('launchMessage').textContent=''; try { const data=await api('/launch',{method:'POST',body:JSON.stringify({alias:$('account').value,links:[$('game').value.trim()]})}); selected=data.sessions[0]?.session?.id || selected; $('launchMessage').textContent='Sessão adicionada à fila.'; $('game').value=''; await refresh(); } catch(error) { $('launchMessage').textContent=error.message; } finally { $('launchButton').disabled=false; } };
$('promptForm').onsubmit = async event => { event.preventDefault(); $('promptError').textContent=''; $('sendPrompt').disabled=true; try { await api('/prompts',{method:'POST',body:JSON.stringify({prompt:$('prompt').value.trim(),scope:$('broadcast').checked?'all':'session',session_id:selected})}); $('prompt').value=''; await refresh(); } catch(error) { $('promptError').textContent=error.message; } finally { $('sendPrompt').disabled=false; } };
$('broadcast').onchange=()=>refresh().catch(showFatal);
$('accountsToggle').onclick=async()=>{ $('accountManager').hidden=false; await refreshRam(); };
$('accountsClose').onclick=()=>{ $('accountManager').hidden=true; };
$('policyToggle').onclick=async()=>{ $('policyEditor').hidden=!$('policyEditor').hidden; if (!$('policyEditor').hidden) await loadPolicy(); };
$('policyFile').onchange=async()=>{ const file=$('policyFile').files[0]; if (!file) return; if (file.size>65536) { $('policyMessage').textContent='O arquivo excede 64 KiB.'; return; } $('policyContent').value=await file.text(); $('policyFilename').textContent=file.name; };
$('policyEditor').onsubmit=async event=>{ event.preventDefault(); const file=$('policyFile').files[0]; const filename=file?.name || ($('policyFilename').textContent.split(' ·')[0] || 'AGENTS.md'); try { const data=await api('/agent-policy',{method:'POST',body:JSON.stringify({filename,content:$('policyContent').value})}); $('policyFilename').textContent=`${data.policy.filename} · salvo globalmente`; $('policyMessage').textContent='Instruções aplicadas a todas as sessões.'; } catch(error) { $('policyMessage').textContent=error.message; } };
$('syncAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent=''; try { await api('/accounts/sync',{method:'POST',body:JSON.stringify({alias:$('syncAlias').value.trim(),username:$('ramAccount').value})}); $('syncAlias').value=''; await loadConfig(); $('accountMessage').textContent='Conta adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
$('importAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent='Importando no RAM local…'; const cookie=$('securityCookie').value; $('securityCookie').value=''; try { await api('/accounts/import',{method:'POST',body:JSON.stringify({alias:$('importAlias').value.trim(),cookie})}); $('importAlias').value=''; await loadConfig(); await refreshRam(); $('accountMessage').textContent='Conta importada no RAM e adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
if (token) connect().catch(() => { sessionStorage.removeItem('pipeline-token'); token=''; });
setInterval(() => { if (!$('dashboard').hidden) refresh().catch(showFatal); }, 2000);
