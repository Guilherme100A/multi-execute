import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Pipeline } from '../src/pipeline.js';
import { AccountRegistry } from '../src/account-registry.js';
import { RobloxLogin } from '../src/roblox-login.js';
import type { Account } from '../src/validation.js';

test('TXT import validates, saves, clears plaintext and selects an individual login without exposing passwords', async ({ page, request }, info) => {
  const directory = await mkdtemp(join(tmpdir(), 'credential-ui-'));
  const accounts: Account[] = [], saved = new Map<string, string>(), local: string[] = [];
  const logs: string[] = [], signIns: { username?: string; password?: string }[] = [];
  const log = { info(event: string, fields?: unknown) { logs.push(JSON.stringify({ event, fields })); }, error(event: string, fields?: unknown) { logs.push(JSON.stringify({ event, fields })); } };
  const store = new Store(':memory:');
  const pipeline = new Pipeline(store, { async launch() {} }, { async health() {}, async sessions() { return []; }, async processes() { return []; }, async execute() {} }, accounts, new Set(['123456']), log);
  const registry = new AccountRegistry(join(directory, 'accounts.json'), accounts);
  const localAccounts = { async accounts() { return local; }, async importCookie() { local.push(signIns.at(-1)!.username!); } };
  const login = new RobloxLogin(accounts, registry, localAccounts, log, { async signIn(username, password) { signIns.push({ username, password }); return 'fake-session-only'; } },
    { async get(username) { return saved.get(username.toLowerCase()); }, async save(rows) { rows.forEach(row => saved.set(row.username.toLowerCase(), row.password)); } });
  const app = createApp(pipeline, 'callback-test', 'autoexec-test', directory, log, undefined, accounts, registry, localAccounts, undefined, undefined, undefined, undefined, login);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const url = `http://127.0.0.1:${address.port}`;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const denied = await request.post(`${url}/accounts/credentials`, { headers: { Origin: 'https://example.com' }, data: { text: 'AlphaUser:fake-one' } });
    expect(denied.status()).toBe(403); expect(saved.size).toBe(0);
    const malformed = await request.post(`${url}/accounts/credentials`, { headers: { 'Content-Type': 'application/json' }, data: '{fake-private-password' });
    expect(await malformed.text()).not.toContain('fake-private-password');
    await page.goto(url);
    await page.locator('[data-account-method="txt"]').click();
    await page.locator('#credentialsText').fill('AlphaUser:fake-one\nbad-row');
    await page.locator('#importCredentials').click();
    await expect(page.locator('#accountMessage')).toContainText('Linha 2'); expect(saved.size).toBe(0);
    await page.locator('#accountsTxt').setInputFiles({ name: 'example.txt', mimeType: 'text/plain', buffer: Buffer.from('AlphaUser:fake-one\r\nBetaUser:fake-two:with-colon') });
    await expect(page.locator('#credentialsText')).toHaveValue(/BetaUser/);
    await page.locator('#importCredentials').click();
    await expect(page.locator('#accountMessage')).toContainText('2 conta(s)');
    await expect(page.locator('#credentialsText')).toHaveValue(''); expect(signIns).toHaveLength(0);
    const config = await request.get(`${url}/config`); expect(await config.text()).not.toContain('fake-one');
    await page.locator('[data-account-method="individual"]').click();
    await page.locator('#browserAlias').selectOption('BetaUser');
    await page.locator('#browserAccountForm button').click();
    await expect(page.locator('#accountMessage')).toContainText('Conta autenticada');
    expect(signIns).toEqual([{ username: 'BetaUser', password: 'fake-two:with-colon' }]);
    expect(logs.join('')).not.toContain('fake-'); expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('individual-login.png'), fullPage: true });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await app.shutdown(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
