export type Fetcher = typeof fetch;
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class HttpClient {
  constructor(readonly base: string, private token = '', private fetcher: Fetcher = fetch) {}
  async request(path: string, method = 'GET', body?: unknown, timeout = 10_000): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.base), {
      method, signal: AbortSignal.timeout(timeout),
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} returned HTTP ${response.status}`);
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
}
export class RamClient {
  constructor(private http: HttpClient, private password = '', private wait = sleep, private attempts = 3, private baseDelay = 2_000) {}
  async launch(account: string, place: string): Promise<void> {
    const params = new URLSearchParams({ Account: account, PlaceId: place });
    if (this.password) params.set('Password', this.password);
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const result = await this.http.request(`/v2/LaunchAccount?${params}`, 'GET', undefined, 10_000);
        if (result && typeof result === 'object') {
          const row = result as Record<string, unknown>;
          if (row.Success === false || row.success === false) throw new Error(`RAM rejected launch: ${String(row.Message ?? row.message ?? 'unknown error')}`);
        }
        if (typeof result === 'string' && /^(error|failed|false)\b/i.test(result.trim())) throw new Error('RAM rejected launch');
        return;
      } catch (error) {
        if (attempt === this.attempts - 1) throw error;
        await this.wait(Math.min(this.baseDelay * 2 ** attempt, 8000));
      }
    }
  }
  private params(values: Record<string, string>): URLSearchParams {
    const params = new URLSearchParams(values);
    if (this.password) params.set('Password', this.password);
    return params;
  }
  private result(value: unknown, operation: string): string {
    if (!value || typeof value !== 'object') throw new Error(`Invalid RAM ${operation} response`);
    const row = value as Record<string, unknown>;
    if (row.Success !== true || typeof row.Message !== 'string') throw new Error(`RAM ${operation} failed: ${String(row.Message ?? 'unknown error')}`);
    return row.Message;
  }
  async accounts(): Promise<string[]> {
    const message = this.result(await this.http.request(`/v2/GetAccounts?${this.params({})}`), 'GetAccounts');
    if (!message.trim()) return [];
    const accounts = message.split(',').map(value => value.trim()).filter(Boolean);
    if (accounts.some(value => !/^[A-Za-z0-9_]{3,20}$/.test(value))) throw new Error('RAM returned an invalid username');
    return [...new Set(accounts)];
  }
  async importCookie(cookie: string): Promise<void> {
    if (typeof cookie !== 'string' || cookie.length < 20 || cookie.length > 4096 || /[\r\n]/.test(cookie)) throw new Error('Invalid Roblox security cookie');
    this.result(await this.http.request(`/v2/ImportCookie?${this.params({ Cookie: cookie })}`), 'ImportCookie');
  }
}
export interface McpSession { id: string; instanceId: string; workerId?: string; status?: string; pid?: string; accountAlias?: string; placeId?: string }
export interface McpProcess { instanceId: string; workerId?: string }
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
function rows(value: unknown, key: string): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(list) || list.some(row => !row || typeof row !== 'object')) throw new Error(`Invalid MCP ${key} response`);
  return list as Record<string, unknown>[];
}
function required(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new Error(`MCP requires nonempty ${key}`);
  return value;
}
function optional(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value) throw new Error(`MCP requires nonempty ${key} when present`);
  return value;
}
function stringish(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
export class McpClient {
  constructor(private http: HttpClient) {}
  async health(): Promise<void> {
    const value = await this.http.request('/health');
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (row.ok === false || row.healthy === false || ['offline', 'error', 'unhealthy'].includes(String(row.status))) throw new Error('MCP unhealthy');
    }
  }
  async sessions(): Promise<McpSession[]> {
    return rows(await this.http.request('/api/sessions'), 'sessions').filter(row => row.status === 'active').map(row => {
      const workerId = required(row, 'workerId');
      const pid = stringish(row, 'pid');
      return { id: workerId, workerId, status: 'active', instanceId: pid ? `pid:${pid}` : `worker:${workerId}`, ...(pid ? { pid } : {}) };
    });
  }
  async processes(): Promise<McpProcess[]> {
    return rows(await this.http.request('/api/processes'), 'processes').map(row => {
      const pid = stringish(row, 'pid');
      if (!pid) throw new Error('MCP process requires pid');
      const workerId = optional(row, 'workerId');
      return { instanceId: `pid:${pid}`, ...(workerId ? { workerId } : {}) };
    });
  }
  async execute(id: string, script: string): Promise<void> {
    await this.callTool('execute-script', { workerId: id, code: script, async: false });
  }
  async tools(): Promise<McpTool[]> {
    return rows(await this.http.request('/api/tools'), 'tools').map(row => ({
      name: required(row, 'name'), description: optional(row, 'description') ?? '',
      inputSchema: row.inputSchema && typeof row.inputSchema === 'object' ? row.inputSchema as Record<string, unknown> : { type: 'object', properties: {} },
    }));
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const value = await this.http.request('/api/tools/execute', 'POST', { name, arguments: args }, 120_000);
    if (value && typeof value === 'object') {
      const envelope = value as Record<string, unknown>;
      if (envelope.error) throw new Error(`MCP tool error: ${JSON.stringify(envelope.error)}`);
      const result = envelope.result;
      if (result && typeof result === 'object' && (result as Record<string, unknown>).isError === true)
        throw new Error(`MCP tool failed: ${JSON.stringify(result)}`);
    }
    return value;
  }
}
