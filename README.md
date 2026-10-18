# Pipeline local para testes Roblox autorizados

Servidor Express/TypeScript para coordenar contas no Roblox Account Manager (RAM), acompanhar sessões no MCP e submeter um loader Lua uma única vez por instância. Exclusivo para jogos próprios ou com autorização explícita. A lista `AUTHORIZED_PLACE_IDS` é obrigatória; inserir um ID declara que você possui essa autorização. O pipeline não verifica propriedade no Roblox.

## Instalação

Requer Node.js **24+** (SQLite nativo), npm, RAM e MCP já instalados/configurados localmente. Não instala executores, não altera jogos e não configura autoexecute.

```powershell
npm ci
Copy-Item .env.example .env
Copy-Item accounts.example.json accounts.json
# Edite .env e accounts.json antes de iniciar
npm run check
npm start
```

Gere segredos diferentes para `PIPELINE_TOKEN` e `INTERNAL_CALLBACK_TOKEN`, por exemplo com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Cada um precisa ter no mínimo 24 caracteres; placeholders e valores iguais são rejeitados. `accounts.json` é configuração local ignorada pelo Git; copie `accounts.example.json` e preencha. Cada entrada tem `alias` único (1–64 letras ASCII, números, `_` ou `-`) e `ramAccount` correspondente ao nome cadastrado no RAM. Não coloque cookies ou senhas nesse arquivo. Use aliases distintos para contas RAM distintas.

Configure `AUTHORIZED_PLACE_IDS` com IDs separados por vírgula, de 6–15 dígitos. Nenhum lançamento é permitido sem essa lista, inclusive sessões pendentes recuperadas de outro processo. RAM usa `RAM_URL` (padrão `http://127.0.0.1:8080`). MCP deve atender em `http://127.0.0.1:28429`, também utilizado pelo loader. Origens remotas e URLs com credenciais são rejeitadas. Tokens opcionais dos serviços são `RAM_TOKEN` e `MCP_TOKEN`, enviados como Bearer; não são enviados ao jogo.

As variáveis da especificação também são aceitas: `RAM_PORT=8080`, `MCP_HOST=127.0.0.1`, `MCP_PORT=28429`, `DB_PATH`, `HEALTH_CHECK_INTERVAL_MS`, `LAUNCH_TIMEOUT_MS`, `MAX_RETRIES` e `RETRY_BASE_DELAY_MS`. `RAM_URL` e `MCP_URL` têm precedência sobre host/porta. O host e a porta do MCP permanecem fixos porque também estão embutidos no loader.

O servidor escuta somente em loopback (`HOST=127.0.0.1`, `PORT=3000`). Os endpoints de operação exigem `Authorization: Bearer <PIPELINE_TOKEN>`; `/internal/*` exige o segredo separado `INTERNAL_CALLBACK_TOKEN`. Não há CORS. Mantenha um único controlador por banco de dados, use contas de teste separadas e não altere o mapeamento de aliases durante uma execução. Para outro ambiente, use arquivos SQLite, contas, portas, logs e diretórios de findings separados. Não compartilhe uma instância MCP entre controladores concorrentes: a garantia de execução única é persistida no banco deste controlador.

## API do pipeline

Exemplo PowerShell:

```powershell
$headers = @{ Authorization = 'Bearer SEU_TOKEN' }
$body = @{ links = @('https://www.roblox.com/games/123456/MeuJogo'); alias = 'test-account' } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3000/launch -Method Post -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod http://127.0.0.1:3000/status -Headers $headers
```

| Endpoint | Entrada e resultado |
| --- | --- |
| `POST /launch` | `{ "links": ["123456"], "alias": "test-account" }`; 1–100 links; retorna `{ sessions: [{ session, reused }] }`; 202 para itens novos, 200 quando todos já existem. Valida todos antes de inserir. |
| `GET /status` | `{ mcp_online, queue_paused, sessions }`; inclui erro, retry, IDs e timestamps de cada sessão. |
| `POST /sessions/:id/retry` | Recoloca uma sessão failed/disconnected na fila; 202. Uma única vez por sessão; renova worker_id. Não encerra processos antigos. |
| `POST /internal/sessions/:id/analyzing` | `{ "worker_id": "alias-timestamp-uuid" }`; connected → analyzing. |
| `POST /internal/sessions/:id/done` | `{ "worker_id": "...", "findings": { ... } }`; analyzing → done; findings opcional. |
| `POST /internal/sessions/:id/failed` | `{ "worker_id": "...", "error": "motivo" }`; connected/analyzing → failed; erro de 1–4000 caracteres. |

