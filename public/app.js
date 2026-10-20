const $ = id => document.getElementById(id);
let selected = null;
let selectedGroup = null;
let agentConfigured = false;
let liveController = null;
let snapshotVersion = 0;
let refreshVersion = 0;
let feedConnected = false;
let lastSnapshot = null;
let agentProviders=[];
let currentAgent=null;
let launchAccounts=[];
let checkingSetup = false;
let robloxPreferences = {hideImages:false,maxRecentGames:8};
let robloxSettingsLoaded = false;
let loadingRobloxSettings = false;
let robloxRecentSignature = '';
let policyLoaded = false;
let policyLoading = false;
let policyDirty = false;
let policyFileName = 'AGENTS.md';
const liveStatuses = new Set(['connected', 'analyzing']);
const labels = {connected:'Conectada', analyzing:'Analisando', pending:'Na fila', launching:'Conectando', failed:'Falhou', disconnected:'Desconectada', done:'Concluída'};
const groupModeLabels = {'same-game':'Multi-instância · Um jogo','multi-game':'Multi-instância · Vários jogos',single:'Sessão individual'};

function groupId(row){return row.group_id || row.id;}
function grouped(rows){const map=new Map();for(const row of rows){const id=groupId(row);if(!map.has(id))map.set(id,[]);map.get(id).push(row);}return [...map.entries()].map(([id,workers])=>({id,workers,mode:workers[0].group_mode||'single',created_at:Math.min(...workers.map(row=>row.created_at||0))}));}
function groupStatus(workers){for(const state of ['analyzing','connected','launching','pending','disconnected','failed','done'])if(workers.some(row=>row.status===state))return state;return workers[0]?.status||'pending';}
function groupTitle(group){const places=new Set(group.workers.map(row=>row.place_id));return group.mode==='same-game'?`${group.workers.length} contas · Place ${group.workers[0].place_id}`:group.mode==='multi-game'?`${group.workers.length} contas · ${places.size} jogos`:`${group.workers[0].account_alias} · Place ${group.workers[0].place_id}`;}

function setFeedConnected(connected) {
  feedConnected = connected;
  $('feedState').textContent = connected ? '● Atualização ao vivo' : 'Reconectando atualizações…';
  $('feedState').classList.toggle('online', connected);
  if (lastSnapshot) applySnapshot(...lastSnapshot);
}

