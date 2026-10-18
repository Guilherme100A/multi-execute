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
  readonly configured: boolean;
  constructor(private command: string, readonly model: string, private launcherOrigin: string, private internalToken: string,
    private mcp: Pick<McpClient, 'tools' | 'callTool'>, private allowed = DEFAULT_ALLOWED_TOOLS,
    private timeoutMs = 20 * 60_000) {
    this.configured = executable(command);
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
    resumeThread?: string, onThreadStarted?: ThreadStarted): Promise<string> {
    if (!this.configured) throw new Error(`Agent CLI is unavailable: ${this.command}`);
    const endpoint = `${this.launcherOrigin}/internal/mcp/${encodeURIComponent(workerId)}`;
    const instructions = `Você é um analista de segurança de jogos Roblox próprios ou formalmente autorizados. Analise somente o worker atribuído a este terminal. Use exclusivamente as ferramentas do servidor MCP roblox; não use shell, web ou arquivos. O proxy já fixa o worker_id, portanto não tente escolher outra sessão. Nunca invente resultados, tente evasão ou acesse credenciais. Responda em português com evidências e limites.${sharedInstructions ? `\n\nInstruções globais fornecidas pelo operador em AGENTS.md:\n<agents_md>\n${sharedInstructions}\n</agents_md>` : ''}\n\nSolicitação do operador:\n${prompt}`;
    const common = ['--json', '--ignore-user-config', '--skip-git-repo-check', '--model', this.model,
      '-c', `mcp_servers.roblox.url=${JSON.stringify(endpoint)}`,
      '-c', 'mcp_servers.roblox.bearer_token_env_var="PIPELINE_CLI_MCP_TOKEN"'];
    const codexArgs = resumeThread
      ? ['exec', 'resume', ...common, resumeThread, '-']
      : ['exec', ...common, '--sandbox', 'read-only', '-'];
    const command = process.platform === 'win32' ? 'cmd.exe' : this.command;
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', this.command, ...codexArgs] : codexArgs;
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PIPELINE_CLI_MCP_TOKEN: this.internalToken },
      });
      let pending = '', transcript = '', finalMessage = '', diagnostics = '';
      const publish = (line: string) => {
        const visible = visibleEvent(line);
        if (!visible) return;
        transcript = `${transcript}${transcript ? '\n' : ''}${visible}`.slice(-250_000);
        try {
          const event = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string } };
          if (event.type === 'thread.started' && event.thread_id) onThreadStarted?.(event.thread_id);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) finalMessage = event.item.text;
        } catch { /* keep the readable transcript */ }
        onProgress?.(transcript);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
        for (const line of lines) publish(line);
      });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-16_000); });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Agent CLI timed out')); }, this.timeoutMs);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => {
        clearTimeout(timeout); if (pending.trim()) publish(pending);
        if (code !== 0) { reject(new Error(`Agent CLI exited with code ${String(code)}${diagnostics.trim() ? `: ${diagnostics.trim()}` : ''}`)); return; }
        resolve(finalMessage || transcript || 'Análise concluída sem resposta textual.');
      });
      child.stdin.end(instructions);
    });
  }
}
