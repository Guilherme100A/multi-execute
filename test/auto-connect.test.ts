import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutoConnector, type RealConnection } from '../src/auto-connect.js';
import type { Pipeline } from '../src/pipeline.js';

test('automatic connection injects a batch and bootstraps only the exact account/game pairs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'automatic-connection-'));
  const bootstrap = join(directory, 'bootstrap.lua'); writeFileSync(bootstrap, '-- test');
  const rows = [
    { worker_id: 'alpha-worker', account_alias: 'alpha', place_id: '123456', status: 'launching', launching_at: 0 },
    { worker_id: 'beta-worker', account_alias: 'beta', place_id: '654321', status: 'launching', launching_at: 0 },
  ];
  let selected = 0, injected = false, ticks = 0;
  const executions: number[] = [];
  const pipeline = { store: { all: () => rows }, registeredUsername: (alias: string) => alias === 'alpha' ? 'AlphaUser' : 'BetaUser',
    tick: async () => { ticks++; } } as unknown as Pipeline;
  const real: RealConnection = {
    async connect() {}, async close() {},
    async call(name, args) {
      if (name === 'write-file') return 'written';
      if (name === 'list-clients') return { clients: injected ? [{ clientId: 1 }, { clientId: 2 }] : [] };
      if (name === 'list-roblox-windows') return { windows: [{ pid: 1 }, { pid: 2 }] };
      if (name === 'inject') { injected = true; return 'injected'; }
      if (name === 'set-active-client') { selected = args.clientId as number; return 'selected'; }
      if (name === 'eval') return { value: selected === 1 ? { username: 'AlphaUser', placeId: '123456' } : { username: 'BetaUser', placeId: '654321' } };
      if (name === 'execute') { assert.match(String(args.code), new RegExp(`MCP_PROCESS_ID = ${selected}\\n`)); executions.push(selected); return 'scheduled'; }
      throw new Error('Unexpected tool');
    },
  };
  const bridge = { async start() {}, async close() {} };
  const coordinator = new AutoConnector(pipeline, { async sessions() { return []; } }, real, bridge, bootstrap,
    { info() {}, error() {} }, () => 20_000, 2000, 0);
  try {
    await coordinator.tick();
    assert.deepEqual(executions, [1, 2]); assert.equal(ticks, 1);
    await coordinator.tick(); assert.deepEqual(executions, [1, 2]); // No duplicate execution while the bridge is registering.
    rows[1]!.place_id = '111111';
    executions.length = 0;
    const other = new AutoConnector(pipeline, { async sessions() { return []; } }, real, bridge, bootstrap,
      { info() {}, error() {} }, () => 40_000, 2000, 0);
    try { await other.tick(); assert.deepEqual(executions, [1]); } finally { await other.close(); }
  } finally { await coordinator.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('automatic connection reports setup failures instead of claiming it is ready', async () => {
  const coordinator = new AutoConnector({} as Pipeline, { async sessions() { return []; } },
    { async connect() {}, async call() {}, async close() {} },
    { async start() { throw new Error('Bridge unavailable'); }, async close() {} }, 'unused', { info() {}, error() {} });
  try { await coordinator.tick(); assert.equal(coordinator.status.state, 'error'); assert.equal(coordinator.status.error, 'Bridge unavailable'); }
  finally { await coordinator.close(); }
});