function showView(name) {
  for (const view of ['accounts','group','games','sessions','console','setup','roblox','agents']) $(`${view}View`).hidden = view !== name;
  document.querySelectorAll('.nav-button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  if (name === 'setup') void checkSetup();
  if (name === 'roblox' && !robloxSettingsLoaded) void loadRobloxSettings();
  if (name === 'agents' && !policyLoaded) void loadPolicy().catch(error => { $('policyMessage').textContent=error.message; });
}

function fillRobloxSettings(preferences) {
  const setOption = (id, value) => {
    const field = $(id); const text = value === null ? '' : String(value);
    if (text && ![...field.options].some(option => option.value === text)) field.add(new Option(text, text));
    field.value = text;
  };
  setOption('rbFps', preferences.fpsCap); setOption('rbQuality', preferences.graphicsQuality);
  setOption('rbVolume', preferences.masterVolume); setOption('rbFullscreen', preferences.fullscreen);
  $('rbHideImages').checked = preferences.hideImages; $('rbRecentLimit').value = preferences.maxRecentGames;
}

function useRobloxPreferences(preferences) {
  robloxPreferences = preferences;
  document.documentElement.classList.toggle('hide-interface-images', preferences.hideImages);
  if (lastSnapshot) renderRecentRobloxGames(lastSnapshot[0].sessions);
}

async function loadRobloxSettings() {
  if (loadingRobloxSettings) return;
  loadingRobloxSettings = true;
  try {
    const data = await api('/roblox-settings');
    useRobloxPreferences(data.preferences); fillRobloxSettings(data.preferences); robloxSettingsLoaded = true;
    const value = data.client.values;
    $('robloxNativeStatus').textContent = data.client.available
      ? `Atual no Roblox: FPS ${value.fpsCap === -1 ? 'automático' : value.fpsCap ?? '—'} · volume ${value.masterVolume ?? '—'}% · ${value.fullscreen ? 'tela cheia' : 'janela'}.`
      : data.client.error;
    $('robloxApply').disabled = !data.client.available;
  } catch (error) { $('robloxNativeStatus').textContent = error.message; $('robloxApply').disabled = true; }
  finally { loadingRobloxSettings = false; }
}

function collectRobloxPreferences() {
  const number = id => $(id).value === '' ? null : Number($(id).value);
  return {fpsCap:number('rbFps'),masterVolume:number('rbVolume'),graphicsQuality:number('rbQuality'),
    fullscreen:$('rbFullscreen').value === '' ? null : $('rbFullscreen').value === 'true',
    hideImages:$('rbHideImages').checked,maxRecentGames:Number($('rbRecentLimit').value)};
}

async function saveRobloxSettings(apply = false) {
  const buttons = [$('robloxSave'), $('robloxApply')]; const previous = buttons.map(button => button.disabled);
  buttons.forEach(button => { button.disabled = true; }); $('robloxSettingsMessage').textContent = 'Salvando…';
  try {
    const data = await api('/roblox-settings', {method:'POST',body:JSON.stringify(collectRobloxPreferences())});
    useRobloxPreferences(data.preferences);
    if (apply) {
      await api('/roblox-settings/apply', {method:'POST',body:'{}'});
      $('robloxSettingsMessage').textContent = 'Configurações aplicadas no Roblox com backup. Abra o jogo para usar.';
      await loadRobloxSettings();
    } else $('robloxSettingsMessage').textContent = 'Preferências salvas. As opções do Roblox só mudam ao aplicar.';
  } catch (error) { $('robloxSettingsMessage').textContent = error.message; }
  finally { buttons.forEach((button,index) => { button.disabled = previous[index]; }); }
}

function renderRecentRobloxGames(sessions) {
  const recent = [...sessions].sort((a,b)=>b.created_at-a.created_at);
  const ids = [...new Set(recent.map(session=>session.place_id))].slice(0,robloxPreferences.maxRecentGames);
  const signature = ids.join(','); if (signature === robloxRecentSignature) return; robloxRecentSignature = signature;
  if (!ids.length) { $('robloxRecentGames').textContent = 'Nenhum jogo no histórico.'; return; }
  $('robloxRecentGames').replaceChildren(...ids.map(id => {
    const button = document.createElement('button'); button.type='button'; button.className='ghost'; button.textContent=`Place ${id}`;
    button.onclick=()=>{ $('groupGame').value=id; showView('group'); $('groupGame').focus(); }; return button;
  }));
}

async function checkSetup() {
  if (checkingSetup) return;
  checkingSetup = true;
  const button = $('setupCheckButton');
  button.disabled = true; button.classList.add('is-checking');
  button.querySelector('span').textContent = 'Verificando…';
  $('setupItems').setAttribute('aria-busy', 'true');
  $('setupSummaryTitle').textContent = 'Conferindo os requisitos…';
  try {
    const report = await api('/setup-check');
    const labels = {ok:'Encontrado', missing:'Não encontrado', attention:'Configurar', optional:'Opcional'};
    const symbols = {ok:'✓', missing:'×', attention:'!', optional:'−'};
    const rows = report.items.map((item, index) => {
      const row = document.createElement('div'); row.className = `setup-item setup-${item.status}`;
      row.style.setProperty('--setup-order', Math.min(index, 8));
      const icon = document.createElement('span'); icon.className = 'setup-item-symbol'; icon.textContent = symbols[item.status]; icon.setAttribute('aria-hidden', 'true');
      const content = document.createElement('div'); content.className = 'setup-item-content';
      const title = document.createElement('strong'); title.textContent = item.label;
      const detail = document.createElement('p'); detail.textContent = item.detail; content.append(title, detail);
      const status = document.createElement('span'); status.className = 'setup-item-status'; status.textContent = labels[item.status];
      row.append(icon, content, status); return row;
    });
    $('setupItems').replaceChildren(...rows);
    $('setupSummary').classList.toggle('is-ready', report.ready);
    $('setupSummary').querySelector('.setup-summary-symbol').textContent = report.ready ? '✓' : '!';
    $('setupSummaryTitle').textContent = report.ready ? 'Tudo encontrado' : 'Seu setup precisa de alguns ajustes';
    $('setupSummaryText').textContent = `${report.passed} de ${report.total} requisitos obrigatórios encontrados. Confira os detalhes abaixo.`;
    $('setupCheckedAt').textContent = `Última verificação às ${new Date(report.checkedAt).toLocaleTimeString('pt-BR')}`;
  } catch (error) {
    $('setupSummary').classList.remove('is-ready');
    $('setupSummaryTitle').textContent = 'Não foi possível verificar agora';
    $('setupSummaryText').textContent = error.message;
    $('setupCheckedAt').textContent = 'Tente verificar novamente.';
  } finally {
    checkingSetup = false; button.disabled = false; button.classList.remove('is-checking');
    button.querySelector('span').textContent = 'Verificar novamente';
    $('setupItems').setAttribute('aria-busy', 'false');
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function connect() {
  const config = await loadConfig();
  void loadRobloxSettings();
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
  $('activeAgentProvider').textContent=config.agent.provider || 'Nenhum agente';
  $('activeAgentModel').textContent=config.agent.model || 'Nenhum modelo';
  $('agentAvailability').textContent=config.agent.configured ? 'CLI disponível neste computador' : 'Instale e autentique a CLI para usar os terminais';
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
  } catch(error) {$('agentSettingsMessage').textContent=error.message;} finally {$('saveAgentSettings').disabled=!agentProviders.find(row=>row.id===$('agentProvider').value)?.installed;}
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
  if (policyLoading) return;
  policyLoading = true;
  try {
    const data = await api('/agent-policy');
    if (!policyDirty) {
      policyFileName = data.policy?.filename || 'AGENTS.md';
      $('policyFilename').textContent = data.policy ? `${data.policy.filename} · salvo para as sessões` : 'Nenhum arquivo salvo';
      $('policyContent').value = data.policy?.content || '';
    }
    policyLoaded = true;
  } finally { policyLoading = false; }
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
    panel.hidden=selectedGroup!==null && groupId(session)!==selectedGroup;
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
  const groups=grouped(rows);
  const signature=JSON.stringify(groups.map(group=>[group.id,...group.workers.map(row=>[row.id,row.status,row.last_error,row.retry_count]),selectedGroup===group.id]));
  if (container.dataset.signature===signature) return;
  container.dataset.signature=signature;
  container.replaceChildren(...groups.map((group,index)=>{
    const card=document.createElement('article');card.className=`session session-group${selectedGroup===group.id?' selected':''}`;card.dataset.groupId=group.id;card.tabIndex=0;
    const state=groupStatus(group.workers);const top=document.createElement('div');top.className='session-top';
    const identity=document.createElement('div');identity.className='session-identity';const emblem=document.createElement('span');emblem.className='session-emblem';emblem.textContent=String(index+1).padStart(2,'0');
    const names=document.createElement('span');const kicker=document.createElement('small');kicker.className='group-mode';kicker.textContent=groupModeLabels[group.mode];const title=document.createElement('b');title.className='session-name';title.textContent=groupTitle(group);names.append(kicker,title);identity.append(emblem,names);
    const badge=document.createElement('span');badge.className=`status ${state}`;badge.textContent=labels[state]||state;top.append(identity,badge);
    const workers=document.createElement('div');workers.className='group-workers';for(const row of group.workers){const chip=document.createElement('span');chip.className=`worker-chip ${row.status}`;chip.textContent=`${row.account_alias} · ${row.place_id}`;workers.append(chip);}
    const footer=document.createElement('div');footer.className='session-footer';const count=document.createElement('span');count.className='group-count';count.textContent=`${group.workers.length} worker${group.workers.length===1?'':'s'}`;const action=document.createElement('span');action.className='session-action';action.textContent='ABRIR TERMINAIS →';footer.append(count,action);card.append(top,workers,footer);
    const open=()=>{const live=group.workers.filter(row=>liveStatuses.has(row.status));if(!live.length||!feedConnected)return;selectedGroup=group.id;selected=live[0].id;showView('console');if(lastSnapshot)applySnapshot(...lastSnapshot);};card.onclick=open;card.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}};return card;
  }));
  if (!groups.length && emptyText) { const empty=document.createElement('p'); empty.className='sessions-empty'; empty.textContent=emptyText; container.append(empty); }
}

