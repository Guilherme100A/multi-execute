import { spawn, spawnSync } from 'node:child_process';
import type { McpClient, McpTool } from './clients.js';

const DEFAULT_ALLOWED_TOOLS = new Set([
  'list-remotes', 'spy-remotes', 'get-remote-handlers', 'find-instances', 'walk-tree',
  'get-services', 'resolve-path', 'get-children', 'get-player', 'get-players',
  'get-console-logs', 'get-metadata', 'read-properties', 'get-script',
  'execute-script', 'fire-remote', 'check-replication', 'set-autoexecute',
]);

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Progress = (transcript: string) => void;
type ThreadStarted = (threadId: string) => void;
export type AgentSelection = { provider: 'codex' | 'claude'; model: string };
export const validModel = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/.test(value);
export function cliResult(line: string, provider: AgentSelection['provider']) {
  let event: any;
  try { event=JSON.parse(line); } catch { return { text: line.trim() }; }
  if (provider === 'codex') return { text: visibleEvent(line), thread: event.type === 'thread.started' ? event.thread_id : undefined,
    final: event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text : undefined,
    error: event.type === 'turn.failed' ? JSON.stringify(event.error ?? 'Falha no Codex') : undefined };
  if (event.type === 'system' && event.subtype === 'init') return { thread: event.session_id, text: '◆ Claude Code conectado' };
  if (event.type === 'assistant') return { text: (event.message?.content ?? []).map((part: any) => part.type === 'text' ? part.text : part.type === 'tool_use' ? `→ ${part.name}` : '').filter(Boolean).join('\n') };
  if (event.type === 'result') return { final: event.result, error: event.is_error ? (event.errors?.join('\n') || event.result || 'Falha no Claude Code') : undefined };
  return {};
}

function executable(command: string): boolean {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', command, '--version'], { stdio: 'ignore' })
    : spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function visibleEvent(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') return `◆ CLI iniciada · ${event.thread_id.slice(0, 8)}`;
    if ((event.type === 'item.started' || event.type === 'item.completed') && event.item && typeof event.item === 'object') {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string') return item.text;
      if (item.type === 'mcp_tool_call') return `${event.type === 'item.started' ? '→' : '✓'} ${String(item.server ?? 'roblox')}/${String(item.tool ?? 'tool')}`;
      if (item.type === 'reasoning' && typeof item.text === 'string') return `· ${item.text}`;
    }
    if (event.type === 'turn.failed') return `✕ ${JSON.stringify(event.error ?? 'Falha na execução')}`;
  } catch { /* stderr or a non-JSON diagnostic is still useful */ }
  return line.trim() || undefined;
}