400 indica entrada inválida; 401 autenticação ausente/incorreta; 404 sessão/rota desconhecida; 409 transição inválida, callback antigo ou retry esgotado; 413 corpo maior que 1 MiB. Callbacks repetidos usam semântica first-write-wins: o mesmo estado retorna o resultado persistido e ignora um payload posterior. Um worker_id anterior ao retry sempre recebe 409. Apenas o controlador confiável envia callbacks com `INTERNAL_CALLBACK_TOKEN`; não distribua nenhum token ao cliente Roblox. `MCP_SESSION_ID` identifica a sessão do pipeline; o `id` remoto MCP é independente.

Aceita ID puro de 6–15 dígitos ou URLs HTTP/HTTPS com host exato `roblox.com`/`www.roblox.com`, caminho `/games/{id}` e um slug opcional. Query e fragmento não mudam o ID. URLs de perfil, grupo, catálogo, domínio parecido e IDs fora do intervalo são rejeitados. Não há resolução de redirects ou links curtos.

## Estados, persistência e recuperação

Fluxo: `pending → launching → connected → analyzing → done|failed`. Erros de RAM e timeout levam a failed; connected/analyzing que desaparece leva a disconnected. Failed/disconnected permite um único retry para pending; done é terminal. O worker usa `alias-timestamp-UUID`, evitando colisões mesmo com o mesmo relógio.

SQLite em `DATABASE_FILE` (padrão `data/sessions.sqlite`), WAL e transações guardam os campos solicitados: `id`, `link`, `place_id`, `account_alias`, `worker_id`, `status`, `last_error`, `retry_count`, `created_at`, `updated_at`, `launching_at`, `connected_at`, `finished_at`, `instance_id`. Timestamps são milissegundos Unix. Índice parcial impede duplicação de alias+PlaceId nos estados launching/connected/analyzing e também pending. Jogos diferentes da mesma conta aguardam o término do trabalho ativo; contas diferentes podem avançar de forma independente. Lançamentos RAM são solicitados sequencialmente.

O monitor roda na inicialização e a cada **30 s**, sem sobreposição. `/health`, `/api/sessions` e `/api/processes` devem estar disponíveis e válidos; falhas pausam novos lançamentos e preservam estados conectados, pois indisponibilidade do MCP não prova que o jogo fechou. Launching há **mais de 60 s** vira failed mesmo offline (observado no próximo tick). Antes de cada lançamento, a saúde é conferida novamente. Uma chamada RAM já em curso pode terminar durante uma queda MCP; a pausa bloqueia novos despachos.

Um snapshot persistido exclui instâncias que já existiam antes do lançamento. Conexão exige alias+PlaceId exatos, processo vivo, worker_id compatível quando fornecido e **uma única** candidata. Não escolhe arbitrariamente entre instâncias ambíguas. A tabela `injections` registra a reivindicação de uma instância **antes** do POST execute; a restrição única impede uma segunda submissão mesmo após retry, falha HTTP ou reinício. Não apague essa tabela para tentar novamente. O retry deve produzir uma instância nova. O loader também tem uma trava Lua por instância.

Essa garantia é **no máximo uma submissão**, não execução garantida: se houver crash entre a gravação e o envio, a instância fica consumida por segurança. Ao reiniciar, connected com claim sem confirmação analyzing vira failed com erro explícito; o único retry pode usar outra instância. Launching recuperada é monitorada sem relançar RAM; analyzing recuperada continua monitorada. Sessões que perderam autorização ou mapeamento de conta viram failed e não recebem loader. Não há timeout automático para analyzing: o controlador deve reportar done/failed.

## Contrato esperado do RAM/MCP

As APIs de instalações distintas podem variar. Estes são os contratos implementados em `src/clients.ts`; adapte o serviço ou um adaptador local caso sua versão use outro formato. Não foram confirmados contra uma instalação real nesta entrega.

