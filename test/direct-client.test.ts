import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectRobloxClient, type DirectAction } from '../src/direct-client.js';

test('direct launcher validates inputs and uses its local executor without RAM HTTP', async () => {
  const calls: { action: DirectAction; input: Record<string, unknown> }[] = [];
  const direct = new DirectRobloxClient('unused', async (action, input) => {
    calls.push({ action, input });
    return { ok: true, accounts: ['AlphaUser', 'BetaUser'] };
  }, false);
  assert.deepEqual(await direct.accounts(), ['AlphaUser', 'BetaUser']);
  await direct.launch('AlphaUser', 'https://www.roblox.com/games/107778070777162/Steal-An-Egg');
  assert.deepEqual(calls[1], { action: 'Launch', input: { username: 'AlphaUser', placeId: '107778070777162' } });
  await assert.rejects(() => direct.launch('bad username', '123456'));
  await assert.rejects(() => direct.launch('AlphaUser', 'https://evil.test/games/123456'));
  await assert.rejects(() => direct.importCookie('secret\r\nCookie: injection'));
  await assert.rejects(() => direct.importRam('source', ['AlphaUser', 'alphauser']));
  assert.equal(calls.length, 2);
});

test('Windows imports only selected RAM accounts into an independent encrypted vault', { skip: process.platform !== 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-roblox-test-'));
  const source = join(directory, 'AccountData.json');
  const vault = join(directory, 'accounts.dpapi');
  const fixture = join(directory, 'fixture.ps1');
  writeFileSync(fixture, `param([string]$OutputFile)
Add-Type -AssemblyName System.Security
$rows=@(@{Username='AlphaUser';SecurityToken='fake-alpha-session-1234567890'},@{Username='BetaUser';SecurityToken='fake-beta-session-1234567890'},@{Username='OtherUser';SecurityToken='fake-other-session-1234567890'})
$clear=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $rows))
$entropy=[Text.Encoding]::UTF8.GetBytes('ROBLOX ACCOUNT MANAGER | :) | BROUGHT TO YOU BUY ic3w0lf')
$encrypted=[Security.Cryptography.ProtectedData]::Protect($clear,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes($OutputFile,$encrypted)
`);
  const direct = new DirectRobloxClient(vault);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-OutputFile', source], { windowsHide: true });
    const original = readFileSync(source);
    assert.deepEqual(await direct.importRam(source, ['AlphaUser', 'BetaUser']), ['AlphaUser', 'BetaUser']);
    assert.deepEqual(await direct.accounts(), ['AlphaUser', 'BetaUser']);
    assert.equal(readFileSync(vault).includes(Buffer.from('fake-alpha-session')), false);
    assert.deepEqual(readFileSync(source), original);
    // The imported vault remains usable after the source account manager data is gone.
    rmSync(source);
    assert.deepEqual(await direct.accounts(), ['AlphaUser', 'BetaUser']);
  } finally { direct.close(); rmSync(directory, { recursive: true, force: true }); }
});
