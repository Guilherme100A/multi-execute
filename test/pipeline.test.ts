import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ConflictError } from '../src/store.js';
import { Pipeline } from '../src/pipeline.js';
import { placeId, parseAccounts } from '../src/validation.js';
import { HttpClient, McpClient, RamClient, type McpSession } from '../src/clients.js';
import { createApp } from '../src/app.js';
import { RotatingLogger } from '../src/logger.js';
import { makeLoader } from '../src/loader.js';
import { makeProjectRealAutoexec } from '../src/project-real.js';
import { runBatch } from '../src/batch.js';
import { loadConfig } from '../src/config.js';
import { AgentRunner } from '../src/agent.js';
import { AccountRegistry } from '../src/account-registry.js';

const log = { info() {}, error() {} };
const accounts = [
  { alias: 'alpha', ramAccount: 'RAM Alpha', robloxUsername: 'AlphaUser' },
  { alias: 'beta', ramAccount: 'RAM Beta', robloxUsername: 'BetaUser' },
];
const token = 'test-secret-abcdefghijklmnopqrstuvwxyz';
const callbackToken = 'callback-secret-abcdefghijklmnopqrstuvwxyz';
const autoexecToken = 'autoexec-secret-abcdefghijklmnopqrstuvwxyz';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(now = Date.now, store = new Store(':memory:', now), injectionMode: 'project-real-autoexec' | 'mcp-execute' = 'mcp-execute', batched = false) {
  let available = true;
  let sessions: McpSession[] = [];
  let processes: { instanceId: string }[] = [];
  const launches: string[][] = [], executions: string[][] = [], toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const batches: { username: string; placeId: string }[][] = [];
  const mcp = {
    async health() { if (!available) throw new Error('offline'); },
    async sessions() { return sessions; },
    async processes() { return processes; },
    async execute(id: string, script: string) { executions.push([id, script]); },
    async callTool(name: string, args: Record<string, unknown>) { toolCalls.push({ name, args }); return { success: true }; },
  };
  const pipeline = new Pipeline(store, { async launch(account, place) { launches.push([account, place]); },
    ...(batched ? { async launchBatch(games: { username: string; placeId: string }[]) { batches.push(games); } } : {}),
  }, mcp, accounts, new Set(['123456', '654321']), log, now, 30_000, 60_000, injectionMode);
  return { store, pipeline, launches, batches, executions, toolCalls, mcp,
    offline(value: boolean) { available = !value; },
    live(rows: McpSession[]) { sessions = rows; processes = rows.map(row => ({ instanceId: row.instanceId })); },
    processes(rows: { instanceId: string }[]) { processes = rows; },
  };
}
const remote = (instanceId = 'boot-1:pid-50:start-100'): McpSession => ({ id: 'remote-session', instanceId, accountAlias: 'alpha', placeId: '123456' });

test('PlaceId accepts only 6–15 digits or exact Roblox game URLs', () => {
  for (const input of ['123456', '123456789012345', ' https://www.roblox.com/games/123456/Example?x=1 ', 'https://roblox.com/games/123456']) assert.equal(placeId(input), input.includes('123456789') ? '123456789012345' : '123456');
  for (const input of ['12345', '1234567890123456', '1e6', 'https://www.roblox.com/users/123456/profile', 'https://www.roblox.com/groups/123456', 'https://www.roblox.com/catalog/123456', 'https://roblox.com.evil.test/games/123456', 'https://evil.test/games/123456', 'https://roblox.com@games.test/games/123456', 'https://roblox.com/games/123456/slug/extra', 123456, 'javascript:123456', 'https://user@roblox.com/games/123456']) assert.throws(() => placeId(input));
});

test('account configuration rejects duplicate aliases and missing RAM mappings', () => {
  assert.deepEqual(parseAccounts(accounts), accounts);
  assert.throws(() => parseAccounts([accounts[0], accounts[0]]));
  assert.throws(() => parseAccounts([{ alias: '../x', ramAccount: 'foo', robloxUsername: 'ValidUser' }]));
  assert.throws(() => parseAccounts([{ alias: 'foo' }]));
});