RAM: `GET /LaunchAccount?Account=<nome codificado>&PlaceId=<id>`. Cada tentativa tem deadline de **10 s**. São **3 tentativas totais**, com esperas de **2 s e 4 s** entre elas, exponenciais com teto **8 s**. Não há espera após a terceira falha, pois não existe quarta tentativa. HTTP não-2xx, exceção de rede, `{ "success": false }` e texto começando por error/failed/false são falhas. O endpoint upstream não fornece chave de idempotência: um timeout pode ocorrer após RAM já ter lançado. Instâncias ambíguas são recusadas pelo monitor; RAM deve tratar repetição de launch de forma idempotente se precisar de garantia equivalente no lançamento.

MCP:

| Endpoint | Contrato |
| --- | --- |
| `GET /health` | HTTP 2xx; opcional JSON. `ok:false`, `healthy:false` ou status offline/error/unhealthy indicam falha. |
| `GET /api/sessions` | Array ou `{ "sessions": [...] }`, com objetos como abaixo. |
| `GET /api/processes` | Array ou `{ "processes": [{ "instance_id": "boot:pid:start" }] }`. |
| `POST /api/execute` | `{ "session_id": "id-remoto", "script": "...Lua..." }`; HTTP 2xx confirma submissão; `{ "success": false }` rejeita. **Nunca repetido automaticamente.** |
| `GET /mcp.lua` | Fonte Lua obtida pelo loader via `game:HttpGet` em pcall. |

Objeto de sessão remoto:

```json
{
  "id": "id-remoto",
  "instance_id": "boot:pid:start",
  "account_alias": "test-account",
  "place_id": "123456",
  "worker_id": "opcional-se-ainda-nao-injetado"
}
```

Todos esses identificadores devem ser strings. `account_alias` é o alias do pipeline, não necessariamente o nome da conta RAM. `instance_id` precisa ser estável ao longo da vida da instância e único após reabertura/reboot; **PID isolado não basta**, por poder ser reutilizado. Sessões e processos devem compartilhar o mesmo identificador. O MCP deve fornecer os metadados antes do loader; sem correlação confiável, o pipeline prefere timeout a executar na conta errada.

`src/loader.ts` gera Lua parametrizado por worker/sessão, com escapes seguros. Define `MCP_WORKER_ID` e `MCP_SESSION_ID` no ambiente, obtém `http://127.0.0.1:28429/mcp.lua` com pcall, compila e executa também com tratamento de erro. Nenhum token é embutido. Configuração de **set-autoexecute é responsabilidade do MCP**; este projeto não a altera. O MCP/controlador deve observar o resultado do loader e reportar analyzing/failed/done pelos endpoints internos. O pipeline não inventa resultados de análise nem implementa um executor Roblox.

## Batch, logs e findings

Crie `links.txt`, um link ou ID por linha (`#` inicia comentário de linha):

```powershell
npm run batch -- links.txt
```

Alterna as contas de `accounts.json` em round-robin e espera **5 s entre submissões**. Valida todos os links primeiro; interrompe em erro HTTP e mostra cada resposta em JSON. Uma submissão aceita pode ficar pending até a conta estar livre. `PIPELINE_URL` opcional troca a origem local usada pelo batch. A versão compilada é `node --env-file-if-exists=.env dist/src/batch.js links.txt`.

Logs JSONL em `logs/pipeline.jsonl`, rotação em **50 MiB**, **3 arquivos totais** (atual, `.1`, `.2`). Registra transições, falhas, retries, fila e submissões; não registra cabeçalhos/token, script ou resultados completos. Faça backup do banco, incluindo WAL/SHM se houver processo ativo, por mecanismo de backup SQLite ou com o controlador parado. Findings enviados no callback done ficam em `findings/<session-uuid>-<retry_count>.json`; IDs gerados internamente impedem path traversal. O corpo continua limitado a 1 MiB. A pasta também pode receber evidências manuais autorizadas. `agent-prompt.md` contém as instruções de escopo e relato para o agente de análise.

`npm run check` compila em modo TypeScript estrito e roda testes com SQLite real e serviços HTTP simulados. Os testes cobrem validação, transições, idempotência, retry, isolamento, monitor, reinício, execução única, protocolo RAM/MCP, endpoints, rotação e batch. Um teste real exige os serviços MCP/RAM configurados, uma conta de teste e um PlaceId autorizado; nenhum jogo real é aberto pelos testes automatizados.
