import OpenAI from 'openai';
import type { McpClient, McpTool } from './clients.js';

const DEFAULT_ALLOWED_TOOLS = new Set([
  'list-remotes', 'spy-remotes', 'get-remote-handlers', 'find-instances', 'walk-tree',
  'get-services', 'resolve-path', 'get-children', 'get-player', 'get-players',
  'get-console-logs', 'get-metadata', 'read-properties', 'get-script',
  'execute-script', 'fire-remote', 'check-replication', 'set-autoexecute',
]);

type FunctionCall = { type: 'function_call'; call_id: string; name: string; arguments: string };

export class AgentRunner {
  private client?: OpenAI;
  constructor(apiKey: string, readonly model: string, private mcp: Pick<McpClient, 'tools' | 'callTool'>,
    private allowed = DEFAULT_ALLOWED_TOOLS) {
    if (apiKey) this.client = new OpenAI({ apiKey });
  }
  get configured(): boolean { return !!this.client; }

  private functionTools(tools: McpTool[]): Record<string, unknown>[] {
    return tools.filter(tool => this.allowed.has(tool.name)).map(tool => ({
      type: 'function', name: tool.name, description: tool.description,
      parameters: tool.inputSchema, strict: false,
    }));
  }

  async run(workerId: string, prompt: string, sharedInstructions = ''): Promise<string> {
    if (!this.client) throw new Error('OPENAI_API_KEY is not configured');
    const tools = this.functionTools(await this.mcp.tools());
    if (!tools.length) throw new Error('MCP returned no allowed tools');
    const input: unknown[] = [{ role: 'user', content: prompt }];
    const instructions = `Você é um analista de segurança de jogos Roblox próprios ou formalmente autorizados. Use somente as ferramentas fornecidas e somente a sessão ${workerId}. Nunca invente resultados. Não tente evasão, persistência fora do set-autoexecute, acesso a credenciais ou ações em outras sessões. Explique evidências e limites em português.${sharedInstructions ? `\n\nInstruções globais fornecidas pelo operador em AGENTS.md:\n<agents_md>\n${sharedInstructions}\n</agents_md>` : ''}`;

    for (let turn = 0; turn < 12; turn++) {
      const response = await this.client.responses.create({
        model: this.model, instructions, input: input as never, tools: tools as never,
        parallel_tool_calls: false, store: false,
      });
      const output = response.output as unknown as Array<Record<string, unknown>>;
      const calls = output.filter((item): item is Record<string, unknown> & FunctionCall => item.type === 'function_call' &&
        typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string');
      if (!calls.length) return response.output_text || 'Análise concluída sem resposta textual.';
      input.push(...output);
      for (const call of calls) {
        let result: unknown;
        try {
          const parsed = JSON.parse(call.arguments) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object');
          result = await this.mcp.callTool(call.name, { ...(parsed as Record<string, unknown>), workerId });
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        const serialized = JSON.stringify(result);
        input.push({ type: 'function_call_output', call_id: call.call_id, output: serialized.slice(0, 250_000) });
      }
    }
    throw new Error('Agent exceeded the 12-turn tool limit');
  }
}
