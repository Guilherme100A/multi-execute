const $ = id => document.getElementById(id);
let selected = null;
let agentConfigured = false;
let liveController = null;
let snapshotVersion = 0;
let refreshVersion = 0;
let feedConnected = false;
let lastSnapshot = null;
let agentProviders=[];
let currentAgent=null;
let launchAccounts=[];
const liveStatuses = new Set(['connected', 'analyzing']);
const labels = {connected:'Conectada', analyzing:'Analisando', pending:'Na fila', launching:'Conectando', failed:'Falhou', disconnected:'Desconectada', done:'Concluída'};

function setFeedConnected(connected) {
  feedConnected = connected;
  $('feedState').textContent = connected ? '● Atualização ao vivo' : 'Reconectando atualizações…';
  $('feedState').classList.toggle('online', connected);
  if (lastSnapshot) applySnapshot(...lastSnapshot);
}

function showView(name) {
  for (const view of ['accounts','group','games','sessions','console']) $(`${view}View`).hidden = view !== name;
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function connect() {
  const config = await loadConfig();
  $('model').textContent = config.agent.configured ? `${config.agent.provider} · ${config.agent.model}` : 'CLI NÃO CONFIGURADA';
  await refresh();
  await refreshRam();
  startLiveFeed();
}

async function loadConfig() {
  const config = await api('/config');
  agentConfigured = config.agent.configured;
  currentAgent=config.agent.selection || {provider:'codex',model:config.agent.model};
  agentProviders=config.agent.providers || [{id:'codex',label:'Codex CLI',installed:agentConfigured,models:[{id:config.agent.model,label:config.agent.model}]}];
  $('agentProvider').replaceChildren(...agentProviders.map(provider=>new Option(`${provider.label}${provider.installed?'':' · não instalada'}`,provider.id)));
  $('agentProvider').value=currentAgent.provider;
  renderModelOptions(currentAgent.model);
  $('model').textContent=`${config.agent.provider} · ${config.agent.model}`;
  launchAccounts=config.accounts;
  $('account').replaceChildren(...config.accounts.map(row => new Option(`${row.alias} (${row.username})`, row.alias)));
  renderAccountChoices();
  $('prompt').disabled = !agentConfigured; $('sendPrompt').disabled = !agentConfigured;
  if (!agentConfigured) $('prompt').placeholder = 'Instale e autentique a CLI escolhida para habilitar o agente';
  return config;
}

function renderAccountChoices() {
  const previous=new Set([...$('accountChoices').querySelectorAll('input:checked')].map(input=>input.value));
  $('accountChoices').replaceChildren(...launchAccounts.map((account,index)=>{
    const label=document.createElement('label'); label.className='account-choice';
    const input=document.createElement('input'); input.type='checkbox'; input.value=account.alias;
    input.checked=previous.has(account.alias) || (!previous.size && index<Math.min(10,launchAccounts.length));
    input.onchange=()=>{ if ($('accountChoices').querySelectorAll('input:checked').length>10) input.checked=false; updateSelectedAccounts(); };
    const face=document.createElement('span'); face.className='account-face'; face.textContent=account.alias.slice(0,1).toUpperCase();
    const text=document.createElement('span'); const alias=document.createElement('b'); alias.textContent=account.alias;
    const username=document.createElement('small'); username.textContent=account.username; text.append(alias,username);
    const check=document.createElement('i'); check.textContent='✓'; label.append(input,face,text,check); return label;
  }));
  updateSelectedAccounts();
}

function updateSelectedAccounts() {
  const count=$('accountChoices').querySelectorAll('input:checked').length;
  $('selectedAccountCount').textContent=`${count} ${count===1?'conta selecionada':'contas selecionadas'} · máximo 10`;
}

function renderModelOptions(model) {
  const provider=agentProviders.find(row=>row.id===$('agentProvider').value);
  const models=[...(provider?.models || [])];
  if (model && !models.some(row=>row.id===model)) models.unshift({id:model,label:model});
  $('agentModel').replaceChildren(...models.map(row=>new Option(row.label,row.id)),new Option('Outro modelo…','custom'));
  if (model) $('agentModel').value=model;
  $('customModelLabel').hidden=true; $('customModel').required=false;
  $('saveAgentSettings').disabled=!provider?.installed;
}
$('agentProvider').onchange=()=>renderModelOptions($('agentProvider').value===currentAgent?.provider ? currentAgent.model : undefined);
$('agentModel').onchange=()=>{const custom=$('agentModel').value==='custom';$('customModelLabel').hidden=!custom;$('customModel').required=custom;};
$('agentSettingsForm').onsubmit=async event=>{
  event.preventDefault(); $('saveAgentSettings').disabled=true;
  try {
    await api('/agent-settings',{method:'POST',body:JSON.stringify({provider:$('agentProvider').value,model:$('agentModel').value==='custom'?$('customModel').value.trim():$('agentModel').value})});
    await loadConfig(); if(lastSnapshot) applySnapshot(...lastSnapshot);
    $('agentSettingsMessage').textContent='Escolha salva. Os próximos prompts usarão esta CLI e este modelo.';
  } catch(error) {$('agentSettingsMessage').textContent=error.message;} finally {$('saveAgentSettings').disabled=false;}
};

async function refreshRam() {
  $('accountMessage').textContent = 'Consultando as contas locais…';
  try {
    const data = await api('/accounts/local');
    $('ramAccount').replaceChildren(...data.accounts.map(username => new Option(username, username)));
    $('accountMessage').textContent = data.accounts.length ? `${data.accounts.length} conta(s) encontrada(s) no cofre local.` : 'Nenhuma conta importada neste computador.';
  } catch (error) { $('accountMessage').textContent = error.message; }
}

async function loadPolicy() {
  const data = await api('/agent-policy');
  $('policyFilename').textContent = data.policy ? `${data.policy.filename} · salvo globalmente` : 'Nenhum arquivo salvo';
  $('policyContent').value = data.policy?.content || '';
}

function sessionCard(row) {
  const card = document.createElement('article');
  card.dataset.sessionId = row.id;
  if (row.last_error) card.title=row.last_error;
  card.className = `session${selected === row.id ? ' selected' : ''}`;
  card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `Abrir console da sessão ${row.account_alias}`);
  const top = document.createElement('div'); top.className = 'session-top';
  const identity = document.createElement('div'); identity.className = 'session-identity';
  const emblem = document.createElement('span'); emblem.className = 'session-emblem'; emblem.textContent = row.account_alias.slice(0,1).toUpperCase();
  const name = document.createElement('span'); name.className = 'session-name'; name.textContent = row.account_alias;
  const status = document.createElement('span'); status.className = `status ${row.status}`; status.textContent = labels[row.status] || row.status; status.dataset.status = row.status;
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
    retry.onclick = async event => { event.stopPropagation(); retry.disabled=true; try { await api(`/sessions/${row.id}/retry`, { method:'POST' }); await refresh(); } catch(error) { $('gamesLaunchMessage').textContent=error.message; showView('games'); } finally { retry.disabled=false; } };
    footer.prepend(retry);
  }
  card.onclick = () => {
    if (!liveStatuses.has(row.status) || !feedConnected) return;
    selected = row.id; showView('console');
    if (lastSnapshot) applySnapshot(...lastSnapshot);
    $('terminalGrid').querySelector(`[data-session-id="${row.id}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
  };
  card.onkeydown = event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); card.click(); } };
  return card;
}

function renderTerminalRuns(output, runs, session) {
  const signature = JSON.stringify(runs.map(run => [run.id,run.status,run.updated_at,run.response,run.error]));
  if (output.dataset.signature === signature && output.dataset.sessionStatus === session.status) return;
  const follow = output.scrollHeight-output.scrollTop-output.clientHeight < 48;
  const previousScroll = output.scrollTop;
  output.dataset.signature = signature; output.dataset.sessionStatus = session.status; output.replaceChildren();
  if (!runs.length) {
    const line=document.createElement('div'); line.className='terminal-system';
    line.textContent=['connected','analyzing'].includes(session.status) ? '● worker conectado · aguardando prompt' : `○ ${session.status} · aguardando conexão do worker`;
    output.append(line); return;
  }
  [...runs].reverse().forEach(run => {
    const entry=document.createElement('div'); entry.className=`entry ${run.status}`;
    const head=document.createElement('div'); head.className='entry-head';
    const worker=document.createElement('span'); worker.textContent=run.model ? `${run.provider==='claude'?'Claude':'Codex'} · ${run.model}` : run.worker_id;
    const state=document.createElement('span'); state.textContent=run.status.toUpperCase(); head.append(worker,state);
    const user=document.createElement('div'); user.className='user'; user.textContent=`> ${run.prompt}`;
    const result=document.createElement('div'); result.textContent=run.response || run.error || (run.status === 'running' ? 'Analisando…' : 'Na fila…');
    entry.append(head,user,result); output.append(entry);
  });
  output.scrollTop=follow ? output.scrollHeight : previousScroll;
}

function createTerminal(session) {
  const panel=document.createElement('article'); panel.className='worker-terminal card'; panel.dataset.sessionId=session.id;
  const head=document.createElement('div'); head.className='worker-terminal-head';
  const identity=document.createElement('div');
  const controls=document.createElement('span'); controls.className='window-controls';
  const live=document.createElement('i'); live.className='worker-live';
  const middle=document.createElement('i'); const end=document.createElement('i'); controls.append(live,middle,end);
  const title=document.createElement('h3'); title.className='worker-title';
  const worker=document.createElement('p'); worker.className='worker-id';
  identity.append(title,worker);
  const badge=document.createElement('span'); badge.className='status';
  head.append(controls,identity,badge);
  const output=document.createElement('div'); output.className='worker-terminal-output';
  const form=document.createElement('form'); form.className='worker-prompt-form';
  const input=document.createElement('textarea'); input.rows=2; input.maxLength=8000; input.required=true;
  input.setAttribute('aria-label', `Prompt para ${session.account_alias}`);
  const actions=document.createElement('div'); actions.className='worker-prompt-actions';
  const error=document.createElement('span'); error.className='worker-error';
  const send=document.createElement('button'); send.type='submit'; send.textContent='Enviar';
  actions.append(error,send); form.append(input,actions); panel.append(head,output,form);
  form.onsubmit=async event=>{
    event.preventDefault(); error.textContent=''; send.disabled=true;
    try {
      await api('/prompts',{method:'POST',body:JSON.stringify({prompt:input.value.trim(),scope:'session',session_id:panel.dataset.sessionId})});
      input.value=''; await refresh();
    } catch(reason) { error.textContent=reason.message; } finally { send.disabled=input.disabled; }
  };
  return panel;
}

function renderTerminalBoard(sessions, runs) {
  const grid=$('terminalGrid');
  if (!sessions.length) { if (!grid.querySelector('.terminal-empty')) { const empty=document.createElement('div'); empty.className='terminal-empty card'; empty.textContent='Nenhum jogo conectado. Seus terminais aparecerão aqui automaticamente.'; grid.replaceChildren(empty); } return; }
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
    const badge=panel.querySelector('.status'); badge.className=`status ${session.status}`; badge.textContent=labels[session.status] || session.status; badge.dataset.status=session.status;
    const ready=liveStatuses.has(session.status) && agentConfigured && feedConnected;
    panel.querySelector('.worker-live').className=`worker-live ${ready?'online':''}`;
    const input=panel.querySelector('textarea'); const send=panel.querySelector('button');
    const busy=runs.some(run=>run.session_id===session.id && ['queued','running'].includes(run.status));
    input.disabled=!ready; send.disabled=!ready || busy;
    input.placeholder=ready?'Digite um prompt para esta sessão…':agentConfigured?'Aguardando conexão da sessão…':'Instale e autentique a CLI escolhida para habilitar o agente';
    renderTerminalRuns(panel.querySelector('.worker-terminal-output'),runs.filter(run=>run.session_id===session.id),session);
    if (panel.parentElement !== grid) grid.append(panel);
  });
}

function renderSessionList(container, rows, emptyText) {
  const signature=JSON.stringify(rows.map(row=>[row.id,row.status,row.last_error,row.retry_count,selected===row.id]));
  if (container.dataset.signature===signature) return;
  container.dataset.signature=signature;
  const ids=new Set(rows.map(row=>row.id));
  for (const card of container.querySelectorAll('.session')) if (!ids.has(card.dataset.sessionId)) card.remove();
  container.querySelector('.sessions-empty')?.remove();
  for (const row of rows) {
    let card=container.querySelector(`[data-session-id="${row.id}"]`);
    const key=JSON.stringify([row.status,row.last_error,row.retry_count,selected===row.id]);
    if (!card) { card=sessionCard(row); container.append(card); }
    else if (card.dataset.key!==key) { const replacement=sessionCard(row); card.replaceWith(replacement); card=replacement; }
    card.dataset.key=key;
  }
  if (!rows.length && emptyText) { const empty=document.createElement('p'); empty.className='sessions-empty'; empty.textContent=emptyText; container.append(empty); }
}

function applySnapshot(status, prompts) {
  lastSnapshot=[status,prompts];
  const live=status.mcp_online && feedConnected ? status.sessions.filter(row=>liveStatuses.has(row.status)) : [];
  const pending=status.sessions.filter(row=>['pending','launching'].includes(row.status));
  const history=status.sessions.filter(row=>!liveStatuses.has(row.status) && !['pending','launching'].includes(row.status)).reverse();
  $('healthDot').className=`dot ${live.length ? 'online':'offline'}`;
  $('healthText').textContent=!feedConnected ? 'Reconectando painel…' : !status.mcp_online ? 'Conexão Roblox indisponível' : `${live.length} ${live.length===1?'sessão conectada':'sessões conectadas'}`;
  if (status.automation) {
    const labels={starting:'Preparando conexão automática…',connecting:'Conectando jogos e workers automaticamente…',ready:'Conexão automática pronta',error:'Falha na conexão automática',stopped:'Conexão automática desativada'};
    document.querySelectorAll('.automation-status').forEach(element=>{element.textContent=status.automation.error || labels[status.automation.state] || '';});
  }
  $('sessionCount').textContent=String(live.length);
  $('navSessionCount').textContent=String(live.length);
  $('historyCount').textContent=String(history.length);
  if (selected && !live.some(row => row.id === selected)) selected=null;
  renderSessionList($('sessions'),live,feedConnected ? 'Nenhum jogo conectado neste momento.' : 'Aguardando confirmação das conexões…');
  renderSessionList($('pendingSessions'),pending);
  renderSessionList($('historySessions'),history);
  $('pendingSessions').hidden=!pending.length;
  $('sessionHistory').hidden=!history.length;
  $('prompt').disabled=!agentConfigured || !live.length;
  $('sendPrompt').disabled=!agentConfigured || !live.length;
  // Keep mounted terminals and drafts during transport outages, but disable actions.
  renderTerminalBoard(status.mcp_online ? status.sessions.filter(row=>liveStatuses.has(row.status)) : [],prompts.runs);
}

async function refresh() {
  const version=snapshotVersion;
  const request=++refreshVersion;
  const [status, prompts] = await Promise.all([api('/status'), api('/prompts')]);
  if (version===snapshotVersion && request===refreshVersion) applySnapshot(status,prompts);
}

async function startLiveFeed() {
  liveController?.abort();
  const controller=new AbortController(); liveController=controller;
  let retryDelay=1000;
  while (!controller.signal.aborted) {
  let watchdog;
  try {
    const response=await fetch('/events',{signal:controller.signal});
    if (!response.ok || !response.body) throw new Error(`Live feed HTTP ${response.status}`);
    const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer='';
    const armWatchdog=()=>{ clearTimeout(watchdog); watchdog=setTimeout(()=>reader.cancel().catch(()=>{}),25000); };
    armWatchdog();
    while (liveController===controller) {
      const {value,done}=await reader.read(); if (done) break;
      armWatchdog(); buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');
      const blocks=buffer.split('\n\n'); buffer=blocks.pop() || '';
      for (const block of blocks) {
        const line=block.split('\n').find(part=>part.startsWith('data: '));
        if (!line) continue;
        const snapshot=JSON.parse(line.slice(6));
        snapshotVersion++; feedConnected=true; retryDelay=1000;
        applySnapshot(snapshot,{runs:snapshot.runs});
        $('feedState').textContent='● Atualização ao vivo'; $('feedState').classList.add('online');
      }
    }
  } catch(error) {
    if (!controller.signal.aborted) setFeedConnected(false);
  } finally { clearTimeout(watchdog); }
  if (!controller.signal.aborted) {
    setFeedConnected(false);
    await new Promise(resolve=>{ const timer=setTimeout(done,retryDelay); function done(){ clearTimeout(timer); controller.signal.removeEventListener('abort',done); resolve(); } controller.signal.addEventListener('abort',done,{once:true}); });
    retryDelay=Math.min(retryDelay*2,10000);
  }
  }
}

function showFatal(error) { $('healthDot').className='dot offline'; $('healthText').textContent=error.message; }
$('groupLaunchForm').onsubmit = async event => {
  event.preventDefault(); $('groupLaunchButton').disabled=true; $('groupLaunchMessage').textContent='';
  try {
    const aliases=[...$('accountChoices').querySelectorAll('input:checked')].map(input=>input.value);
    if (!aliases.length) throw new Error('Selecione pelo menos uma conta.');
    const data=await api('/launch-group',{method:'POST',body:JSON.stringify({link:$('groupGame').value.trim(),aliases})});
    $('groupGame').value='';
    selected=data.sessions[0]?.session?.id || selected;
    $('groupLaunchMessage').textContent=`${data.sessions.length} conta(s) enviada(s) ao mesmo jogo, cada uma com worker próprio.`;
    await refresh(); showView('sessions');
  } catch(error) { $('groupLaunchMessage').textContent=error.message; } finally { $('groupLaunchButton').disabled=false; }
};
$('gamesLaunchForm').onsubmit = async event => {
  event.preventDefault(); $('gamesLaunchButton').disabled=true; $('gamesLaunchMessage').textContent='';
  try {
    const links=$('game').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    if (links.length>10) throw new Error('Informe no máximo 10 jogos.');
    const data=await api(links.length>1?'/launch-batch':'/launch',{method:'POST',body:JSON.stringify({alias:$('account').value,links})});
    $('game').value=''; updateGameLinkCount(); selected=data.sessions[0]?.session?.id || selected;
    $('gamesLaunchMessage').textContent=`${data.sessions.length} jogo(s) distribuído(s), um por conta.`;
    await refresh(); showView('sessions');
  } catch(error) { $('gamesLaunchMessage').textContent=error.message; } finally { $('gamesLaunchButton').disabled=false; }
};
$('promptForm').onsubmit = async event => { event.preventDefault(); $('promptError').textContent=''; $('sendPrompt').disabled=true; try { await api('/prompts',{method:'POST',body:JSON.stringify({prompt:$('prompt').value.trim(),scope:'all'})}); $('prompt').value=''; await refresh(); } catch(error) { $('promptError').textContent=error.message; } finally { $('sendPrompt').disabled=false; } };
document.querySelectorAll('.nav-button').forEach(button=>button.onclick=()=>{showView(button.dataset.view);if(button.dataset.view==='accounts') void refreshRam();});
$('selectAllAccounts').onclick=()=>{ $('accountChoices').querySelectorAll('input').forEach((input,index)=>{input.checked=index<10;}); updateSelectedAccounts(); };
function updateGameLinkCount(){const count=$('game').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).length;$('gameLinkCount').textContent=`${count} de 10 jogos`;$('gameLinkCount').classList.toggle('over-limit',count>10);}
$('game').oninput=updateGameLinkCount; updateGameLinkCount();
$('policyToggle').onclick=async()=>{ $('policyEditor').hidden=!$('policyEditor').hidden; if (!$('policyEditor').hidden) await loadPolicy(); };
$('policyFile').onchange=async()=>{ const file=$('policyFile').files[0]; if (!file) return; if (file.size>65536) { $('policyMessage').textContent='O arquivo excede 64 KiB.'; return; } $('policyContent').value=await file.text(); $('policyFilename').textContent=file.name; };
$('policyEditor').onsubmit=async event=>{ event.preventDefault(); const file=$('policyFile').files[0]; const filename=file?.name || ($('policyFilename').textContent.split(' ·')[0] || 'AGENTS.md'); try { const data=await api('/agent-policy',{method:'POST',body:JSON.stringify({filename,content:$('policyContent').value})}); $('policyFilename').textContent=`${data.policy.filename} · salvo globalmente`; $('policyMessage').textContent='Instruções aplicadas a todas as sessões.'; } catch(error) { $('policyMessage').textContent=error.message; } };
$('syncAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent=''; try { await api('/accounts/sync',{method:'POST',body:JSON.stringify({alias:$('syncAlias').value.trim(),username:$('ramAccount').value})}); $('syncAlias').value=''; await loadConfig(); $('accountMessage').textContent='Conta adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
$('importAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent='Salvando a sessão criptografada…'; const cookie=$('securityCookie').value; $('securityCookie').value=''; try { await api('/accounts/import',{method:'POST',body:JSON.stringify({alias:$('importAlias').value.trim(),cookie})}); $('importAlias').value=''; await loadConfig(); await refreshRam(); $('accountMessage').textContent='Conta protegida pelo Windows e adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
connect().catch(showFatal);
document.addEventListener('visibilitychange',()=>{ if (!document.hidden && !$('dashboard').hidden && !feedConnected) startLiveFeed(); });