test('store enforces transitions, active idempotency, worker uniqueness, and one retry', () => {
  const store = new Store(':memory:', () => 1000);
  try {
    const first = store.create('123456', '123456', 'alpha').session;
    assert.equal(store.create('different URL', '123456', 'alpha').session.id, first.id);
    assert.throws(() => store.transition(first.id, 'done'), ConflictError);
    store.transition(first.id, 'launching');
    assert.equal(store.create('123456', '123456', 'alpha').reused, true);
    store.transition(first.id, 'connected', null, 'instance');
    store.transition(first.id, 'analyzing');
    assert.equal(store.create('123456', '123456', 'alpha').reused, true);
    store.transition(first.id, 'disconnected', 'gone');
    assert.equal(store.claim(first, 'instance'), true);
    assert.equal(store.claim(first, 'instance'), false);
    const retried = store.retry(first.id);
    assert.notEqual(retried.worker_id, first.worker_id);
    assert.match(retried.worker_id, /^alpha-1000-/);
    assert.equal(retried.retry_count, 1);
    assert.equal(retried.instance_id, null);
    assert.equal(store.claimed('instance'), true);
    store.transition(first.id, 'failed');
    assert.throws(() => store.retry(first.id), ConflictError);
    assert.notEqual(store.create('123456', '123456', 'alpha').session.worker_id, first.worker_id);
  } finally { store.close(); }
});

test('retry cannot collide with another active session', () => {
  const store = new Store(':memory:');
  try {
    const first = store.create('123456', '123456', 'alpha').session;
    store.transition(first.id, 'failed');
    store.create('123456', '123456', 'alpha');
    assert.throws(() => store.retry(first.id), ConflictError);
    assert.equal(store.get(first.id)!.retry_count, 0);
  } finally { store.close(); }
});

