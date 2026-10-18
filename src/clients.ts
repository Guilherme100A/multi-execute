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
  constructor(private http: HttpClient, private wait = sleep, private attempts = 3, private baseDelay = 2_000) {}
  async launch(account: string, place: string): Promise<void> {
    const params = new URLSearchParams({ Account: account, PlaceId: place });
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const result = await this.http.request(`/LaunchAccount?${params}`, 'GET', undefined, 10_000);
        if (result && typeof result === 'object' && ('success' in result) && result.success === false) throw new Error('RAM rejected launch');
        if (typeof result === 'string' && /^(error|failed|false)\b/i.test(result.trim())) throw new Error('RAM rejected launch');
        return;
      } catch (error) {
        if (attempt === this.attempts - 1) throw error;
        await this.wait(Math.min(this.baseDelay * 2 ** attempt, 8000));
      }
    }
  }
}
export interface McpSession { id: string; instanceId: string; accountAlias: string; placeId: string; workerId?: string }
export interface McpProcess { instanceId: string }
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
    return rows(await this.http.request('/api/sessions'), 'sessions').map(row => ({
      id: required(row, 'id'), instanceId: required(row, 'instance_id'), accountAlias: required(row, 'account_alias'),
      placeId: required(row, 'place_id'), ...(typeof row.worker_id === 'string' ? { workerId: row.worker_id } : {}),
    }));
  }
  async processes(): Promise<McpProcess[]> {
    return rows(await this.http.request('/api/processes'), 'processes').map(row => ({ instanceId: required(row, 'instance_id') }));
  }
  async execute(id: string, script: string): Promise<void> {
    const value = await this.http.request('/api/execute', 'POST', { session_id: id, script });
    if (value && typeof value === 'object' && 'success' in value && value.success === false) throw new Error('MCP rejected execution');
  }
}
