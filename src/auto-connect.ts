import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { Pipeline } from './pipeline.js';
import type { McpClient } from './clients.js';
import type { Logger } from './logger.js';
import { makeProjectRealAutoexec } from './project-real.js';

export interface RealConnection {
  connect(): Promise<void>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export class RealConnectionClient implements RealConnection {
  private client?: Client;
  constructor(private executable: string) {}
  async connect(): Promise<void> {
    if (this.client) return;
    const client = new Client({ name: 'multi-execute', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(new StdioClientTransport({ command: this.executable, stderr: 'ignore' }));
      this.client = client;
    } catch { await client.close(); throw new Error('Não foi possível conectar ao Project Real. Abra o Real e habilite seu MCP em Settings → Connections.'); }
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const result = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: 20_000 });
    if (result.isError) throw new Error(`Project Real recusou a operação ${name}`);
    const text = (result.content as { type: string; text?: string }[]).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
    try { return JSON.parse(text); } catch { return text; }
  }
  async close(): Promise<void> { const client = this.client; this.client = undefined; await client?.close(); }
}

/** The HTTP/WS bridge belongs to the launcher process, so no AI or background terminal is needed. */
export class LocalMcpServer {
  private server?: Server;
  private wss?: { destroy(): void };
  private resources?: { sessions: { destroy(): void }; queue: { destroy(): void } };
  async start(): Promise<void> {
    try {
      const response = await fetch('http://127.0.0.1:28429/health', { signal: AbortSignal.timeout(2000) });
      const health = await response.json() as { status?: string };
      if (response.ok && health.status === 'ok') return;
    } catch { /* Start our own bridge when one is not already healthy. */ }
    const require = createRequire(import.meta.url);
    const bridge = require('roblox-mcp-difz') as { createApp(): { server: Server; wss: NonNullable<LocalMcpServer['wss']> } & NonNullable<LocalMcpServer['resources']> };
    const instance = bridge.createApp();
    const { server, wss } = instance;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(28429, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    this.server = server; this.wss = wss; this.resources = instance;
  }
  async close(): Promise<void> {
    if (!this.server) return;
    this.wss?.destroy();
    this.resources?.queue.destroy(); this.resources?.sessions.destroy();
    const server = this.server; this.server = undefined;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

type ClientList = { clients: { clientId: number }[] };
type WindowList = { windows: { pid: number }[] };
type Identity = { username: string; placeId: string; workerId?: string };
export type AutomationStatus = { enabled: boolean; state: 'starting' | 'ready' | 'connecting' | 'error' | 'stopped'; error: string | null };

export class AutoConnector {
  readonly status: AutomationStatus = { enabled: true, state: 'starting', error: null };
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  private initialized = false;
  private attempts = new Map<string, number>();
  private submitted = new Map<string, number>();
  constructor(private pipeline: Pipeline, private mcp: Pick<McpClient, 'sessions'>, private real: RealConnection,
    private bridge: { start(): Promise<void>; close(): Promise<void> }, private bootstrap: string,
    private log: Logger, private now = Date.now, private intervalMs = 2000, private settleMs = 10_000) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.scan().catch(error => {
      this.status.state = 'error';
      this.status.error = error instanceof Error ? error.message : 'Falha na conexão automática';
      this.log.error('automatic_connection_failed', { error: this.status.error });
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async scan(): Promise<void> {
    await this.bridge.start();
    if (!this.initialized) {
      await this.real.connect();
      await this.real.call('write-file', { folder: 'AutoExec', path: 'multi-execute.lua', content: readFileSync(this.bootstrap, 'utf8') });
      this.initialized = true;
    }
    const rows = this.pipeline.store.all().filter(row => ['launching', 'connected', 'analyzing'].includes(row.status));
    this.status.state = rows.some(row => row.status === 'launching') ? 'connecting' : 'ready';
    this.status.error = null;
    if (!rows.length) return;
    const launching = rows.filter(row => row.status === 'launching');
    if (launching.some(row => row.launching_at === null || this.now() - row.launching_at < this.settleMs)) return;
    let clients = (await this.real.call('list-clients', { probe: false }) as ClientList).clients;
    const windows = (await this.real.call('list-roblox-windows', {}) as WindowList).windows;
    if (launching.length && windows.length < rows.length) return; // Wait for the entire submitted batch before injecting.
    const missing = windows.filter(window => !clients.some(client => client.clientId === window.pid));
    if (launching.length && missing.length) {
      const key = launching.map(row => row.worker_id).sort().join('|');
      const attempts = this.attempts.get(key) ?? 0;
      if (attempts >= 3) throw new Error('O Project Real não conectou todos os clientes Roblox. Verifique a versão e o estado da injeção no Real e tente novamente.');
      this.attempts.set(key, attempts + 1);
      await this.real.call('inject', {});
      clients = (await this.real.call('list-clients', { probe: false }) as ClientList).clients;
    }
    const active = await this.mcp.sessions();
    for (const client of clients) {
      if (this.stopped) return;
      if (!Number.isSafeInteger(client.clientId) || client.clientId <= 0) continue;
      // Once a worker is connected, all subsequent game tools use the worker-specific proxy.
      if (active.some(session => session.pid === String(client.clientId) && rows.some(row => row.worker_id === session.workerId))) continue;
      await this.real.call('set-active-client', { clientId: client.clientId });
      const result = await this.real.call('eval', { expression: 'return {username=game:GetService("Players").LocalPlayer.Name,placeId=tostring(game.PlaceId)}', timeout: 5000 }) as { value: Identity };
      const identity = result.value;
      if (!identity || typeof identity.username !== 'string' || typeof identity.placeId !== 'string') continue;
      const mapped = rows.filter(row => row.place_id === identity.placeId &&
        this.pipeline.registeredUsername(row.account_alias)?.toLowerCase() === identity.username.toLowerCase());
      if (mapped.length !== 1) continue; // Do not run the bootstrap in another account or game.
      const row = mapped[0]!;
      const lastSubmit = this.submitted.get(row.worker_id) ?? 0;
      if (this.now() - lastSubmit < 15_000) continue;
      await this.real.call('execute', { code: `getgenv().MCP_PROCESS_ID = ${client.clientId}\n${readFileSync(this.bootstrap, 'utf8')}`,
        name: `multi-execute-${client.clientId}.luau`, quiet: true, watchMs: 1000 });
      this.submitted.set(row.worker_id, this.now());
      this.log.info('automatic_bootstrap_submitted', { worker_id: row.worker_id, client_id: client.clientId });
    }
    await this.pipeline.tick();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.real.close();
    await this.bridge.close();
    this.status.state = 'stopped';
  }
}

export function writeBootstrap(origin: string, token: string): string {
  const file = resolve('project-real-autoexec.lua');
  writeFileSync(file, makeProjectRealAutoexec(origin, token), { mode: 0o600 });
  return file;
}
