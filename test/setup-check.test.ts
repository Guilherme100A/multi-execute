import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSetup } from '../src/setup-check.js';

test('setup rereads installed files and distinguishes the selected CLI from optional alternatives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-check-'));
  try {
    const accountsFile = join(root, 'accounts.json');
    await writeFile(accountsFile, '[]');
    const config = { realMcpExecutable: join(root, 'real-mcp.exe'), autoConnect: true,
      authorized: new Set<string>(), accounts: [] as unknown[], accountsFile,
      agentCliCommand: 'codex.cmd', claudeCliCommand: 'claude.exe' };
    const env = { PATH: root, LOCALAPPDATA: root };
    let report = await inspectSetup(config, 'codex', env);
    assert.equal(report.ready, false);
    assert.equal(report.items.find(item => item.id === 'roblox')?.status, 'missing');
    assert.equal(report.items.find(item => item.id === 'codex')?.required, true);
    assert.equal(report.items.find(item => item.id === 'claude')?.required, false);
    assert.equal(report.items.find(item => item.id === 'accounts')?.status, 'attention');

    const version = join(root, 'Roblox', 'Versions', 'version-test');
    await mkdir(version, { recursive: true });
    await Promise.all(['real-mcp.exe', 'codex.cmd', 'powershell.exe'].map(file => writeFile(join(root, file), 'fixture')));
    await writeFile(join(version, 'RobloxPlayerBeta.exe'), 'fixture');
    config.authorized.add('123456789');
    config.accounts.push({ alias: 'test' });
    report = await inspectSetup(config, 'codex', env);
    for (const id of ['roblox', 'real', 'codex', 'powershell', 'games', 'accounts', 'storage']) {
      assert.equal(report.items.find(item => item.id === id)?.status, 'ok', id);
    }
    assert.equal(report.ready, process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 24);

    report = await inspectSetup(config, 'claude', env);
    assert.equal(report.ready, false);
    assert.equal(report.items.find(item => item.id === 'claude')?.status, 'missing');
    assert.equal(report.items.find(item => item.id === 'claude')?.required, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