export class AgentRunner {
  private current: AgentSelection;
  private availability: Record<'codex' | 'claude', boolean>;
  private codexModels: { id: string; label: string }[];
  constructor(private command: string, defaultModel: string, private launcherOrigin: string, private internalToken: string,
    private mcp: Pick<McpClient, 'tools' | 'callTool'>, private allowed = DEFAULT_ALLOWED_TOOLS,
    private timeoutMs = 20 * 60_000, private claudeCommand = process.platform === 'win32' ? 'claude.exe' : 'claude') {
    this.current={provider:'codex',model:defaultModel};
    this.availability={codex:executable(command),claude:executable(claudeCommand)};
    this.codexModels=[{id:defaultModel,label:defaultModel}];
    if (this.availability.codex) {
      try {
        const result=process.platform === 'win32' ? spawnSync('cmd.exe',['/d','/s','/c',command,'debug','models'],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:8*1024*1024}) : spawnSync(command,['debug','models'],{encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
        const models=JSON.parse(result.stdout).models.filter((row: any)=>row.visibility==='list' && validModel(row.slug)).map((row: any)=>({id:row.slug,label:row.display_name || row.slug}));
        this.codexModels=[...this.codexModels,...models.filter((row: {id: string})=>row.id!==defaultModel)];
      } catch { /* Keep the configured model if catalog discovery is unavailable. */ }
    }
  }
  get configured() { return this.availability[this.current.provider]; }
  get model() { return this.current.model; }
  get selection(): AgentSelection { return {...this.current}; }
  providers() { return [
    {id:'codex',label:'Codex CLI',installed:this.availability.codex,models:this.codexModels},
    {id:'claude',label:'Claude Code',installed:this.availability.claude,models:['sonnet','opus','haiku','fable'].map(id=>({id,label:id[0]!.toUpperCase()+id.slice(1)}))},
  ]; }
  select(value: unknown): AgentSelection {
    const selection=value as AgentSelection | undefined;
    if (!selection || !['codex','claude'].includes(selection.provider) || !validModel(selection.model)) throw new Error('Selecione uma CLI e um modelo válidos');
    if (!this.availability[selection.provider]) throw new Error('A CLI selecionada não está instalada neste computador');
    this.current={provider:selection.provider,model:selection.model}; return this.selection;
  }

  private safeTools(tools: McpTool[]): McpTool[] {
    return tools.filter(tool => this.allowed.has(tool.name)).map(tool => {
      const schema = structuredClone(tool.inputSchema);
      if (schema.properties && typeof schema.properties === 'object') delete (schema.properties as Record<string, unknown>).workerId;
      if (Array.isArray(schema.required)) schema.required = schema.required.filter(value => value !== 'workerId');
      return { ...tool, inputSchema: schema };
    });
  }

  async mcpRpc(workerId: string, message: unknown): Promise<unknown> {
    if (Array.isArray(message)) return Promise.all(message.map(value => this.mcpRpc(workerId, value)));
    if (!message || typeof message !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const request = message as JsonRpc;
    if (request.method === 'notifications/initialized') return undefined;
    if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id ?? null, result: {
      protocolVersion: typeof request.params?.protocolVersion === 'string' ? request.params.protocolVersion : '2025-03-26',
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'multi-execute-session', version: '1.0.0' },
    } };
    if (request.method === 'ping') return { jsonrpc: '2.0', id: request.id ?? null, result: {} };
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id ?? null, result: { tools: this.safeTools(await this.mcp.tools()) } };
    if (request.method === 'tools/call') {
      const name = request.params?.name;
      if (typeof name !== 'string' || !this.allowed.has(name)) return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: 'Tool is not allowed' } };
      const supplied = request.params?.arguments;
      const args = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied as Record<string, unknown> : {};
      try {
        const result = await this.mcp.callTool(name, { ...args, workerId });
        return { jsonrpc: '2.0', id: request.id ?? null, result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] } };
      } catch (error) {
        return { jsonrpc: '2.0', id: request.id ?? null, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } };
      }
    }
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: 'Method not found' } };
  }

  async run(workerId: string, prompt: string, sharedInstructions = '', onProgress?: Progress,
    resumeThread?: string, onThreadStarted?: ThreadStarted, signal?: AbortSignal, selection = this.selection): Promise<string> {
    signal?.throwIfAborted();
    if (!this.availability[selection.provider]) throw new Error('A CLI selecionada não está instalada');
    const endpoint = `${this.launcherOrigin}/internal/mcp/${encodeURIComponent(workerId)}`;
    const instructions = `Você é um analista de segurança de jogos Roblox próprios ou formalmente autorizados. Analise somente o worker atribuído a este terminal. Use exclusivamente as ferramentas do servidor MCP roblox; não use shell, web ou arquivos. O proxy já fixa o worker_id, portanto não tente escolher outra sessão. Nunca invente resultados, tente evasão ou acesse credenciais. Responda em português com evidências e limites.${sharedInstructions ? `\n\nInstruções globais fornecidas pelo operador em AGENTS.md:\n<agents_md>\n${sharedInstructions}\n</agents_md>` : ''}\n\nSolicitação do operador:\n${prompt}`;
    const common = ['--json', '--ignore-user-config', '--skip-git-repo-check', '--model', selection.model,
      '-c', `mcp_servers.roblox.url=${JSON.stringify(endpoint)}`,
      '-c', 'mcp_servers.roblox.bearer_token_env_var="PIPELINE_CLI_MCP_TOKEN"',
      '-c', 'mcp_servers.roblox.default_tools_approval_mode="approve"'];
    const codexArgs = resumeThread
      ? ['exec', 'resume', ...common, resumeThread, '-']
      : ['exec', ...common, '--sandbox', 'read-only', '-'];
    const claudeArgs=['--print','--output-format','stream-json','--verbose','--model',selection.model,
      '--restricted','--tools','','--strict-mcp-config','--settings',JSON.stringify({disableAllHooks:true}),
      '--mcp-config',JSON.stringify({mcpServers:{roblox:{type:'http',url:endpoint,headers:{Authorization:'Bearer ${PIPELINE_CLI_MCP_TOKEN}'}}}}),
      '--allowedTools','mcp__roblox__*',...(resumeThread ? ['--resume',resumeThread] : [])];
    const command = selection.provider === 'claude' ? this.claudeCommand : process.platform === 'win32' ? 'cmd.exe' : this.command;
    const args = selection.provider === 'claude' ? claudeArgs : process.platform === 'win32' ? ['/d', '/s', '/c', this.command, ...codexArgs] : codexArgs;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PIPELINE_CLI_MCP_TOKEN: this.internalToken },
      });
      let pending = '', transcript = '', finalMessage = '', diagnostics = '', failure = '';
      const terminate = () => {
        // On Windows the CLI is a child of cmd.exe; terminate the entire tree.
        if (process.platform === 'win32' && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
        else child.kill();
      };
      const abort = () => { terminate(); reject(new Error('Análise interrompida: o jogo foi desconectado.')); };
      signal?.addEventListener('abort', abort, { once: true });
      const publish = (line: string) => {
        if (signal?.aborted) return;
        const parsed=cliResult(line,selection.provider);
        if (parsed.thread) onThreadStarted?.(parsed.thread);
        if (parsed.final) finalMessage=parsed.final;
        if (parsed.error) failure=parsed.error;
        const visible = parsed.text;
        if (!visible) return;
        transcript = `${transcript}${transcript ? '\n' : ''}${visible}`.slice(-250_000);
        onProgress?.(transcript);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
        for (const line of lines) publish(line);
      });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-16_000); });
      const timeout = setTimeout(() => { terminate(); reject(new Error('Agent CLI timed out')); }, this.timeoutMs);
      child.once('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); reject(error); });
      child.once('close', code => {
        signal?.removeEventListener('abort', abort);
        clearTimeout(timeout); if (pending.trim()) publish(pending);
        if (failure || code !== 0) { reject(new Error(failure || `Agent CLI exited with code ${String(code)}${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}`)); return; }
        resolve(finalMessage || transcript || 'Análise concluída sem resposta textual.');
      });
      child.stdin.end(instructions);
    });
  }
}
