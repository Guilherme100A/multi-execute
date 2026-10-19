import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

test('metadata probes preserve two explicitly registered process identities', async () => {
  const require = createRequire(import.meta.url);
  const { WsServer } = require('roblox-mcp-difz/dist/ws-server.js');
  const { SessionManager } = require('roblox-mcp-difz/dist/session-manager.js');
  const WebSocket = require('ws');
  const sessions = new SessionManager();
  let finished = 0;
  let done!: () => void;
  const probes = new Promise<void>(resolve => { done = resolve; });
  const queue = Object.assign(new EventEmitter(), { resolveTask() { if (++finished === 2) done(); } });
  const bridge = new WsServer(queue, sessions);
  const server = createServer(); bridge.mount(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const clients: { terminate(): void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const [worker, pid] of [['alpha', 900001], ['beta', 900002]] as const) {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`); clients.push(client);
      client.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'task') client.send(JSON.stringify({ type: 'result', id: message.id,
          data: { metadata: { Name: 'Roblox', PlaceId: 123456, JobId: worker } } }));
      });
      await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
      client.send(JSON.stringify({ type: 'register', worker_id: worker, pid, placeName: 'Roblox', username: worker }));
    }
    await Promise.race([probes, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Metadata probes did not complete')), 5000); })]);
    const active = sessions.listActive() as { workerId: string; pid: number }[];
    assert.deepEqual(active.map(row => ({ worker: row.workerId, pid: row.pid })), [
      { worker: 'alpha', pid: 900001 }, { worker: 'beta', pid: 900002 },
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const client of clients) client.terminate();
    bridge.destroy(); sessions.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