function renderWorkspaceTabs(sessions){const groups=grouped(sessions);if(groups.length&&!groups.some(group=>group.id===selectedGroup))selectedGroup=groups[0].id;const tabs=$('workspaceTabs');tabs.replaceChildren(...groups.map((group,index)=>{const button=document.createElement('button');button.type='button';button.className=selectedGroup===group.id?'active':'';button.dataset.groupId=group.id;button.innerHTML=`<span>Sessão ${String(index+1).padStart(2,'0')}</span><b>${groupModeLabels[group.mode]}</b><small>${group.workers.length} workers</small>`;button.onclick=()=>{selectedGroup=group.id;selected=group.workers[0]?.id||null;if(lastSnapshot)applySnapshot(...lastSnapshot);};return button;}));const active=groups.find(group=>group.id===selectedGroup);$('broadcastScope').textContent=active?`${groupModeLabels[active.mode]} · ${active.workers.length} workers selecionados.`:'Nenhuma sessão conectada.';}

function renderBatchTerminal(sessions, runs) {
  const members=sessions.filter(row=>groupId(row)===selectedGroup);
  const ids=new Set(members.map(row=>row.id));
  const output=$('batchTerminalOutput');
  const relevant=runs.filter(run=>ids.has(run.session_id)).slice(0,100);
  const signature=JSON.stringify([selectedGroup,feedConnected,members.map(row=>[row.id,row.status]),relevant]);
  if(output.dataset.signature===signature)return;
  const follow=output.scrollHeight-output.scrollTop-output.clientHeight<48;
  const scroll=output.dataset.groupId===selectedGroup?output.scrollTop:0;
  output.dataset.signature=signature;output.dataset.groupId=selectedGroup||'';
  $('batchTerminalSummary').textContent=`${members.length} contas · ${feedConnected?'atualização ao vivo':'conexão interrompida'}`;
  const lines=members.map(row=>`[${row.account_alias}] ${labels[row.status]||row.status} · Place ${row.place_id}`);
  for(const run of [...relevant].reverse()){
    const member=members.find(row=>row.id===run.session_id);
    lines.push('',`[${member.account_alias}] ${(run.status||'').toUpperCase()}`,run.response||run.error||'Aguardando saída…');
  }
  output.textContent=lines.join('\n')||'Selecione um lote conectado para acompanhar suas contas.';
  output.scrollTop=follow?output.scrollHeight:scroll;
}

