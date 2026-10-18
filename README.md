# Roblox Security Pipeline

Launcher local em Express/TypeScript para coordenar jogos no [Roblox Account Manager](https://github.com/ic3w0lf22/Roblox-Account-Manager), carregar o [roblox-mcp-difz](https://github.com/Difz25x/roblox-mcp-difz) pelo Auto Execute do Project Real e conduzir análises autorizadas por uma interface web dark.

Use somente em jogos próprios ou com autorização explícita. `AUTHORIZED_PLACE_IDS` é uma allowlist obrigatória; o Launcher não consulta propriedade no Roblox.

## O que fica automático

Depois da configuração única:

1. Você abre `http://127.0.0.1:3000`, informa o token e escolhe conta + link.
2. O Launcher valida o PlaceId, cria o worker e chama o RAM.
3. O Auto Execute do Project Real registra usuário/jogo no Launcher e recebe o `worker_id` correto.
4. O bootstrap carrega `mcp.lua` uma única vez para aquele `JobId`.
5. Ao detectar o worker no MCP, o Launcher chama `set-autoexecute` para armar `queue_on_teleport`.
6. O console envia um prompt para uma sessão ou para todas as conectadas. Cada prompt de massa gera uma execução isolada por worker.

O Project Real documenta que Auto Execute roda depois da injeção, mas não publica API para acionar **Inject**. Se a integração RAM/Project Real instalada não fizer auto-injeção, esse clique continua sendo necessário quando o cliente abrir. O Launcher não simula mouse nem inventa um endpoint privado.

## Instalação

Requer Node.js 24+, RAM, Project Real, roblox-mcp-difz e Codex CLI autenticado na mesma máquina.

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

`ramAccount` precisa ser o username ou UserId reconhecido pelo RAM; o endpoint oficial não procura pelo alias visual. Não coloque cookie, senha ou token nesse arquivo. Ele é ignorado pelo Git.

## Configuração do RAM

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

1. Execute `npm run setup:real`.
2. Importe o `project-real-autoexec.lua` gerado na pasta **Auto-Execute** do Project Real.
3. Deixe Auto Execute habilitado.
4. Inicie **Real MCP** em `Settings → Connections`.
5. Inicie o `roblox-mcp-difz` na porta `28429`.

O arquivo gerado contém `AUTOEXEC_TOKEN`, por isso é ignorado pelo Git. Ele espera `LocalPlayer`, envia username, PlaceId e JobId ao endpoint local `/internal/autoexec/register`, define `MCP_WORKER_ID` e carrega `http://127.0.0.1:28429/mcp.lua`. Uma trava por JobId impede execução repetida na mesma instância.

## Interface web

Abra `http://127.0.0.1:3000`. A interface pede `PIPELINE_TOKEN` e guarda o valor apenas em `sessionStorage` da aba.

- **Abrir jogo:** escolha uma conta e informe URL ou PlaceId.
- **Gerenciar contas:** sincronize contas existentes no RAM ou importe uma nova conta sem editar JSON manualmente.
- **Sessões:** acompanhe os estados e use retry quando permitido.
- **Console:** cada sessão possui seu próprio terminal, histórico e campo de prompt. O compositor superior envia o mesmo prompt para todas as sessões conectadas. Estados e respostas chegam por um feed HTTP persistente, sem recarregar a página.
- **AGENTS.md global:** carregue instruções Markdown aplicadas a todas as sessões.
- **Histórico:** prompts, respostas e erros ficam persistidos no SQLite.

Na importação, o cookie de sessão passa uma única vez pelo Launcher e segue diretamente para o RAM local. O Launcher não o grava nem registra e não repete a chamada automaticamente. O RAM necessariamente persiste esse cookie no próprio armazenamento de contas. Mantenha o RAM restrito a loopback e nunca compartilhe o cookie.

Os terminais usam o login local do **Codex CLI**, sem `OPENAI_API_KEY` no Launcher. O padrão é `AGENT_MODEL=gpt-6.1-sol`. O primeiro prompt cria uma thread com `codex exec --json` em sandbox somente leitura; os seguintes usam `codex exec resume`, mantendo contexto separado por worker. Os eventos são transmitidos ao terminal correspondente.

Cada processo recebe apenas um endpoint MCP intermediário autenticado. Esse proxy remove `workerId` do schema apresentado ao modelo e sobrescreve o valor no servidor, impedindo que um terminal redirecione ferramentas ou faça broadcast para outra sessão. As ferramentas internas de shell, web e arquivos também são proibidas pelo prompt do agente; o acesso ao projeto permanece somente leitura. Se o CLI não estiver instalado ou autenticado, lançamento e monitoramento continuam funcionando e o console mostra o estado da configuração.

Ferramentas expostas ao agente são limitadas no código a inspeção, remotes, execução de teste, metadados e autoexecute. O MCP permanece em `127.0.0.1:28429`; o servidor de referência não autentica sua API e usa CORS aberto, portanto não exponha essa porta na rede.

## Variáveis principais

| Variável | Padrão | Uso |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Interface e API local |
| `RAM_URL` / `RAM_PORT` | `http://127.0.0.1:7963` / `7963` | Webserver do RAM |
| `RAM_PASSWORD` | vazio | Webserver Password do RAM |
| `MCP_URL` | `http://127.0.0.1:28429` | roblox-mcp-difz |
| `AUTHORIZED_PLACE_IDS` | obrigatório | IDs autorizados, separados por vírgula |
| `AGENT_CLI_COMMAND` | `codex.cmd` no Windows | Executável local usado pelos terminais |
| `AGENT_MODEL` | `gpt-6.1-sol` | Modelo solicitado ao Codex CLI |
| `DB_PATH` | `data/sessions.sqlite` | SQLite em WAL |
| `HEALTH_CHECK_INTERVAL_MS` | `30000` | Intervalo do monitor |
| `LAUNCH_TIMEOUT_MS` | `60000` | Limite para o worker conectar |

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
| `POST /sessions/:id/retry` | Um único retry para failed/disconnected |
| `GET /prompts` | Histórico persistido do console |
| `POST /prompts` | `{ prompt, scope: "session", session_id }` ou `{ prompt, scope: "all" }` |
| `GET /accounts/ram` | Lista usernames já cadastrados no RAM |
| `POST /accounts/sync` | Adiciona uma conta existente do RAM ao Launcher |
| `POST /accounts/import` | Importa cookie no RAM e persiste somente alias/username no Launcher |
| `GET /agent-policy` | Retorna o AGENTS.md global persistido |
| `POST /agent-policy` | Salva Markdown global de até 64 KiB |
| `POST /internal/autoexec/register` | Registro autenticado do bootstrap Project Real |
| `POST /internal/mcp/:workerId` | Proxy MCP exclusivo da sessão usado pelo Codex CLI |
| `POST /internal/sessions/:id/analyzing` | Callback do controlador de análise |
| `POST /internal/sessions/:id/done` | Callback final e findings opcionais |
| `POST /internal/sessions/:id/failed` | Callback de falha |

PlaceIds aceitam 6–15 dígitos ou URLs exatas `roblox.com/games/{id}`. URLs de perfil, grupo, catálogo, domínios parecidos e IDs fora do intervalo são rejeitados. Um lançamento ativo de alias + PlaceId é idempotente e retorna a sessão existente.

## Persistência e operação

SQLite usa WAL, transações e índices parciais. A fila permanece durável durante reinícios; jogos diferentes da mesma conta aguardam o trabalho ativo, enquanto contas diferentes avançam separadamente. Uma sessão launching há mais de 60 s vira failed mesmo quando o MCP está offline. Sessões connected/analyzing que desaparecem de `/api/sessions` viram disconnected.

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
