# Roblox Security Pipeline

Launcher local em Express/TypeScript para abrir o Roblox diretamente com contas locais, carregar o [roblox-mcp-difz](https://github.com/Difz25x/roblox-mcp-difz) pelo Auto Execute do Project Real e conduzir análises autorizadas. O Account Manager pode fornecer as contas na importação inicial; não precisa estar instalado ou aberto depois dela.

Use somente em jogos próprios ou com autorização explícita. `AUTHORIZED_PLACE_IDS` é uma allowlist obrigatória; o Launcher não consulta propriedade no Roblox.

## O que fica automático

Depois da configuração única:

1. Com Real aberto e seu MCP habilitado na configuração inicial, abra `http://127.0.0.1:3000`, informe o token e cole um ou mais links, um por linha. O lote usa uma conta por link, começando pela conta selecionada.
2. O Launcher inicia o servidor MCP local, valida todos os PlaceIds, cria os workers e confirma as identidades das contas. No modo direto, prepara todos os tickets do lote antes de abrir as janelas, para o Real detectar os clientes juntos.
3. O coordenador chama o conector oficial instalado com o Real para injetar nos clientes, verifica conta/jogo e executa o bootstrap. Ele recebe o `worker_id` correto do Launcher.
4. O bootstrap carrega `mcp.lua` uma única vez para aquele `JobId`.
5. Ao detectar o worker no MCP, o Launcher chama `set-autoexecute` para armar `queue_on_teleport`.
6. O console envia um prompt para uma sessão ou para todas as conectadas. Cada prompt de massa gera uma execução isolada por worker.

Não é necessário pedir à IA para conectar. A integração usa o `real-mcp.exe` do próprio Real e suas ferramentas `inject`, `list-clients`, `set-active-client`, `eval` e `execute`. A IA só é acionada quando você envia um prompt no console. `AUTO_CONNECT=false` permite manter o fluxo manual anterior.

O PID de cada cliente é fornecido explicitamente ao loader para que janelas com o mesmo título não derrubem a conexão umas das outras. O bootstrap adapta os dois pontos correspondentes do loader 1.6.1 em memória, sem editar `node_modules`; se o formato mudar, a integração falha com erro explícito. O PID e o worker também são preservados no script enfileirado para teleportes.

## Instalação

Requer Windows, Roblox instalado, Node.js 24+, Project Real aberto com licença/login válidos e Codex CLI autenticado na mesma máquina. As bibliotecas MCP são instaladas pelo `npm ci`.

```powershell
npm ci
codex login
Copy-Item .env.example .env
Copy-Item accounts.example.json accounts.json
# Edite .env e accounts.json
npm run check
npm run setup:real
npm start
```

Gere três segredos diferentes:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use valores distintos em `PIPELINE_TOKEN`, `INTERNAL_CALLBACK_TOKEN` e `AUTOEXEC_TOKEN`. Placeholders, segredos com menos de 24 caracteres e valores repetidos são recusados.

O arquivo local `accounts.json` segue este formato:

```json
[
  {
    "alias": "conta-teste",
    "ramAccount": "UsuarioExatoNoRAM",
    "robloxUsername": "UsuarioExatoNoRoblox"
  }
]
```

`ramAccount` deve ser o username no modo direto; o modo RAM também aceita um UserId reconhecido pelo aplicativo. Não coloque cookie, senha ou token nesse arquivo. Ele é ignorado pelo Git.

## Contas locais e abertura direta (padrão)

`LAUNCH_BACKEND=direct` usa um cofre em `data/roblox-accounts.dpapi`, criptografado pela DPAPI do Windows para o usuário atual. O cofre contém apenas username e cookie de sessão: senhas e outros campos do Account Manager não são importados. O cookie só sai do computador em requisições HTTPS para os endpoints fixos do Roblox; redirects são recusados. Ele não aparece em argumentos de processos, logs ou respostas da API. A abertura do cliente usa um ticket temporário.

Preencha `accounts.json` com as contas desejadas e importe uma vez:

```powershell
npm run import:ram -- "C:\pasta do Account Manager\AccountData.json"
```

A importação lê o arquivo original sem alterá-lo e copia somente as contas listadas em `accounts.json`. Requer um arquivo com criptografia padrão do RAM 3.7.2 e acesso pela mesma conta do Windows. Arquivos protegidos por senha adicional não são desbloqueados automaticamente. Depois da importação o arquivo original e o RAM não são necessários. Novas sessões também podem ser salvas pelo formulário de contas, com validação da identidade no Roblox antes de persistir.

Feche o Roblox e o Account Manager antes do primeiro lançamento para o projeto assumir o controle de múltiplas instâncias. O projeto mantém esse controle enquanto está aberto; não encerra outros clientes automaticamente. `GET /accounts/local` retorna somente os usernames. `/accounts/ram` permanece como alias de compatibilidade. O campo `ramAccount` de `accounts.json` permanece por compatibilidade e deve conter o username; no modo direto não há chamada ao RAM.

Sessões expiradas, desafios ou recusas de autenticação do Roblox interrompem o lançamento. Faça login novamente para renovar a sessão; não há tentativa de contornar essas verificações.

## Integração opcional com RAM

Para manter a integração anterior, defina `LAUNCH_BACKEND=ram`. Somente esse modo precisa do servidor web abaixo. A interface usa o gerenciador de contas selecionado pelo backend.

O contrato foi alinhado ao código do RAM de referência:

- habilite **Developer Mode / Web Server**;
- habilite **Allow LaunchAccount Method**;
- habilite **Allow GetAccounts Method** para o gerenciamento pela interface;
- habilite **Every Request Requires Password**;
- mantenha o servidor em `127.0.0.1`;
- porta padrão: `7963`;
- configure uma Webserver Password com pelo menos 6 caracteres e copie para `RAM_PASSWORD`;
- habilite Multi Roblox quando usar várias contas simultâneas;
- selecione Project Real como executor se sua instalação oferecer essa integração.

O Launcher usa `GET /v2/LaunchAccount?Account=...&PlaceId=...&Password=...`, com resposta JSON `{ "Success": true, "Message": "..." }`.

Cada request tem timeout de 10 s e até 3 tentativas totais, com esperas de 2 s e 4 s. O RAM não aceita chave de idempotência; um timeout ocorrido depois do lançamento pode produzir uma segunda solicitação. O monitor evita associar um worker incorreto, mas a eliminação total desse risco exige que a instalação do RAM reconcilie lançamentos repetidos.

## Configuração única do Project Real

1. Abra o Real e inicie **Real MCP** em `Settings → Connections`.
2. Mantenha o Real aberto. O projeto detecta `LOCALAPPDATA/Real/data/mcp/real-mcp.exe`; use `REAL_MCP_EXECUTABLE` apenas se a instalação estiver em outro caminho.
3. Inicie o projeto com `npm start`. Ele gera e instala o bootstrap no AutoExec do Real e mantém o servidor MCP em `127.0.0.1:28429` no mesmo processo.

`npm run setup:real` continua disponível para gerar o arquivo quando `AUTO_CONNECT=false`. Nesse fluxo manual, defina `getgenv().MCP_PROCESS_ID` com o PID real do cliente antes de executar o bootstrap. O fluxo automático faz isso sem intervenção.

O arquivo gerado contém `AUTOEXEC_TOKEN`, por isso é ignorado pelo Git. Ele espera `LocalPlayer`, envia username, PlaceId e JobId ao endpoint local `/internal/autoexec/register`, define `MCP_WORKER_ID` e carrega `http://127.0.0.1:28429/mcp.lua`. Uma trava por JobId impede execução repetida na mesma instância.

## Interface web

Abra `http://127.0.0.1:3000`. A interface pede `PIPELINE_TOKEN` e guarda o valor apenas em `sessionStorage` da aba.

O mapa interativo da arquitetura fica em `http://127.0.0.1:3000/architecture.html`. Ele detalha visualmente a seleção do cliente pelo Project Real, a injeção do bootstrap, o registro no roblox-mcp-difz e o proxy MCP isolado de cada terminal.

- **Abrir jogo:** escolha uma conta e informe URL ou PlaceId.
- **Gerenciar contas:** consulte sessões importadas no cofre local ou salve uma nova conta sem editar JSON manualmente.
- **Sessões:** acompanhe os estados e use retry quando permitido.
- **Console:** cada sessão possui seu próprio terminal, histórico e campo de prompt. O compositor superior envia o mesmo prompt para todas as sessões conectadas. Estados e respostas chegam por um feed HTTP persistente, sem recarregar a página.
- **AGENTS.md global:** carregue instruções Markdown aplicadas a todas as sessões.
- **Histórico:** prompts, respostas e erros ficam persistidos no SQLite.

No modo direto, a sessão importada é validada com o Roblox e guardada no cofre criptografado do Windows. No modo opcional RAM, ela segue para o RAM local e fica no armazenamento desse aplicativo. O cookie não é registrado em logs nem retornado pela API.

Em **Terminais ao vivo**, escolha **Codex CLI** ou **Claude Code**, selecione um modelo e clique em **Aplicar**. A escolha fica salva neste projeto e vale para os próximos prompts; uma análise em andamento mantém a escolha original. Os modelos Codex vêm do catálogo da CLI instalada; Claude oferece os aliases Sonnet, Opus, Haiku e Fable. **Outro modelo** permite informar um ID exato. A disponibilidade real depende da conta autenticada; erros de acesso aparecem no terminal.

Os terminais usam o login local da CLI selecionada, sem exigir uma chave no Launcher. O padrão inicial do Codex é `AGENT_MODEL=gpt-6.1-sol`; `CLAUDE_CLI_COMMAND` permite ajustar o nome do executável Claude (padrão Windows: `claude.exe`). O histórico fica separado por jogo, CLI e modelo. Codex usa `exec --json`/`exec resume` com sandbox somente leitura; Claude usa `--print --output-format stream-json`/`--resume`, modo restrito e ferramentas internas desativadas, recebendo somente o MCP do worker atribuído. Nenhum processo recebe acesso aos demais workers.

`npm run test:cli:live` verifica as duas CLIs reais com um MCP de teste autenticado: confirma resposta, isolamento do worker e ID da conversa, sem abrir ou alterar jogos. Esse teste consome a franquia/cobrança das contas locais. `npm run test:e2e:ui` verifica o seletor e as atualizações da interface no Playwright.

Cada processo recebe apenas um endpoint MCP intermediário autenticado. Esse proxy remove `workerId` do schema apresentado ao modelo e sobrescreve o valor no servidor, impedindo que um terminal redirecione ferramentas ou faça broadcast para outra sessão. As ferramentas internas de shell, web e arquivos também são proibidas pelo prompt do agente; o acesso ao projeto permanece somente leitura. Se o CLI não estiver instalado ou autenticado, lançamento e monitoramento continuam funcionando e o console mostra o estado da configuração.

As ferramentas permitidas desse único servidor MCP recebem aprovação na configuração da própria execução do worker (`default_tools_approval_mode=approve`), de acordo com a autorização do operador para os jogos configurados. Isso evita pedidos interativos impossíveis no terminal automático. A configuração global do Codex não é alterada; o sandbox de arquivos continua somente leitura e o proxy continua limitando ferramentas e sessão.

Ferramentas expostas ao agente são limitadas no código a inspeção, remotes, execução de teste, metadados e autoexecute. O MCP permanece em `127.0.0.1:28429`; o servidor de referência não autentica sua API e usa CORS aberto, portanto não exponha essa porta na rede.

## Variáveis principais

| Variável | Padrão | Uso |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Interface e API local |
| `LAUNCH_BACKEND` | `direct` | Abertura direta; `ram` mantém a integração anterior |
| `DIRECT_ACCOUNTS_FILE` | `data/roblox-accounts.dpapi` | Cofre criptografado para o usuário atual do Windows |
| `AUTO_CONNECT` | `true` | Inicia a ponte MCP e conecta os jogos usando o Real |
| `REAL_MCP_EXECUTABLE` | detectado em LOCALAPPDATA | Caminho do conector oficial do Real |
| `RAM_URL` / `RAM_PORT` | `http://127.0.0.1:7963` / `7963` | Webserver do RAM |
| `RAM_PASSWORD` | vazio | Webserver Password do RAM |
| `MCP_URL` | `http://127.0.0.1:28429` | roblox-mcp-difz |
| `AUTHORIZED_PLACE_IDS` | obrigatório | IDs autorizados, separados por vírgula |
| `AGENT_CLI_COMMAND` | `codex.cmd` no Windows | Executável local usado pelos terminais |
| `AGENT_MODEL` | `gpt-6.1-sol` | Modelo solicitado ao Codex CLI |
| `DB_PATH` | `data/sessions.sqlite` | SQLite em WAL |
| `HEALTH_CHECK_INTERVAL_MS` | `3000` | Intervalo do monitor |
| `LAUNCH_TIMEOUT_MS` | `120000` | Limite para o worker conectar |

`RAM_URL` e `MCP_URL` têm precedência sobre as formas por porta. Todas as origens upstream precisam ser HTTP loopback. O MCP é fixado em `127.0.0.1:28429` porque a mesma origem aparece no loader.

## Contrato real do MCP

O Launcher implementa os formatos atuais do repositório de referência:

- `GET /health` — saúde e contadores;
- `GET /api/sessions` — `{ activeCount, sessions }`; cada sessão usa `workerId`, `pid`, `status`, `transport`;
- `GET /api/processes` — `{ processes, total, ... }`; usado para observação, não como pré-condição de conexão;
- `GET /api/tools` — definições e schemas das ferramentas;
- `POST /api/tools/execute` — `{ name, arguments }`;
- `GET /mcp.lua` — loader Lua.

A sessão é conectada somente quando `/api/sessions` contém `status: "active"` e `workerId` exatamente igual ao worker persistido. O Launcher não depende da correlação de PID do endpoint de processos, pois o loader e o gerenciador de processos podem representar PID de formas diferentes.

`POST /api/autoexecute` do MCP altera apenas um estado global do dashboard. Para persistir no cliente após teleportes, o Launcher chama a ferramenta `set-autoexecute` com o worker específico.

## API do Launcher

Todos os endpoints abaixo exigem `Authorization: Bearer <PIPELINE_TOKEN>`, exceto os callbacks internos, que usam seus tokens separados.

| Endpoint | Função |
| --- | --- |
| `GET /config` | Contas da interface e estado/modelo do agente |
| `GET /status` | Saúde do MCP, fila e sessões |
| `GET /events` | Feed autenticado `text/event-stream` com sessões e execuções em tempo real |
| `POST /launch` | `{ "links": ["123456"], "alias": "conta-teste" }` |
| `POST /launch-batch` | Distribui um link por conta; valida o lote inteiro antes de criar sessões |
| `POST /attach` | `{ "link": "123456", "alias": "conta-teste" }`; conecta um jogo já aberto sem lançar outro cliente |
| `POST /sessions/:id/retry` | Um único retry para failed/disconnected |
| `GET /prompts` | Histórico persistido do console |
| `POST /prompts` | `{ prompt, scope: "session", session_id }` ou `{ prompt, scope: "all" }` |
| `GET /accounts/local` | Lista usernames do cofre local (ou RAM, no backend opcional) |
| `GET /accounts/ram` | Alias de compatibilidade para a mesma lista |
| `POST /accounts/sync` | Adiciona uma conta já importada ao Launcher |
| `POST /accounts/import` | Valida e salva uma sessão no backend selecionado |
| `GET /agent-policy` | Retorna o AGENTS.md global persistido |
| `POST /agent-policy` | Salva Markdown global de até 64 KiB |
| `POST /internal/autoexec/register` | Registro autenticado do bootstrap Project Real |
| `POST /internal/mcp/:workerId` | Proxy MCP exclusivo da sessão usado pelo Codex CLI |
| `POST /internal/sessions/:id/analyzing` | Callback do controlador de análise |
| `POST /internal/sessions/:id/done` | Callback final e findings opcionais |
| `POST /internal/sessions/:id/failed` | Callback de falha |

PlaceIds aceitam 6–15 dígitos ou URLs exatas `roblox.com/games/{id}`. URLs de perfil, grupo, catálogo, domínios parecidos e IDs fora do intervalo são rejeitados. Um lançamento ativo de alias + PlaceId é idempotente e retorna a sessão existente.

## Persistência e operação

SQLite usa WAL, transações e índices parciais. A fila permanece durável durante reinícios; jogos diferentes da mesma conta aguardam o trabalho ativo, enquanto contas diferentes avançam separadamente. Uma sessão launching que excede `LAUNCH_TIMEOUT_MS` (120 s por padrão) vira failed mesmo quando o MCP está offline. Sessões connected/analyzing que desaparecem de `/api/sessions` viram disconnected.

Logs JSONL ficam em `logs/pipeline.jsonl`, com 50 MiB por arquivo e 3 arquivos totais. Tokens e cabeçalhos não são registrados. Findings de callback ficam em `findings/<session-uuid>-<retry>.json`. Prompts e respostas ficam na tabela `prompt_runs`.

O batch continua disponível:

```powershell
npm run batch -- links.txt
```

Ele valida tudo primeiro, distribui contas round-robin e espera 5 s entre envios.

## Verificação

```powershell
npm run check
```

Compila TypeScript estrito e executa testes de SQLite, estados, idempotência, retry, reinício, monitor, RAM/MCP, bootstrap Project Real, endpoints, rotação e batch. Os testes usam serviços simulados e não abrem jogos reais.

O teste final pelo navegador é separado e abre jogos reais com as duas contas importadas:

```powershell
npm start
# Em outro terminal:
npm run test:e2e:live
```

O Playwright faz login no painel, envia os dois links, exige dois workers conectados em processos distintos, envia um prompt de leitura aos dois terminais e exige duas respostas concluídas. Relatórios e capturas ficam em `playwright-report/` e `test-results/`, ignorados pelo Git. Traces de rede ficam desativados para não gravar tokens. O teste usa o Chrome instalado; `PLAYWRIGHT_CHROME_PATH` permite indicar outro caminho.