function applySnapshot(status, prompts) {
  lastSnapshot=[status,prompts];
  renderRecentRobloxGames(status.sessions);
  const live=status.mcp_online && feedConnected ? status.sessions.filter(row=>liveStatuses.has(row.status)) : [];
  const pending=status.sessions.filter(row=>['pending','launching'].includes(row.status));
  const history=status.sessions.filter(row=>!liveStatuses.has(row.status) && !['pending','launching'].includes(row.status)).reverse();
  $('healthDot').className=`dot ${live.length ? 'online':'offline'}`;
  $('healthText').textContent=!feedConnected ? 'Reconectando painel…' : !status.mcp_online ? 'Conexão Roblox indisponível' : `${live.length} ${live.length===1?'sessão conectada':'sessões conectadas'}`;
  if (status.automation) {
    const labels={starting:'Preparando conexão automática…',connecting:'Conectando jogos e workers automaticamente…',ready:'Conexão automática pronta',error:'Falha na conexão automática',stopped:'Conexão automática desativada'};
    document.querySelectorAll('.automation-status').forEach(element=>{element.textContent=status.automation.error || labels[status.automation.state] || '';});
  }
  $('sessionCount').textContent=String(grouped(live).length);
  $('navSessionCount').textContent=String(grouped(live).length);
  $('historyCount').textContent=String(grouped(history).length);
  if (selected && !live.some(row => row.id === selected)) selected=null;
  renderSessionList($('sessions'),live,feedConnected ? 'Nenhum jogo conectado neste momento.' : 'Aguardando confirmação das conexões…');
  renderSessionList($('pendingSessions'),pending);
  renderSessionList($('historySessions'),history);
  $('pendingSessions').hidden=!pending.length;
  $('sessionHistory').hidden=!history.length;
  $('prompt').disabled=!agentConfigured || !live.length;
  $('sendPrompt').disabled=!agentConfigured || !live.length;
  // Keep mounted terminals and drafts during transport outages, but disable actions.
  const terminalSessions=status.mcp_online ? status.sessions.filter(row=>liveStatuses.has(row.status)) : [];
  renderWorkspaceTabs(terminalSessions);renderTerminalBoard(terminalSessions,prompts.runs);
  renderBatchTerminal(status.sessions,prompts.runs);
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
    selected=data.sessions[0]?.session?.id || selected; selectedGroup=data.sessions[0]?.session?.group_id || selected;
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
    $('game').value=''; updateGameLinkCount(); selected=data.sessions[0]?.session?.id || selected; selectedGroup=data.sessions[0]?.session?.group_id || selected;
    $('gamesLaunchMessage').textContent=`${data.sessions.length} jogo(s) distribuído(s), um por conta.`;
    await refresh(); showView('sessions');
  } catch(error) { $('gamesLaunchMessage').textContent=error.message; } finally { $('gamesLaunchButton').disabled=false; }
};
$('promptForm').onsubmit = async event => { event.preventDefault(); $('promptError').textContent=''; $('sendPrompt').disabled=true; try { if(!selectedGroup)throw new Error('Selecione uma sessão.');await api('/prompts',{method:'POST',body:JSON.stringify({prompt:$('prompt').value.trim(),scope:'group',group_id:selectedGroup})}); $('prompt').value=''; await refresh(); } catch(error) { $('promptError').textContent=error.message; } finally { $('sendPrompt').disabled=false; } };
document.querySelectorAll('[data-account-method]').forEach(button=>button.onclick=()=>{
  const individual=button.dataset.accountMethod==='individual';
  $('individualAccounts').hidden=!individual;$('txtAccounts').hidden=individual;
  document.querySelectorAll('[data-account-method]').forEach(tab=>{const active=tab===button;tab.classList.toggle('active',active);tab.setAttribute('aria-pressed',String(active));});
});
$('accountsTxt').onchange=()=>{
  const file=$('accountsTxt').files?.[0];
  $('txtFileStatus').textContent=file?`${file.name} · ${Math.ceil(file.size/1024)} KB · aguardando definição do formato`:'Nenhum arquivo selecionado.';
};
document.querySelectorAll('.nav-button').forEach(button=>button.onclick=()=>{showView(button.dataset.view);if(button.dataset.view==='accounts') void refreshRam();});
$('selectAllAccounts').onclick=()=>{ $('accountChoices').querySelectorAll('input').forEach((input,index)=>{input.checked=index<10;}); updateSelectedAccounts(); };
function updateGameLinkCount(){const count=$('game').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).length;$('gameLinkCount').textContent=`${count} de 10 jogos`;$('gameLinkCount').classList.toggle('over-limit',count>10);}
$('game').oninput=updateGameLinkCount; updateGameLinkCount();
$('policyToggle').onclick=()=>{ showView('agents'); };
$('policyContent').oninput=()=>{ policyDirty=true; $('policyMessage').textContent='Alterações ainda não salvas.'; };
$('policyFile').onchange=async()=>{
  const file=$('policyFile').files[0]; if (!file) return;
  if (file.size>65536) { $('policyMessage').textContent='O arquivo excede 64 KiB.'; return; }
  try {
    const content=await file.text(); policyDirty=true; policyFileName=file.name;
    $('policyContent').value=content; $('policyFilename').textContent=file.name;
    $('policyMessage').textContent='Arquivo carregado. Clique em Salvar AGENTS.md para usar nas sessões.';
  } catch(error) { $('policyMessage').textContent=error.message; }
};
$('policyEditor').onsubmit=async event=>{
  event.preventDefault(); $('saveAgentPolicy').disabled=true;
  const content=$('policyContent').value;
  try {
    const data=await api('/agent-policy',{method:'POST',body:JSON.stringify({filename:policyFileName,content})});
    $('policyFilename').textContent=`${data.policy.filename} · salvo para as sessões`;
    policyLoaded=true; policyDirty=$('policyContent').value!==content;
    $('policyMessage').textContent=policyDirty ? 'Instruções salvas. Há novas alterações ainda não salvas.' : 'AGENTS.md salvo. Os próximos prompts de todas as sessões usarão estas instruções.';
  } catch(error) { $('policyMessage').textContent=error.message; }
  finally { $('saveAgentPolicy').disabled=false; }
};
$('syncAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent=''; try { await api('/accounts/sync',{method:'POST',body:JSON.stringify({alias:$('syncAlias').value.trim(),username:$('ramAccount').value})}); $('syncAlias').value=''; await loadConfig(); $('accountMessage').textContent='Conta adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
$('browserAccountForm').onsubmit=async event=>{ event.preventDefault(); const button=event.submitter; button.disabled=true; $('accountMessage').textContent='Entre na janela oficial do Roblox. Aguardando a sessão…'; try { await api('/accounts/browser-login',{method:'POST',body:JSON.stringify({alias:$('browserAlias').value.trim()})}); $('browserAlias').value=''; await loadConfig(); await refreshRam(); $('accountMessage').textContent='Conta autenticada e protegida pelo Windows.'; } catch(error) { $('accountMessage').textContent=error.message; } finally { button.disabled=false; } };
$('browserAll').onclick=async event=>{ const button=event.currentTarget; button.disabled=true; try { for(const account of launchAccounts){ $('accountMessage').textContent=`Aguardando login de ${account.alias} (${account.username})…`; await api('/accounts/browser-login',{method:'POST',body:JSON.stringify({alias:account.alias})}); await refreshRam(); } await loadConfig(); $('accountMessage').textContent='Todas as contas foram autenticadas e protegidas pelo Windows.'; } catch(error) { $('accountMessage').textContent=error.message; } finally { button.disabled=false; } };
$('importAccountForm').onsubmit=async event=>{ event.preventDefault(); $('accountMessage').textContent='Salvando a sessão criptografada…'; const cookie=$('securityCookie').value; $('securityCookie').value=''; try { await api('/accounts/import',{method:'POST',body:JSON.stringify({alias:$('importAlias').value.trim(),cookie})}); $('importAlias').value=''; await loadConfig(); await refreshRam(); $('accountMessage').textContent='Conta protegida pelo Windows e adicionada ao Launcher.'; } catch(error) { $('accountMessage').textContent=error.message; } };
$('robloxSettingsForm').onsubmit = event => { event.preventDefault(); void saveRobloxSettings(); };
$('robloxApply').onclick = () => { void saveRobloxSettings(true); };
$('robloxRamImport').onchange = async () => {
  const file = $('robloxRamImport').files?.[0]; if (!file) return;
  try {
    if (file.size > 64 * 1024) throw new Error('O arquivo INI deve ter até 64 KiB.');
    const general = {}; let section = '';
    for (const raw of (await file.text()).split(/\r?\n/)) {
      const line = raw.trim(); if (!line || /^[;#]/.test(line)) continue;
      const header = /^\[([^\]]+)\]/.exec(line); if (header) { section = header[1].toLowerCase(); continue; }
      if (section !== 'general') continue;
      const pair = /^([^=]+)=(.*)$/.exec(line); if (!pair) continue;
      const key = pair[1].trim().toLowerCase();
      if (['unlockfps','maxfpsvalue','disableimages','maxrecentgames'].includes(key)) general[key] = pair[2].split(/[;#]/)[0].trim();
    }
    const next = collectRobloxPreferences(); let imported = 0;
    const boolean = value => { if (!/^(true|false)$/i.test(value)) throw new Error('Valor inválido no INI.'); return value.toLowerCase() === 'true'; };
    if ('unlockfps' in general) { next.fpsCap = boolean(general.unlockfps) ? Number(general.maxfpsvalue ?? 120) : null; imported++; }
    if (next.fpsCap !== null && (!Number.isInteger(next.fpsCap) || next.fpsCap < 30 || next.fpsCap > 480)) throw new Error('O limite de FPS importado deve ficar entre 30 e 480.');
    if ('disableimages' in general) { next.hideImages = boolean(general.disableimages); imported++; }
    if ('maxrecentgames' in general) { next.maxRecentGames = Number(general.maxrecentgames); if (!Number.isInteger(next.maxRecentGames) || next.maxRecentGames < 1 || next.maxRecentGames > 50) throw new Error('O limite de jogos recentes deve ficar entre 1 e 50.'); imported++; }
    if (!imported) throw new Error('Nenhuma opção compatível foi encontrada na seção General.');
    fillRobloxSettings(next); $('robloxImportMessage').textContent = `${imported} opção(ões) carregada(s). Revise e clique em Salvar preferências.`;
  } catch (error) { $('robloxImportMessage').textContent = error.message; }
  finally { $('robloxRamImport').value = ''; }
};
$('setupCheckButton').onclick = () => { void checkSetup(); };
connect().catch(showFatal);
document.addEventListener('visibilitychange',()=>{ if (!document.hidden && !$('dashboard').hidden && !feedConnected) startLiveFeed(); });
