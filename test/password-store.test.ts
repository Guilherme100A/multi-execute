import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PasswordStore, parseCredentials } from '../src/password-store.js';
import { AccountRegistry } from '../src/account-registry.js';
import { RobloxBrowserLogin, RobloxLogin, type LoginBrowser } from '../src/roblox-login.js';
import type { Account } from '../src/validation.js';

test('credential lists preserve colons, Unicode and spaces in passwords and reject duplicates without echoing input', () => {
  assert.deepEqual(parseCredentials('\uFEFFAlphaUser: x:y:á! \r\n\r\nBetaUser:abc'), [
    { username: 'AlphaUser', password: ' x:y:á! ' }, { username: 'BetaUser', password: 'abc' },
  ]);
  for (const value of ['', 'bad-user:private-value', 'AlphaUser:', 'AlphaUser:secret\nalphauser:other', 'AlphaUser:secret\t', 'AlphaUser:secret\ninvalid-private-value', 'a'.repeat(65_537)]) {
    assert.throws(() => parseCredentials(value), error => {
      assert(!String(error).includes('private-value')); assert(!String(error).includes('secret'));
      return true;
    });
  }
});

test('Windows vault persists encrypted passwords and serializes simultaneous updates', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'password-vault-'));
  const file = join(directory, 'passwords.dpapi');
  try {
    const store = new PasswordStore(file);
    await Promise.all([store.save([{ username: 'AlphaUser', password: 'fake-Álpha:one' }]), store.save([{ username: 'BetaUser', password: 'fake-beta-two' }])]);
    const reopened = new PasswordStore(file);
    assert.equal(await reopened.get('ALPHAUSER'), 'fake-Álpha:one');
    assert.equal(await reopened.get('BetaUser'), 'fake-beta-two');
    assert.equal(await reopened.get('Unknown'), undefined);
    assert(!(await readFile(file, 'utf8')).includes('fake-'));
    await store.save([{ username: 'AlphaUser', password: 'updated-fake' }]);
    assert.equal(await reopened.get('AlphaUser'), 'updated-fake');
    assert.equal(await reopened.get('BetaUser'), 'fake-beta-two');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('import registers usernames only, keeps existing aliases and validates the whole list before saving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'credential-import-'));
  try {
    const accounts: Account[] = [{ alias: 'main', robloxUsername: 'AlphaUser', ramAccount: 'AlphaUser' }];
    const file = join(directory, 'accounts.json');
    const registry = new AccountRegistry(file, accounts);
    let saves = 0;
    const login = new RobloxLogin(accounts, registry, { async accounts() { throw new Error('No network during import'); }, async importCookie() {} },
      { info() {}, error() {} }, { async signIn() { throw new Error('No browser during import'); } },
      { async save() { saves++; }, async get() { return undefined; } });
    await assert.rejects(() => login.importCredentials('AlphaUser:fake-secret\ninvalid'), /Linha 2/);
    assert.equal(saves, 0);
    assert.equal(await login.importCredentials('AlphaUser:fake-secret\nBetaUser:fake-second'), 2);
    assert.equal(accounts[0]!.alias, 'main'); assert.equal(accounts[1]!.alias, 'BetaUser');
    assert(!(await readFile(file, 'utf8')).includes('fake-'));
    await assert.rejects(() => login.importCredentials('main:fake-secret'), /conflicts/);
    assert.equal(saves, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('individual browser login fills a saved password only on the official origin, without submitting', async () => {
  const fills: string[] = [];
  let origin = 'https://www.roblox.com/login', closed = 0;
  const browser: LoginBrowser = {
    async newPage() { return { url: () => origin, async goto() {}, async bringToFront() {}, isClosed: () => false,
      locator(selector) { return { async fill(value) { fills.push(`${selector}:${value}`); } }; } }; },
    contexts() { return [{ async cookies() { return [{ name: '.ROBLOSECURITY', value: 'fake-session-for-tests-123456' }]; } }]; },
    isConnected: () => true, async close() { closed++; },
  };
  const login = new RobloxBrowserLogin(async () => browser);
  await login.signIn('AlphaUser', 'fake-password');
  assert.deepEqual(fills, ['#login-username:AlphaUser', '#login-password:fake-password']);
  fills.length = 0; origin = 'https://example.com/login';
  await assert.rejects(() => login.signIn('AlphaUser', 'fake-password'), /site oficial/);
  assert(!fills.some(value => value.includes('fake-password')));
  assert.equal(closed, 2);
});