test('SQLite retains sessions, baselines, execute claims and CLI threads after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-persistence-'));
  try {
    const path = join(dir, 'sessions.sqlite');
    const first = new Store(path);
    const row = first.create('123456', '123456', 'alpha').session;
    first.transition(row.id, 'launching'); first.baseline(row.id, ['old-instance']); first.claim(row, 'new-instance');
    first.setAgentThread(row.worker_id, 'thread-123'); first.close();
    const reopened = new Store(path);
    assert.equal(reopened.get(row.id)!.status, 'launching');
    assert.equal(reopened.isBaseline(row.id, 'old-instance'), true);
    assert.equal(reopened.claim(row, 'new-instance'), false);
    assert.equal(reopened.agentThread(row.worker_id), 'thread-123');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('batch validation is atomic and only authorized configured games are accepted', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.pipeline.launch(['123456', '999999'], 'alpha'));
    assert.throws(() => f.pipeline.launch(['123456'], 'unknown'));
    assert.equal(f.store.all().length, 0);
    const rows = f.pipeline.launch(['123456', 'https://roblox.com/games/123456/Hello'], 'alpha');
    assert.equal(rows[0]!.session.id, rows[1]!.session.id);
    assert.equal(f.store.all().length, 1);
    assert.equal(f.launches.length, 0);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('one authorized game can be queued for several distinct accounts', async () => {
  const f = fixture();
  try {
    const rows = f.pipeline.launchGroup('https://www.roblox.com/games/123456/Test', ['alpha', 'beta']);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.session.account_alias, row.session.place_id]), [['alpha', '123456'], ['beta', '123456']]);
    assert.equal(new Set(rows.map(row => row.session.worker_id)).size, 2);
    assert.throws(() => f.pipeline.launchGroup('123456', ['alpha', 'alpha']), /distint/i);
    assert.throws(() => f.pipeline.launchGroup('654321', ['alpha', 'unknown']), /Unknown account/);
    assert.equal(f.store.all().length, 2);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('restart fails uncertain connected claims and revoked sessions without executing again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-recovery-'));
  const path = join(dir, 'db.sqlite');
  try {
    const first = new Store(path);
    const uncertain = first.create('123456', '123456', 'alpha').session;
    first.transition(uncertain.id, 'launching'); first.transition(uncertain.id, 'connected', null, 'claimed'); first.claim(uncertain, 'claimed');
    const revoked = first.create('999999', '999999', 'beta').session;
    first.transition(revoked.id, 'launching'); first.close();
    const reopened = new Store(path);
    const f = fixture(Date.now, reopened);
    try {
      assert.equal(reopened.get(uncertain.id)!.status, 'failed');
      assert.match(reopened.get(uncertain.id)!.last_error!, /restarted/);
      assert.equal(reopened.get(revoked.id)!.status, 'failed');
      assert.throws(() => f.pipeline.retry(revoked.id), /authorized/);
      f.live([remote('claimed')]); await f.pipeline.tick();
      assert.equal(f.executions.length, 0);
      assert.equal(f.launches.length, 0);
    } finally { await f.pipeline.stop(); reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP outage pauses queue, recovery launches once, account stays isolated', async () => {
  const f = fixture();
  try {
    f.offline(true);
    f.pipeline.launch(['123456', '654321'], 'alpha');
    f.pipeline.launch(['123456'], 'beta');
    await f.pipeline.tick(); await flush();
    assert.equal(f.launches.length, 0);
    assert.equal(f.pipeline.online, false);
    f.offline(false); await f.pipeline.tick(); await flush();
    assert.deepEqual(f.launches, [['RAM Alpha', '123456'], ['RAM Beta', '123456']]);
    assert.equal(f.store.all().filter(row => row.status === 'pending').length, 1);
    await f.pipeline.tick(); await flush();
    assert.equal(f.launches.length, 2);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('monitor matches alias/place/process and executes at most once', async () => {
  const f = fixture();
  try {
    const row = f.pipeline.launch(['123456'], 'alpha')[0]!.session;
    await f.pipeline.tick(); await flush();
    f.live([{ ...remote(), accountAlias: 'beta' }]); await f.pipeline.tick();
    assert.equal(f.executions.length, 0);
    f.live([remote()]); f.processes([]); await f.pipeline.tick();
    assert.equal(f.executions.length, 0);
    f.live([remote()]); await f.pipeline.tick(); await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'connected');
    assert.equal(f.executions.length, 1);
    f.store.transition(row.id, 'analyzing'); f.live([]); await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'disconnected');
    f.pipeline.retry(row.id); await flush();
    f.live([remote()]); await f.pipeline.tick();
    assert.equal(f.executions.length, 1);
    assert.equal(f.store.get(row.id)!.status, 'launching');
    f.live([remote('fresh-instance')]); await f.pipeline.tick();
    assert.equal(f.executions.length, 2);
    assert.equal(f.store.get(row.id)!.status, 'connected');
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('Project Real mode connects only after Auto-Execute registers the exact worker and never calls MCP execute', async () => {
  const f = fixture(Date.now, new Store(':memory:'), 'project-real-autoexec');
  try {
    const row = f.pipeline.launch(['123456'], 'alpha')[0]!.session;
    await f.pipeline.tick(); await flush();
    assert.equal(f.store.get(row.id)!.status, 'launching');
    assert.equal(f.pipeline.registerAutoexec('AlphaUser', '123456').worker_id, row.worker_id);
    f.live([{ id: 'real-mcp-session', instanceId: 'real-client-1', workerId: 'wrong-worker' }]);
    await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'launching');
    f.live([{ id: 'real-mcp-session', instanceId: 'real-client-1', workerId: row.worker_id }]);
    await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'connected');
    assert.equal(f.executions.length, 0);
    assert.deepEqual(f.toolCalls, [{ name: 'set-autoexecute', args: { workerId: row.worker_id, enabled: true } }]);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('same Roblox worker reconnects without reopening the game, but historical workers stay closed', async () => {
  const f=fixture(Date.now,new Store(':memory:'),'project-real-autoexec');
  try {
    const row=f.pipeline.launch(['123456'],'alpha')[0]!.session;
    await f.pipeline.tick(); await flush();
    const connected={...remote(),workerId:row.worker_id};
    f.live([connected]); await f.pipeline.tick();
    f.live([]); await f.pipeline.tick(); assert.equal(f.store.get(row.id)!.status,'disconnected');
    f.live([connected]); await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status,'connected'); assert.equal(f.store.get(row.id)!.finished_at,null);
    assert.equal(f.launches.length,1); assert.equal(f.toolCalls.length,1);
    f.live([]); await f.pipeline.tick();
    f.pipeline.launch(['654321'],'alpha'); await flush();
    f.live([connected]); await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status,'disconnected');
  } finally {await f.pipeline.stop(); f.store.close();}
});

test('existing and ambiguous instances never receive a loader', async () => {
  const f = fixture();
  try {
    f.live([remote('old')]);
    f.pipeline.launch(['123456'], 'alpha'); await f.pipeline.tick(); await flush();
    await f.pipeline.tick(); assert.equal(f.executions.length, 0);
    f.live([remote('fresh-a'), remote('fresh-b')]);
    await f.pipeline.tick(); assert.equal(f.executions.length, 0);
    f.live([{ ...remote('fresh'), workerId: 'stale-worker' }]);
    await f.pipeline.tick(); assert.equal(f.executions.length, 0);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('launching expires beyond 60 seconds even with MCP offline', async () => {
  let now = 1000;
  const f = fixture(() => now);
  try {
    const row = f.pipeline.launch(['123456'], 'alpha')[0]!.session;
    await f.pipeline.tick(); await flush();
    f.offline(true); now += 60_000; await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'launching');
    now += 1; await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'failed');
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('uncertain execute failure is persisted and never retried on the same instance', async () => {
  const f = fixture();
  let calls = 0;
  f.mcp.execute = async () => { calls++; throw new Error('connection reset after send'); };
  try {
    const row = f.pipeline.launch(['123456'], 'alpha')[0]!.session;
    await f.pipeline.tick(); await flush(); f.live([remote()]); await f.pipeline.tick();
    assert.equal(f.store.get(row.id)!.status, 'failed');
    f.pipeline.retry(row.id); await flush(); await f.pipeline.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.claimed(remote().instanceId), true);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('RAM uses encoded query, 10s deadline, 3 total attempts and bounded backoff', async () => {
  const urls: string[] = [], waits: number[] = [], deadlines: AbortSignal[] = [];
  let calls = 0;
  const fake: typeof fetch = async (input, options) => {
    urls.push(String(input)); deadlines.push(options!.signal!);
    assert.equal(options!.method, 'GET');
    calls++; return calls < 3 ? new Response('error', { status: 503 }) : Response.json({ Success: true, Message: 'Launched' });
  };
  const ram = new RamClient(new HttpClient('http://127.0.0.1:7963', '', fake), 'ram password', async (ms: number) => { waits.push(ms); });
  await ram.launch('Account & ? name', '123456');
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 4000]);
  const url = new URL(urls[0]!);
  assert.equal(url.searchParams.get('Account'), 'Account & ? name');
  assert.equal(url.searchParams.get('PlaceId'), '123456');
  assert.equal(url.searchParams.get('Password'), 'ram password');
  assert.equal(url.pathname, '/v2/LaunchAccount');
  assert.equal(deadlines.length, 3);
  assert.ok(deadlines.every(signal => signal instanceof AbortSignal));
  let failedCalls = 0;
  const fail = new RamClient(new HttpClient('http://localhost', '', async () => { failedCalls++; throw new Error('timeout'); }), '', async () => {});
  await assert.rejects(() => fail.launch('test', '123456'), /timeout/); assert.equal(failedCalls, 3);
});

test('RAM rejects HTTP success without a confirmed LaunchAccount result', async () => {
  for (const body of ['', 'OK', '<html>Login required</html>', '{}', '{"Success":false,"Message":"Disabled"}', '{"Success":true}']) {
    const ram = new RamClient(new HttpClient('http://127.0.0.1:7963', '', async () => new Response(body)), '', async () => {}, 1);
    await assert.rejects(() => ram.launch('AlphaUser', '123456'), /RAM LaunchAccount/);
  }
});

test('Project Real connects when process observation is unavailable', async () => {
  const f = fixture(Date.now, new Store(':memory:'), 'project-real-autoexec');
  try {
    f.pipeline.launch(['123456'], 'alpha');
    await f.pipeline.tick(); await flush();
    const row = f.store.all()[0]!;
    assert.equal(row.status, 'launching');
    f.live([{ id: row.worker_id, workerId: row.worker_id, instanceId: 'worker:' + row.worker_id }]);
    f.mcp.processes = async () => { throw new Error('Process observation unavailable'); };
    await f.pipeline.tick();
    assert.equal(f.pipeline.online, true);
    assert.equal(f.store.get(row.id)!.status, 'connected');
    assert.equal(f.toolCalls.length, 1);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('attach validates an existing game and binds its bootstrap without launching another client', async () => {
  const f = fixture(Date.now, new Store(':memory:'), 'project-real-autoexec');
  try {
    assert.throws(() => f.pipeline.attach('999999', 'alpha'), /AUTHORIZED_PLACE_IDS/);
    assert.throws(() => f.pipeline.attach('123456', 'missing'), /Unknown account/);
    assert.equal(f.store.all().length, 0);
    const row = f.pipeline.attach('123456', 'alpha');
    assert.equal(row.status, 'launching');
    assert.throws(() => f.pipeline.attach('654321', 'alpha'), /active session/);
    assert.equal(f.pipeline.registerAutoexec('AlphaUser', '123456').worker_id, row.worker_id);
    assert.throws(() => f.pipeline.registerAutoexec('AlphaUser', '654321'));
    f.live([{ id: row.worker_id, workerId: row.worker_id, instanceId: 'worker:' + row.worker_id }]);
    await f.pipeline.tick(); await flush();
    assert.equal(f.store.get(row.id)!.status, 'connected');
    assert.equal(f.launches.length, 0);
    assert.equal(f.executions.length, 0);
    assert.equal(f.toolCalls.length, 1);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('browser batch validates every game before distributing links across accounts', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.pipeline.launchBatch(['123456', '999999'], 'alpha'), /AUTHORIZED_PLACE_IDS/);
    assert.equal(f.store.all().length, 0);
    const result = f.pipeline.launchBatch(['123456', '654321'], 'beta');
    assert.deepEqual(result.map(row => [row.session.account_alias, row.session.place_id]), [['beta', '123456'], ['alpha', '654321']]);
    assert.equal(f.launches.length, 0);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('a browser batch reaches the native launcher together rather than as staggered logins', async () => {
  const f = fixture(Date.now, new Store(':memory:'), 'project-real-autoexec', true);
  try {
    await f.pipeline.tick(); await flush();
    f.pipeline.launchBatch(['123456', '654321'], 'alpha');
    await flush();
    assert.deepEqual(f.batches, [[{ username: 'RAM Alpha', placeId: '123456' }, { username: 'RAM Beta', placeId: '654321' }]]);
    assert.equal(f.launches.length, 0);
    assert.deepEqual(f.store.all().map(row => row.status), ['launching', 'launching']);
  } finally { await f.pipeline.stop(); f.store.close(); }
});

test('RAM lists accounts and imports a cookie once without exposing it in errors', async () => {
  const urls: URL[] = [];
  const ram = new RamClient(new HttpClient('http://127.0.0.1:7963', '', async input => {
    const url = new URL(String(input)); urls.push(url);
    if (url.pathname === '/v2/GetAccounts') return Response.json({ Success: true, Message: 'AlphaUser,BetaUser' });
    return Response.json({ Success: true, Message: 'Cookie successfully imported' });
  }), 'ram-password');
  assert.deepEqual(await ram.accounts(), ['AlphaUser', 'BetaUser']);
  const cookie = 'sensitive-cookie-value-1234567890';
  await ram.importCookie(cookie);
  assert.equal(urls[1]!.pathname, '/v2/ImportCookie');
  assert.equal(urls[1]!.searchParams.get('Cookie'), cookie);
  assert.equal(urls[1]!.searchParams.get('Password'), 'ram-password');
  await assert.rejects(() => ram.importCookie('short'), /Invalid Roblox security cookie/);
  assert.equal(urls.length, 2);
});

test('MCP validates real camelCase contracts and forwards tool execution', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const mcp = new McpClient(new HttpClient('http://127.0.0.1:28429', 'upstream-secret', async (input, init) => {
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer upstream-secret');
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(init.body as string) : null });
    return Response.json(path === '/api/sessions' ? { activeCount: 1, sessions: [{ workerId: 's', pid: 42, status: 'active' }] } : path === '/api/processes' ? { processes: [{ pid: 42, workerId: 's' }] } : { result: { content: [{ type: 'text', text: 'ok' }] } });
  }));
  await mcp.health(); assert.equal((await mcp.sessions())[0]!.instanceId, 'pid:42');
  assert.deepEqual(await mcp.processes(), [{ instanceId: 'pid:42', workerId: 's' }]); await mcp.execute('s', 'script');
  assert.deepEqual(requests.at(-1), { path: '/api/tools/execute', body: { name: 'execute-script', arguments: { workerId: 's', code: 'script', async: false } } });
  const broken = new McpClient(new HttpClient('http://localhost', '', async () => Response.json({ sessions: [{ status: 'active' }] })));
  await assert.rejects(() => broken.sessions(), /workerId/);
});

test('HTTP endpoints authenticate, reject stale callbacks, save findings and enforce lifecycle', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-http-'));
  const server = createApp(f.pipeline, token, callbackToken, autoexecToken, dir, log).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  const base = `http://127.0.0.1:${addr.port}`;
  const call = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const callback = (path: string, body: unknown, bearer = callbackToken) => fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const autoexec = (body: unknown, bearer = autoexecToken) => fetch(base + '/internal/autoexec/register', { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const ui = await fetch(base + '/');
    assert.equal(ui.status, 200); assert.match(await ui.text(), /Multi · Workspace/);
    assert.equal((await fetch(base + '/status')).status, 401);
    assert.equal((await call('/launch', { links: ['123456'], alias: 'alpha' })).status, 202);
    assert.equal((await call('/launch', { links: ['123456'], alias: 'alpha' })).status, 200);
    assert.equal((await call('/launch', { links: ['bad'], alias: 'alpha' })).status, 400);
    assert.equal((await call('/status')).status, 200);
    const events = await call('/events');
    assert.match(events.headers.get('content-type') ?? '', /^text\/event-stream/);
    const eventReader = events.body!.getReader();
    const firstEvent = await eventReader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /"sessions":\[/);
    await eventReader.cancel();
    const row = f.store.all()[0]!;
    const body = { worker_id: row.worker_id };
    const prefix = `/internal/sessions/${row.id}`;
    assert.equal((await autoexec({ username: 'AlphaUser', place_id: '123456' }, token)).status, 401);
    assert.equal((await autoexec({ username: 'AlphaUser', place_id: '123456' })).status, 409);
    assert.equal((await callback(prefix + '/done', body, token)).status, 401);
    assert.equal((await callback(prefix + '/done', body)).status, 409);
    f.store.transition(row.id, 'launching'); f.store.transition(row.id, 'connected', null, 'instance');
    const registration = await autoexec({ username: 'AlphaUser', place_id: '123456' });
    assert.equal(registration.status, 200);
    assert.equal((await registration.json() as { worker_id: string }).worker_id, row.worker_id);
    assert.equal((await callback(prefix + '/analyzing', { worker_id: 'stale' })).status, 409);
    assert.equal((await callback(prefix + '/analyzing', body)).status, 200);
    assert.equal((await callback(prefix + '/analyzing', body)).status, 200);
    assert.equal((await callback(prefix + '/done', { ...body, findings: { observations: ['authorized test'] } })).status, 200);
    assert.equal((await callback(prefix + '/done', body)).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${row.id}-0.json`), 'utf8')).findings, { observations: ['authorized test'] });
    assert.equal((await call(`/sessions/${row.id}/retry`, {})).status, 409);
    const second = f.store.create('654321', '654321', 'alpha').session;
    f.store.transition(second.id, 'failed', 'RAM failed');
    assert.equal((await call(`/sessions/${second.id}/retry`, {})).status, 202);
    assert.equal((await callback(`/internal/sessions/${second.id}/analyzing`, { worker_id: second.worker_id })).status, 409);
    assert.equal((await call('/sessions/missing/retry', {})).status, 404);
    const malformed = await fetch(base + '/launch', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
  } finally {
    await f.pipeline.stop(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    f.store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt console persists one isolated run per connected worker', async () => {
  const f = fixture(Date.now, new Store(':memory:'), 'project-real-autoexec');
  f.pipeline.online = true;
  const seen: string[] = [];
  const fakeAgent = {
    configured: true, model: 'test-model',
    async run(workerId: string, prompt: string, shared: string) { seen.push(`${workerId}:${prompt}:${shared}`); return `ok:${workerId}`; },
  } as unknown as AgentRunner;
  const one = f.store.create('123456', '123456', 'alpha').session;
  const two = f.store.create('123456', '123456', 'beta').session;
  f.store.setAgentPolicy('AGENTS.md', '# Shared policy');
  for (const row of [one, two]) { f.store.transition(row.id, 'launching'); f.store.transition(row.id, 'connected', null, `worker:${row.worker_id}`); }
  const server = createApp(f.pipeline, token, callbackToken, autoexecToken, 'findings', log, fakeAgent, accounts).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/prompts`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'liste remotes', scope: 'all' }),
    });
    assert.equal(response.status, 202);
    await flush(); await flush();
    assert.equal(f.store.prompts().length, 2);
    assert.ok(f.store.prompts().every(run => run.status === 'done' && run.response === `ok:${run.worker_id}`));
    assert.equal(seen.length, 2);
    assert.ok(seen.every(value => value.endsWith(':# Shared policy')));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.pipeline.stop(); f.store.close();
  }
});

test('disconnect stops the active analysis and offline sessions cannot receive prompts', async () => {
  const f=fixture(Date.now,new Store(':memory:'),'project-real-autoexec');
  f.pipeline.online=true;
  const row=f.store.create('123456','123456','alpha').session;
  f.store.transition(row.id,'launching'); f.store.transition(row.id,'connected',null,'instance');
  let aborted=false;
  const fakeAgent={configured:true,model:'test',run(_worker: string,_prompt: string,_policy: string,_progress: unknown,_thread: unknown,_started: unknown,signal: AbortSignal) {
    return new Promise<string>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Jogo desconectado'));},{once:true}));
  }} as unknown as AgentRunner;
  const server=createApp(f.pipeline,token,callbackToken,autoexecToken,'findings',log,fakeAgent,accounts).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const addr=server.address(); assert.ok(addr && typeof addr==='object');
  const send=()=>fetch(`http://127.0.0.1:${addr.port}/prompts`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({prompt:'observe',scope:'all'})});
  try {
    assert.equal((await send()).status,202);
    f.store.transition(row.id,'disconnected','gone');
    await new Promise(resolve=>setTimeout(resolve,650));
    assert.equal(aborted,true); assert.equal(f.store.prompts()[0]!.status,'failed');
    assert.match(f.store.prompts()[0]!.error!,/desconectado/);
    f.pipeline.online=false; assert.equal((await send()).status,409);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); await f.pipeline.stop(); f.store.close(); }
});

test('CLI MCP proxy hides worker selection and enforces the assigned worker', async () => {
  let invocation: { name: string; arguments: Record<string, unknown> } | undefined;
  const mcp = {
    async tools() { return [{ name: 'list-remotes', description: 'List', inputSchema: {
      type: 'object', properties: { workerId: { type: 'string' }, path: { type: 'string' } }, required: ['workerId'],
    } }]; },
    async callTool(name: string, args: Record<string, unknown>) { invocation = { name, arguments: args }; return { ok: true }; },
  };
  const runner = new AgentRunner(process.platform === 'win32' ? 'node.exe' : 'node', 'test-model', 'http://127.0.0.1:3000', callbackToken, mcp as never);
  assert.equal(runner.configured, true);
  const listed = await runner.mcpRpc('worker-real', { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ inputSchema: { properties: Record<string, unknown>; required: string[] } }> } };
  assert.equal(listed.result.tools[0]!.inputSchema.properties.workerId, undefined);
  assert.deepEqual(listed.result.tools[0]!.inputSchema.required, []);
  await runner.mcpRpc('worker-real', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'list-remotes', arguments: { workerId: 'worker-evil', path: 'ReplicatedStorage' },
  } });
  assert.deepEqual(invocation, { name: 'list-remotes', arguments: { workerId: 'worker-real', path: 'ReplicatedStorage' } });
});

test('account management imports into RAM and persists only the username mapping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-accounts-'));
  const file = join(dir, 'accounts.json');
  const managed = [{ ...accounts[0]! }];
  writeFileSync(file, JSON.stringify(managed));
  const registry = new AccountRegistry(file, managed);
  let remote = ['AlphaUser']; let receivedCookie = '';
  const ram = {
    async accounts() { return [...remote]; },
    async importCookie(cookie: string) { receivedCookie = cookie; remote = [...remote, 'NewUser']; },
  };
  const f = fixture();
  const server = createApp(f.pipeline, token, callbackToken, autoexecToken, dir, log, undefined, managed, registry, ram).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  const cookie = 'temporary-cookie-value-1234567890';
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/accounts/import`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ alias: 'new-account', cookie }),
    });
    assert.equal(response.status, 201); assert.equal(receivedCookie, cookie);
    assert.equal(managed[1]!.robloxUsername, 'NewUser');
    const persisted = readFileSync(file, 'utf8');
    assert.match(persisted, /NewUser/); assert.ok(!persisted.includes(cookie));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.pipeline.stop(); f.store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('rotating JSON logger retains exactly 3 files and valid JSON lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-logs-'));
  try {
    const logger = new RotatingLogger(dir, 140);
    for (let i = 0; i < 12; i++) logger.info('example', { i });
    const files = readdirSync(dir); assert.equal(files.length, 3);
    for (const file of files) for (const line of readFileSync(join(dir, file), 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).event, 'example');
    assert.equal(JSON.parse(readFileSync(join(dir, 'pipeline.jsonl'), 'utf8').trim()).i, 11);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('batch assigns accounts round-robin and waits 5s only between submissions', async () => {
  const submitted: string[][] = [], waits: number[] = [];
  await runBatch(['123456', '654321', '123456'], accounts, async (link, alias) => { submitted.push([link, alias]); }, async ms => { waits.push(ms); });
  assert.deepEqual(submitted, [['123456', 'alpha'], ['654321', 'beta'], ['123456', 'alpha']]);
  assert.deepEqual(waits, [5000, 5000]);
  await assert.rejects(() => runBatch(['123456', 'bad'], accounts, async () => { throw new Error('must not submit'); }));
});

test('loader isolates worker identity, protects repeated runs and fetches MCP inside pcall', () => {
  const loader = makeLoader('alpha-1000-unique', 'session');
  assert.match(loader, /MCP_WORKER_ID/); assert.match(loader, /if env\.__AUTHORIZED_PIPELINE_LOADED then return end/);
  assert.match(loader, /pcall\(function\(\)\s+return game:HttpGet\("http:\/\/127\.0\.0\.1:28429\/mcp\.lua"\)/);
  assert.ok(!makeLoader('";error("oops")', 'session').includes('";error("oops")'));
  assert.ok(!loader.includes(token));
});

test('Project Real Auto-Execute bootstrap registers the player and never embeds pipeline callback secrets', () => {
  const script = makeProjectRealAutoexec('http://127.0.0.1:3000', autoexecToken);
  assert.match(script, /Url = "\\\d{3}/);
  assert.match(script, /Players\.LocalPlayer/);
  assert.match(script, /MCP_WORKER_ID/);
  assert.match(script, /__AUTHORIZED_PIPELINE_BOOTSTRAP_JOB/);
  assert.ok(!script.includes(token));
  assert.ok(!script.includes(callbackToken));
});

test('configuration fails closed for absent authorization, placeholder tokens and nonlocal origins', () => {
  const base = { PIPELINE_TOKEN: token, INTERNAL_CALLBACK_TOKEN: callbackToken, AUTOEXEC_TOKEN: autoexecToken, AUTHORIZED_PLACE_IDS: '123456', ACCOUNTS_FILE: join(process.cwd(), 'accounts.example.json') };
  assert.equal(loadConfig(base).authorized.has('123456'), true);
  assert.equal(loadConfig(base).ramUrl, 'http://127.0.0.1:7963');
  assert.throws(() => loadConfig({ ...base, AUTHORIZED_PLACE_IDS: '' }));
  assert.throws(() => loadConfig({ ...base, PIPELINE_TOKEN: 'short' }));
  assert.throws(() => loadConfig({ ...base, PIPELINE_TOKEN: 'replace-with-a-long-random-secret' }));
  assert.throws(() => loadConfig({ ...base, INTERNAL_CALLBACK_TOKEN: token }));
  assert.throws(() => loadConfig({ ...base, AUTOEXEC_TOKEN: callbackToken }));
  assert.throws(() => loadConfig({ ...base, HOST: '0.0.0.0' }));
  assert.throws(() => loadConfig({ ...base, RAM_URL: 'http://external.test' }));
  assert.throws(() => loadConfig({ ...base, RAM_PASSWORD: 'short' }));
  assert.throws(() => loadConfig({ ...base, MCP_URL: 'http://127.0.0.1:9999' }));
});
