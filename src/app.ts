import express, { type ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pipeline } from './pipeline.js';
import { ConflictError } from './store.js';
import { aliasValue, InputError } from './validation.js';
import type { Logger } from './logger.js';
import type { AgentRunner } from './agent.js';
import type { Account } from './validation.js';
import type { AccountRegistry } from './account-registry.js';
import type { RamClient } from './clients.js';
import type { RobloxBrowserLogin } from './browser-login.js';
import type { SetupReport } from './setup-check.js';
import type { RobloxSettings } from './roblox-settings.js';

export function createApp(pipeline: Pipeline, callbackToken: string, autoexecToken: string,
  findings: string, log: Logger, agent?: AgentRunner, accounts: Account[] = [], accountRegistry?: AccountRegistry,
  localAccounts?: Pick<RamClient, 'accounts' | 'importCookie'>, automation = () => ({ enabled: false, state: 'stopped', error: null as string | null }),
  publicDirectory = resolve('public'), setupCheck?: () => Promise<SetupReport>, robloxSettings?: RobloxSettings,
  browserLogin?: Pick<RobloxBrowserLogin, 'signIn'>) {
  const app = express();
  const activePrompts = new Map<AbortController, Promise<void>>();
  app.disable('x-powered-by');
  app.use(express.static(publicDirectory, { index: 'index.html', fallthrough: true }));
  app.use((req, res, next) => {
    if (!req.path.startsWith('/internal/')) { next(); return; }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const routeToken = req.path.startsWith('/internal/autoexec/') ? autoexecToken : callbackToken;
    const expected = Buffer.from(`Bearer ${routeToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/roblox-settings', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!robloxSettings) { res.status(503).json({ error: 'Configurações indisponíveis nesta execução.' }); return; }
    res.json(await robloxSettings.snapshot());
  });
  app.post('/roblox-settings', async (req, res) => {
    if (!robloxSettings) { res.status(503).json({ error: 'Configurações indisponíveis nesta execução.' }); return; }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { res.status(403).json({ error: 'Invalid origin' }); return; }
    res.json({ preferences: await robloxSettings.save(req.body) });
  });
  app.post('/roblox-settings/apply', async (req, res) => {
    if (!robloxSettings) { res.status(503).json({ error: 'Configurações indisponíveis nesta execução.' }); return; }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { res.status(403).json({ error: 'Invalid origin' }); return; }
    await robloxSettings.apply();
    log.info('roblox_preferences_applied');
    res.json({ applied: true, backup: true });
  });
  app.get('/setup-check', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!setupCheck) { res.status(503).json({ error: 'Verificação de requisitos indisponível nesta execução.' }); return; }
    res.json(await setupCheck());
  });
  app.get('/config', (_req, res) => res.json({
    accounts: accounts.map(account => ({ alias: account.alias, username: account.robloxUsername })),
    agent: { configured: agent?.configured ?? false, model: agent?.model ?? null, provider: agent?.selection?.provider === 'claude' ? 'Claude Code' : 'Codex CLI', selection:agent?.selection, providers:agent?.providers?.() },
  }));
  app.post('/agent-settings', (req,res)=>{
    if (!agent) throw new InputError('Nenhuma CLI configurada');
    let selection;
    try { selection=agent.select(req.body); } catch(error) { throw new InputError(error instanceof Error ? error.message : String(error)); }
    pipeline.store.setAgentSettings(selection);
    res.json({selection});
  });
  app.get('/status', (_req, res) => res.json({ mcp_online: pipeline.online, queue_paused: !pipeline.online, sessions: pipeline.store.all(), automation: automation() }));
  app.get('/events', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let previous = '';
    const send = () => {
      const payload = JSON.stringify({
        mcp_online: pipeline.online,
        queue_paused: !pipeline.online,
        sessions: pipeline.store.all(),
        automation: automation(),
        runs: pipeline.store.prompts(),
      });
      if (payload !== previous) { previous = payload; res.write(`data: ${payload}\n\n`); }
    };
    send();
    const updates = setInterval(send, 750);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.on('close', () => { clearInterval(updates); clearInterval(heartbeat); });
  });
  app.get(['/accounts/local', '/accounts/ram'], async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localAccounts) { res.status(503).json({ error: 'Local account management is unavailable' }); return; }
    try { res.json({ accounts: await localAccounts.accounts() }); }
    catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/accounts/sync', async (req, res) => {
    if (!localAccounts || !accountRegistry) { res.status(503).json({ error: 'Local account management is unavailable' }); return; }
    try {
      const alias = aliasValue(req.body?.alias);
      const remote = await localAccounts.accounts();
      const username = remote.find(value => value.toLowerCase() === String(req.body?.username ?? '').toLowerCase());
      if (!username) throw new InputError('Account is not imported locally');
      const account = accountRegistry.add(alias, username);
      log.info('account_mapped', { alias: account.alias, username });
      res.status(201).json({ account });
    } catch (error) {
      if (error instanceof InputError || error instanceof ConflictError) throw error;
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/accounts/import', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { res.status(403).json({ error: 'Invalid origin' }); return; }
    if (!localAccounts || !accountRegistry) { res.status(503).json({ error: 'Local account management is unavailable' }); return; }
    try {
      const alias = aliasValue(req.body?.alias);
      const before = await localAccounts.accounts();
      await localAccounts.importCookie(req.body?.cookie);
      const after = await localAccounts.accounts();
      const previous = new Set(before.map(value => value.toLowerCase()));
      const added = after.filter(value => !previous.has(value.toLowerCase()));
      const configured = accounts.find(account => account.alias.toLowerCase() === alias.toLowerCase());
      const username = added.length === 1 ? added[0] : configured && after.find(value => value.toLowerCase() === configured.robloxUsername.toLowerCase());
      if (!username) throw new ConflictError('Session saved, but a unique new account was not detected; use Sync existing account');
      const account = accountRegistry.add(alias, username);
      log.info('account_imported', { alias: account.alias, username });
      res.status(201).json({ account });
    } catch (error) {
      if (error instanceof InputError || error instanceof ConflictError) throw error;
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/accounts/browser-login', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) { res.status(403).json({ error: 'Invalid origin' }); return; }
    if (!localAccounts || !accountRegistry || !browserLogin) { res.status(503).json({ error: 'Browser sign-in is unavailable' }); return; }
    try {
      const alias = aliasValue(req.body?.alias);
      const configured = accounts.find(account => account.alias.toLowerCase() === alias.toLowerCase());
      if (!configured) throw new InputError('Account alias is not configured');
      const before = await localAccounts.accounts();
      const cookie = await browserLogin.signIn(configured.robloxUsername);
      await localAccounts.importCookie(cookie);
      const after = await localAccounts.accounts();
      const previous = new Set(before.map(value => value.toLowerCase()));
      const added = after.filter(value => !previous.has(value.toLowerCase()));
      const username = added.length === 1 ? added[0] : configured && after.find(value => value.toLowerCase() === configured.robloxUsername.toLowerCase());
      if (!username) throw new ConflictError('The signed-in account could not be mapped uniquely; use Sync existing account');
      const account = accountRegistry.add(alias, username);
      log.info('account_browser_login', { alias: account.alias, username });
      res.status(201).json({ account });
    } catch (error) {
      if (error instanceof InputError || error instanceof ConflictError) throw error;
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/prompts', (_req, res) => res.json({ runs: pipeline.store.prompts() }));
  app.get('/agent-policy', (_req, res) => res.json({ policy: pipeline.store.agentPolicy() ?? null }));
  app.post('/agent-policy', (req, res) => {
    const filename = req.body?.filename;
    const content = req.body?.content;
    if (typeof filename !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\.md$/i.test(filename)) throw new InputError('filename must be a Markdown file');
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > 64 * 1024) throw new InputError('AGENTS.md must contain 1–65536 UTF-8 bytes');
    const policy = pipeline.store.setAgentPolicy(filename, content);
    log.info('agent_policy_updated', { filename, bytes: Buffer.byteLength(content, 'utf8') });
    res.json({ policy });
  });
  app.post('/prompts', (req, res) => {
    if (!agent?.configured) throw new InputError('Install and authenticate the configured agent CLI to use the prompt console');
    if (!pipeline.online) throw new ConflictError('Roblox connection is unavailable');
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) throw new InputError('prompt must contain 1–8000 characters');
    const available = pipeline.store.all().filter(row => ['connected', 'analyzing'].includes(row.status));
    const targets = req.body?.scope === 'all' ? available : req.body?.scope === 'group'
      ? available.filter(row => row.group_id === req.body?.group_id)
      : available.filter(row => row.id === req.body?.session_id);
    if (!targets.length) throw new ConflictError('No connected target session');
    const busy = new Set(pipeline.store.prompts().filter(run => ['queued', 'running'].includes(run.status)).map(run => run.worker_id));
    if (targets.some(session => busy.has(session.worker_id))) throw new ConflictError('One or more target terminals are already running a prompt');
    const selection=agent.selection ?? {provider:'codex' as const,model:agent.model};
    const runs = targets.map(session => pipeline.store.createPrompt(session, prompt.trim(),selection));
    for (const run of runs) {
      const controller = new AbortController();
      const task = (async () => {
      const connectionCheck = setInterval(() => {
        const session = pipeline.store.get(run.session_id);
        if (!pipeline.online || !session || !['connected', 'analyzing'].includes(session.status)) controller.abort();
      }, 500);
      connectionCheck.unref();
      pipeline.store.updatePrompt(run.id, 'running');
      try {
        const threadKey=`${run.worker_id}:${selection.provider}:${selection.model}`;
        const output = await agent.run(run.worker_id, run.prompt, pipeline.store.agentPolicy()?.content ?? '', transcript => {
          pipeline.store.updatePrompt(run.id, 'running', transcript);
        }, pipeline.store.agentThread(threadKey), threadId => pipeline.store.setAgentThread(threadKey, threadId), controller.signal,selection);
        pipeline.store.updatePrompt(run.id, 'done', output);
      } catch (error) {
        pipeline.store.updatePrompt(run.id, 'failed', null, error instanceof Error ? error.message : String(error));
      } finally { clearInterval(connectionCheck); }
      })();
      activePrompts.set(controller, task);
      void task.finally(() => activePrompts.delete(controller));
    }
    res.status(202).json({ runs });
  });
  app.post('/launch', (req, res) => {
    const result = pipeline.launch(req.body?.links, req.body?.alias);
    res.status(result.every(row => row.reused) ? 200 : 202).json({ sessions: result });
  });
  app.post('/launch-batch', (req, res) => {
    res.status(202).json({ sessions: pipeline.launchBatch(req.body?.links, req.body?.alias) });
  });
  app.post('/launch-group', (req, res) => {
    const result = pipeline.launchGroup(req.body?.link, req.body?.aliases);
    res.status(result.every(row => row.reused) ? 200 : 202).json({ sessions: result });
  });
  app.post('/attach', (req, res) => {
    res.status(202).json({ session: pipeline.attach(req.body?.link, req.body?.alias) });
  });
  app.post('/sessions/:id/retry', (req, res) => {
    if (!pipeline.store.get(req.params.id)) { res.status(404).json({ error: 'Unknown session' }); return; }
    res.status(202).json({ session: pipeline.retry(req.params.id) });
  });
  app.post('/internal/autoexec/register', (req, res) => {
    const session = pipeline.registerAutoexec(req.body?.username, req.body?.place_id);
    res.json({ session_id: session.id, worker_id: session.worker_id, loader_url: 'http://127.0.0.1:28429/mcp.lua' });
  });
  app.post('/internal/mcp/:workerId', async (req, res) => {
    if (!agent) { res.status(503).json({ error: 'Agent CLI is unavailable' }); return; }
    const session = pipeline.store.all().find(row => row.worker_id === req.params.workerId);
    if (!pipeline.online || !session || !['connected', 'analyzing'].includes(session.status)) { res.status(409).json({ error: 'Worker is not connected' }); return; }
    const response = await agent.mcpRpc(session.worker_id, req.body);
    if (response === undefined) { res.status(204).end(); return; }
    res.json(response);
  });
  for (const status of ['analyzing', 'done', 'failed'] as const) {
    app.post(`/internal/sessions/:id/${status}`, (req, res) => {
      const row = pipeline.store.get(req.params.id);
      if (!row) { res.status(404).json({ error: 'Unknown session' }); return; }
      if (!req.body || req.body.worker_id !== row.worker_id) throw new ConflictError('Stale or missing worker_id');
      if (status === 'failed' && (typeof req.body.error !== 'string' || !req.body.error.trim() || req.body.error.length > 4000)) throw new InputError('failed requires an error string (1–4000 characters)');
      // Identical callbacks are idempotent; stale callbacks after retry are rejected above.
      if (row.status === status) { res.json({ session: row, reused: true }); return; }
      if (status === 'failed' && !['connected', 'analyzing'].includes(row.status)) throw new ConflictError('Worker must be connected before reporting failure');
      if (status === 'done' && req.body.findings !== undefined) {
        if (row.status !== 'analyzing') throw new ConflictError('Must be analyzing before done');
        mkdirSync(findings, { recursive: true });
        // Generated UUIDs are the only path components; aliases and links never become paths.
        writeFileSync(join(findings, `${row.id}-${row.retry_count}.json`), JSON.stringify({ session_id: row.id, worker_id: row.worker_id, findings: req.body.findings }, null, 2), { mode: 0o600 });
      }
      const session = pipeline.store.transition(row.id, status, status === 'failed' ? req.body.error as string : null);
      log.info('worker_callback', { id: row.id, worker_id: row.worker_id, from: row.status, to: status });
      res.json({ session });
    });
  }
  app.use((_req, res) => { res.status(404).json({ error: 'Unknown endpoint' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const code = error instanceof InputError || error instanceof SyntaxError ? 400 : error instanceof ConflictError ? 409 :
      error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 500;
    if (code === 500) log.error('request_error', { error: String(error) });
    res.status(code).json({ error: code === 500 ? 'Internal server error' : error instanceof Error ? error.message : String(error) });
  };
  app.use(errors);
  return Object.assign(app, {
    async shutdown(): Promise<void> {
      for (const controller of activePrompts.keys()) controller.abort();
      await Promise.allSettled(activePrompts.values());
    },
  });
}
