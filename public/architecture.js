const details = {
  ui: ['01','Painel web','Recebe a conta e um ou mais links de jogos. Mostra estados e terminais sem controlar diretamente o Roblox.','Conta selecionada e links','Solicitação autenticada para o Launcher','O PIPELINE_TOKEN protege todas as operações do painel.'],
  launcher: ['02','Launcher','Cria a sessão durável, escolhe a conta e coordena abertura, injeção e monitoramento.','Conta, PlaceId e configuração autorizada','worker_id persistido e lançamento preparado','O estado sobrevive a reinícios no SQLite.'],
  connector: ['03','Conector real-mcp.exe','Fala com o Project Real pelo protocolo MCP local e expõe as ferramentas oficiais de gerenciamento dos clientes.','PID esperado e comandos do coordenador','Lista de clientes e execução direcionada','A integração usa o executável instalado pelo próprio Project Real.'],
  real: ['04','Project Real','Encontra o processo Roblox, seleciona a instância pelo PID e executa o bootstrap somente nela.','PID, cliente esperado e script Lua','Bootstrap executado no processo correto','O PID evita confusão entre janelas Roblox com o mesmo título.'],
  client: ['05','Cliente Roblox','É a instância real do jogo, já autenticada na conta escolhida e aberta no PlaceId solicitado.','Ticket temporário de autenticação','Processo, JobId e ambiente Lua','Conta e jogo são comparados com a sessão planejada.'],
  loader: ['06','Bootstrap Lua','Define MCP_PROCESS_ID e MCP_WORKER_ID antes de baixar o cliente do roblox-mcp-difz.','PID, worker_id e token interno','mcp.lua inicializado uma única vez','Uma trava por JobId impede injeção repetida.'],
  'mcp-client': ['07','Cliente MCP dentro do Roblox','Mantém o canal entre o processo Roblox e o servidor local. Usa WebSocket ou stream conforme o executor suporta.','Identidade do worker e tarefas MCP','Resultados, keepalive e metadados','Reconexões preservam a mesma identidade lógica.'],
  mcp: ['08','roblox-mcp-difz','Hospeda o loader, registra workers e converte ferramentas MCP em tarefas executadas dentro do Roblox.','Registro do cliente e tools/call','Sessões ativas e resultados das ferramentas','O patch local preserva PID e encerra recursos corretamente.'],
  proxy: ['09','Proxy MCP por worker','Apresenta uma interface MCP exclusiva a cada agente. Remove workerId fornecido pelo modelo e injeta o valor correto.','Chamada de ferramenta da CLI','Chamada vinculada à sessão dona do terminal','Um terminal não consegue redirecionar comandos para outro worker.'],
  agent: ['10','Codex CLI ou Claude Code','Interpreta o prompt e usa somente as ferramentas MCP permitidas para aquele jogo.','Prompt, AGENTS.md e ferramentas isoladas','Resposta e evidências no terminal ao vivo','Threads são separadas por jogo, provedor e modelo.'],
};

const nodes = document.querySelectorAll('[data-step]');
const fields = {
  number: document.querySelector('#detailNumber'), title: document.querySelector('#detailTitle'),
  description: document.querySelector('#detailDescription'), input: document.querySelector('#detailInput'),
  output: document.querySelector('#detailOutput'), guarantee: document.querySelector('#detailGuarantee'),
};

function selectStep(key, scroll = false) {
  const detail = details[key]; if (!detail) return;
  nodes.forEach(node => node.classList.toggle('active', node.dataset.step === key));
  [fields.number.textContent,fields.title.textContent,fields.description.textContent,fields.input.textContent,fields.output.textContent,fields.guarantee.textContent] = detail;
  if (scroll && innerWidth < 1150) document.querySelector('.inspector').scrollIntoView({behavior:'smooth',block:'center'});
}

nodes.forEach(node => node.addEventListener('click', () => selectStep(node.dataset.step, true)));
selectStep('launcher');

const routeData = {
  a: ['Terminal A → conta1-a7f2', 'MCP envia pelo canal #1 → PID 11840'],
  b: ['Terminal B → conta2-c91e', 'MCP envia pelo canal #2 → PID 22416'],
  c: ['Terminal C → alt5-42bd', 'MCP envia pelo canal #3 → PID 30172'],
};
const routeButtons = document.querySelectorAll('.session-route');
const routeWorker = document.querySelector('#routeWorker');
const routePath = document.querySelector('#routePath');

function selectRoute(route) {
  routeButtons.forEach(button => {
    const selected = button.dataset.route === route;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('.socket-line,.route-row').forEach(element => {
    element.classList.toggle('active', element.classList.contains(`route-${route}`));
  });
  [routeWorker.textContent, routePath.textContent] = routeData[route];
}

routeButtons.forEach(button => button.addEventListener('click', () => selectRoute(button.dataset.route)));
