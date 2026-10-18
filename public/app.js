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
  const config = await api('/config');
  $('account').replaceChildren(...config.accounts.map(row => new Option(`${row.alias} (${row.username})`, row.alias)));
  $('model').textContent = config.agent.configured ? config.agent.model : 'OPENAI NÃO CONFIGURADA';
  $('login').hidden = true; $('dashboard').hidden = false;
  await refresh();
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
  $('sessions').replaceChildren(...status.sessions.map(sessionCard));
  renderRuns(prompts.runs.filter(run => $('broadcast').checked || !selected || run.session_id === selected));
}

function showFatal(error) { $('healthDot').className='dot offline'; $('healthText').textContent=error.message; }
$('loginForm').onsubmit = async event => { event.preventDefault(); token=$('token').value.trim(); try { await connect(); sessionStorage.setItem('pipeline-token',token); } catch(error) { $('loginError').textContent=error.message; } };
$('launchForm').onsubmit = async event => { event.preventDefault(); $('launchButton').disabled=true; $('launchMessage').textContent=''; try { const data=await api('/launch',{method:'POST',body:JSON.stringify({alias:$('account').value,links:[$('game').value.trim()]})}); selected=data.sessions[0]?.session?.id || selected; $('launchMessage').textContent='Sessão adicionada à fila.'; $('game').value=''; await refresh(); } catch(error) { $('launchMessage').textContent=error.message; } finally { $('launchButton').disabled=false; } };
$('promptForm').onsubmit = async event => { event.preventDefault(); $('promptError').textContent=''; $('sendPrompt').disabled=true; try { await api('/prompts',{method:'POST',body:JSON.stringify({prompt:$('prompt').value.trim(),scope:$('broadcast').checked?'all':'session',session_id:selected})}); $('prompt').value=''; await refresh(); } catch(error) { $('promptError').textContent=error.message; } finally { $('sendPrompt').disabled=false; } };
$('broadcast').onchange=()=>refresh().catch(showFatal);
if (token) connect().catch(() => { sessionStorage.removeItem('pipeline-token'); token=''; });
setInterval(() => { if (!$('dashboard').hidden) refresh().catch(showFatal); }, 2000);
