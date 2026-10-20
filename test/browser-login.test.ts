import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RobloxBrowserLogin, type LoginBrowser } from '../src/browser-login.js';

test('browser login captures only the Roblox session and closes the isolated browser', async () => {
  let checks = 0, closed = false;
  const browser: LoginBrowser = {
    async newPage() { return { async goto() {}, locator: () => ({ async fill() {} }), isClosed: () => false, async bringToFront() {} }; },
    contexts() { return [{ async cookies() { checks++; return checks < 2 ? [] : [{ name: '.ROBLOSECURITY', value: 'safe-test-session-value-1234567890' }]; } }]; },
    async close() { closed = true; },
    isConnected: () => true,
  };
  const login = new RobloxBrowserLogin(async () => browser, 5_000);
  assert.equal(await login.signIn(), 'safe-test-session-value-1234567890');
  assert.equal(closed, true);
});

test('browser login allows only one sign-in at a time', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const browser: LoginBrowser = {
    async newPage() { return { async goto() {}, locator: () => ({ async fill() {} }), isClosed: () => false, async bringToFront() {} }; },
    contexts() { return [{ async cookies() { await waiting; return [{ name: '.ROBLOSECURITY', value: 'safe-test-session-value-1234567890' }]; } }]; },
    async close() {}, isConnected: () => true,
  };
  const login = new RobloxBrowserLogin(async () => browser, 5_000);
  const first = login.signIn();
  await assert.rejects(() => login.signIn(), /already open/);
  release(); await first;
});

test('browser login prefills only the username and forwards an isolated proxy', async () => {
  let filled = '', receivedProxy: unknown;
  const browser: LoginBrowser = {
    async newPage() { return { async goto() {}, locator: () => ({ async fill(value: string) { filled = value; } }), isClosed: () => false, async bringToFront() {} }; },
    contexts() { return [{ async cookies() { return [{ name: '.ROBLOSECURITY', value: 'safe-test-session-value-1234567890' }]; } }]; },
    async close() {}, isConnected: () => true,
  };
  const proxy = { server: 'http://proxy.test:10001', username: 'user', password: 'secret' };
  const login = new RobloxBrowserLogin(async value => { receivedProxy = value; return browser; }, 5_000, proxy);
  await login.signIn('ExampleUser');
  assert.equal(filled, 'ExampleUser');
  assert.deepEqual(receivedProxy, proxy);
});
