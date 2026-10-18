const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('pipeline-token') || '';
let selected = null;
let agentConfigured = false;
let liveController = null;

function showView(name) {
  for (const view of ['home','sessions','console']) $(`${view}View`).hidden = view !== name;
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function connect() {
  const config = await loadConfig();
  $('model').textContent = config.agent.configured ? `${config.agent.provider} · ${config.agent.model}` : 'CLI NÃO CONFIGURADA';
  $('login').hidden = true; $('dashboard').hidden = false;
  await refresh();
  startLiveFeed();
}

async function loadConfig() {
  const config = await api('/config');
  agentConfigured = config.agent.configured;
  $('account').replaceChildren(...config.accounts.map(row => new Option(`${row.alias} (${row.username})`, row.alias)));
  $('prompt').disabled = !agentConfigured; $('sendPrompt').disabled = !agentConfigured;
  if (!agentConfigured) $('prompt').placeholder = 'Instale e autentique o Codex CLI para habilitar o agente';
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
  card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `Abrir console da sessão ${row.account_alias}`);
  const top = document.createElement('div'); top.className = 'session-top';
  const identity = document.createElement('div'); identity.className = 'session-identity';
  const emblem = document.createElement('span'); emblem.className = 'session-emblem'; emblem.textContent = row.account_alias.slice(0,1).toUpperCase();
  const name = document.createElement('span'); name.className = 'session-name'; name.textContent = row.account_alias;
  const status = document.createElement('span'); status.className = `status ${row.status}`; status.textContent = row.status;
  identity.append(emblem, name); top.append(identity, status);
  const meta = document.createElement('div'); meta.className = 'session-meta';
  const place = document.createElement('div'); place.className = 'meta-row';
  const placeLabel = document.createElement('span'); placeLabel.textContent = 'JOGO';
  const placeValue = document.createElement('strong'); placeValue.textContent = `Place ${row.place_id}`;
  place.append(placeLabel, placeValue);
  const worker = document.createElement('div'); worker.className = 'meta-row'; worker.title = row.worker_id;
  const workerLabel = document.createElement('span'); workerLabel.textContent = 'WORKER';
  const workerValue = document.createElement('strong'); workerValue.textContent = row.worker_id;
  worker.append(workerLabel, workerValue); meta.append(place, worker);
  const footer = document.createElement('div'); footer.className = 'session-footer';
  const action = document.createElement('span'); action.className = 'session-action'; action.textContent = 'ABRIR CONSOLE  →'; footer.append(action);
  card.append(top, meta, footer);
  if (['failed','disconnected'].includes(row.status) && row.retry_count === 0) {
    const retry = document.createElement('button'); retry.className = 'retry'; retry.textContent = 'Tentar novamente';
    retry.onclick = async event => { event.stopPropagation(); await api(`/sessions/${row.id}/retry`, { method:'POST' }); await refresh(); };
    footer.prepend(retry);
  }
  card.onclick = () => {
    selected = row.id; showView('console');
    refresh().then(() => document.querySelector(`[data-session-id="${row.id}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' })).catch(showFatal);
  };
  card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
  return card;
}

function renderTerminalRuns(output, runs, session) {
  const signature = JSON.stringify(runs.map(run => [run.id,run.status,run.updated_at,run.response,run.error]));
  if (output.dataset.signature === signature && output.dataset.sessionStatus === session.status) return;
  output.dataset.signature = signature; output.dataset.sessionStatus = session.status; output.replaceChildren();
  if (!runs.length) {
    const line=document.createElement('div'); line.className='terminal-system';
    line.textContent=['connected','analyzing'].includes(session.status) ? '● worker conectado · aguardando prompt' : `○ ${session.status} · aguardando conexão do worker`;
    output.append(line); return;
  }
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

function createTerminal(session) {
  const panel=document.createElement('article'); panel.className='worker-terminal card'; panel.dataset.sessionId=session.id;
  const head=document.createElement('div'); head.className='worker-terminal-head';
  const identity=document.createElement('div');
  const live=document.createElement('span'); live.className='worker-live';
  const title=document.createElement('h3'); title.className='worker-title';
  const worker=document.createElement('p'); worker.className='worker-id';
  identity.append(title,worker);
  const badge=document.createElement('span'); badge.className='status';
  head.append(live,identity,badge);
  const output=document.createElement('div'); output.className='worker-terminal-output';
  const form=document.createElement('form'); form.className='worker-prompt-form';
  const input=document.createElement('textarea'); input.rows=2; input.maxLength=8000; input.required=true;
  const actions=document.createElement('div'); actions.className='worker-prompt-actions';
  const error=document.createElement('span'); error.className='worker-error';
  const send=document.createElement('button'); send.type='submit'; send.textContent='Enviar';
  actions.append(error,send); form.append(input,actions); panel.append(head,output,form);
  form.onsubmit=async event=>{
    event.preventDefault(); error.textContent=''; send.disabled=true;
    try {
      await api('/prompts',{method:'POST',body:JSON.stringify({prompt:input.value.trim(),scope:'session',session_id:panel.dataset.sessionId})});
      input.value=''; await refresh();
    } catch(reason) { error.textContent=reason.message; } finally { send.disabled=false; }
  };
  return panel;
}

function renderTerminalBoard(sessions, runs) {
  const grid=$('terminalGrid');
  if (!sessions.length) { const empty=document.createElement('div'); empty.className='terminal-empty card'; empty.textContent='Abra uma sessão para criar seu terminal.'; grid.replaceChildren(empty); return; }
  grid.querySelector('.terminal-empty')?.remove();
  const activeIds=new Set(sessions.map(session=>session.id));
  grid.querySelectorAll('.worker-terminal').forEach(panel=>{ if (!activeIds.has(panel.dataset.sessionId)) panel.remove(); });
  sessions.forEach(session=>{
    let panel=grid.querySelector(`[data-session-id="${session.id}"]`);
    if (!panel) panel=createTerminal(session);
    panel.classList.toggle('selected',selected===session.id);
    panel.querySelector('.worker-title').textContent=session.account_alias;
    panel.querySelector('.worker-id').textContent=`Place ${session.place_id} · ${session.worker_id}`;
    panel.querySelector('.worker-id').title=session.worker_id;
    const badge=panel.querySelector('.status'); badge.className=`status ${session.status}`; badge.textContent=session.status;
    const ready=['connected','analyzing'].includes(session.status) && agentConfigured;
    panel.querySelector('.worker-live').className=`worker-live ${ready?'online':''}`;
    const input=panel.querySelector('textarea'); const send=panel.querySelector('button');
    input.disabled=!ready; send.disabled=!ready;
    input.placeholder=ready?'Digite um prompt para esta sessão…':agentConfigured?'Aguardando conexão da sessão…':'Instale e autentique o Codex CLI para habilitar o agente';
    renderTerminalRuns(panel.querySelector('.worker-terminal-output'),runs.filter(run=>run.session_id===session.id),session);
    grid.append(panel);
  });
}

function applySnapshot(status, prompts) {
  $('healthDot').className=`dot ${status.mcp_online ? 'online':'offline'}`;
  $('healthText').textContent=status.mcp_online ? 'MCP online' : 'MCP offline · fila pausada';
  $('sessionCount').textContent=String(status.sessions.length);
  $('navSessionCount').textContent=String(status.sessions.length);
  if (selected && !status.sessions.some(row => row.id === selected)) selected=null;
  if (status.sessions.length) $('sessions').replaceChildren(...status.sessions.map(sessionCard));
  else { const empty=document.createElement('div'); empty.className='sessions-empty'; empty.textContent='Nenhuma sessão criada. Adicione uma conta e abra um jogo.'; $('sessions').replaceChildren(empty); }
  renderTerminalBoard(status.sessions,prompts.runs);
}

async function refresh() {
  const [status, prompts] = await Promise.all([api('/status'), api('/prompts')]);
  applySnapshot(status,prompts);
}

async function startLiveFeed() {
  liveController?.abort();
  const controller=new AbortController(); liveController=controller;
  try {
    const response=await fetch('/events',{headers:{authorization:`Bearer ${token}`},signal:controller.signal});
    if (!response.ok || !response.body) throw new Error(`Live feed HTTP ${response.status}`);
    const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer='';
    while (liveController===controller) {
      const {value,done}=await reader.read(); if (done) break;
      buffer+=decoder.decode(value,{stream:true});
      const blocks=buffer.split('\n\n'); buffer=blocks.pop() || '';
      for (const block of blocks) {
        const line=block.split('\n').find(part=>part.startsWith('data: '));
        if (!line) continue;
        const snapshot=JSON.parse(line.slice(6));
        applySnapshot(snapshot,{runs:snapshot.runs});
      }
    }
  } catch(error) {
    if (!controller.signal.aborted) { showFatal(error); setTimeout(()=>{ if (liveController===controller) startLiveFeed(); },1500); }
  }
}

function showFatal(error) { $('healthDot').className='dot offline'; $('healthText').textContent=error.message; }
$('loginForm').onsubmit = async event => { event.preventDefault(); token=$('token').value.trim(); try { await connect(); sessionStorage.setItem('pipeline-token',token); } catch(error) { $('loginError').textContent=error.message; } };
$('launchForm').onsubmit = async event => { event.preventDefault(); $('launchButton').disabled=true; $('launchMessage').textContent=''; try { const data=await api('/launch',{method:'POST',body:JSON.stringify({alias:$('account').value,links:[$('game').value.trim()]})}); selected=data.sessions[0]?.session?.id || selected; $('launchMessage').textContent='Sessão adicionada à fila.'; $('game').value=''; await refresh(); showView('sessions'); } catch(error) { $('launchMessage').textContent=error.message; } finally { $('launchButton').disabled=false; } };
$('promptForm').onsubmit = async event => { event.preventDefault(); $('promptError').textContent=''; $('sendPrompt').disabled=true; try { await api('/prompts',{method:'POST',body:JSON.stringify({prompt:$('prompt').value.trim(),scope:'all'})}); $('prompt').value=''; await refresh(); } catch(error) { $('promptError').textContent=error.message; } finally { $('sendPrompt').disabled=false; } };
document.querySelectorAll('.nav-button').forEach(button=>button.onclick=()=>showView(button.dataset.view));
$('accountsToggle').onclick=async()=>{ $('accountManager').hidden=false; await refreshRam(); };
$('accountsClose').onclick=()=>{ $('accountManager').hidden=true; };
$('policyToggle').onclick=async()=>{ $('policyEditor').hidden=!$('policyEditor').hidden; if (!$('policyEditor').hidden) await loadPolicy(); };
$('policyFile').onchange=async()=>{ const file=$('policyFile').files[0]; if (!file) return; if (file.size>65536) { $('policyMessage').textContent='O arquivo excede 64 KiB.'; return; } $('policyContent').value=await file.text(); $('policyFilename').textContent=file.name; };
$('policyEditor').onsubmit=async event=>{ event.preventDefault(); const file=$('policyFile').files[0]; const filename=file?.name || ($('policyFilename').textContent.split(' ·')[0] || 'AGENTS.md'); try { const data=await api('/agent-policy',{method:'POST',body:JSON.stringify({filename,content:$('policyContent').value})}); $('policyFilename').textContent=`${data.policy.filename} · salvo globalmente`; $('policyMessage').textContent='Instruções aplicadas a todas as sessões.'; } catch(error) { $('policyMessage').textContent=error.message; } };
$('syncAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent=''; try { await api('/accounts/sync',{method:'POST',body:JSON.stringify({alias:$('syncAlias').value.trim(),username:$('ramAccount').value})}); $('syncAlias').value=''; await loadConfig(); $('accountMessage').textContent='Conta adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
$('importAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent='Importando no RAM local…'; const cookie=$('securityCookie').value; $('securityCookie').value=''; try { await api('/accounts/import',{method:'POST',body:JSON.stringify({alias:$('importAlias').value.trim(),cookie})}); $('importAlias').value=''; await loadConfig(); await refreshRam(); $('accountMessage').textContent='Conta importada no RAM e adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
if (token) connect().catch(() => { sessionStorage.removeItem('pipeline-token'); token=''; });
setInterval(() => { if (!$('dashboard').hidden) refresh().catch(showFatal); }, 30_000);
