/**
 * Central Roblox login module.
 *
 * Edit this file to change the isolated Edge window, username prefill, optional
 * browser-only proxy, login timeout, session capture, DPAPI import, or account
 * mapping. Optional passwords are read from the local DPAPI vault; the operator
 * submits the official login and completes CAPTCHA and 2FA manually.
 */
import { chromium, type Browser } from 'playwright-core';
import type { Account } from './validation.js';
import { aliasValue, InputError } from './validation.js';
import type { AccountRegistry } from './account-registry.js';
import type { RamClient } from './clients.js';
import type { Logger } from './logger.js';
import { ConflictError } from './store.js';
import { parseCredentials, type PasswordStore } from './password-store.js';

export interface LoginBrowser {
  newPage(): Promise<{ url(): string; goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>; locator(selector: string): { fill(value: string): Promise<void> }; isClosed(): boolean; bringToFront(): Promise<void> }>;
  contexts(): { cookies(url: string): Promise<{ name: string; value: string }[]> }[];
  close(): Promise<void>;
  isConnected(): boolean;
}

export type BrowserProxy = { server: string; username?: string; password?: string };
export type LoginBrowserFactory = (proxy?: BrowserProxy) => Promise<LoginBrowser>;
export type LocalAccountStore = Pick<RamClient, 'accounts' | 'importCookie'>;

export function loadRobloxLoginOptions(env = process.env): { proxy?: BrowserProxy } {
  const server = env.BROWSER_PROXY_SERVER?.trim();
  if (!server) {
    if (env.BROWSER_PROXY_USERNAME || env.BROWSER_PROXY_PASSWORD) throw new Error('BROWSER_PROXY_SERVER is required when browser proxy credentials are configured');
    return {};
  }
  const url = new URL(server.includes('://') ? server : `http://${server}`);
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('BROWSER_PROXY_SERVER must be an HTTP, HTTPS or SOCKS5 proxy without embedded credentials');
  return { proxy: { server: url.origin, username: env.BROWSER_PROXY_USERNAME, password: env.BROWSER_PROXY_PASSWORD } };
}

async function openEdge(proxy?: BrowserProxy): Promise<Browser> {
  return chromium.launch({ channel: 'msedge', headless: false, proxy, args: ['--start-maximized'], ignoreDefaultArgs: ['--no-startup-window'] });
}

/** Captures only the session created after the operator completes the official login. */
export class RobloxBrowserLogin {
  private active = false;
  constructor(private open: LoginBrowserFactory = openEdge, private timeoutMs = 5 * 60_000, private proxy?: BrowserProxy) {}

  async signIn(username?: string, password?: string): Promise<string> {
    if (this.active) throw new ConflictError('Another Roblox sign-in window is already open');
    this.active = true;
    let browser: LoginBrowser | undefined;
    try {
      browser = await this.open(this.proxy);
      const page = await browser.newPage();
      await page.bringToFront();
      let navigationError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.goto('https://www.roblox.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
          navigationError = undefined;
          break;
        } catch (error) {
          navigationError = error;
          if (!browser.isConnected() || page.isClosed()) break;
          await new Promise(resolve => setTimeout(resolve, 1_000 * (attempt + 1)));
        }
      }
      if (navigationError) throw navigationError;
      if (username) await page.locator('#login-username').fill(username);
      if (password) {
        if (new URL(page.url()).origin !== 'https://www.roblox.com') throw new Error('A janela de login não está no site oficial do Roblox.');
        try { await page.locator('#login-password').fill(password); }
        catch { throw new Error('Não foi possível preencher a senha na janela oficial.'); }
        finally { password = undefined; }
      }
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline && browser.isConnected() && !page.isClosed()) {
        const cookies = await browser.contexts()[0]?.cookies('https://www.roblox.com') ?? [];
        const session = cookies.find(cookie => cookie.name === '.ROBLOSECURITY' && cookie.value.length >= 20);
        if (session) return session.value;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      throw new Error('Roblox sign-in was cancelled or timed out');
    } finally {
      await browser?.close().catch(() => {});
      this.active = false;
    }
  }
}

/** Owns the complete flow from alias selection through encrypted local import. */
export class RobloxLogin {
  private importing = false;
  constructor(private configuredAccounts: Account[], private registry: AccountRegistry, private local: LocalAccountStore,
    private log: Logger, private browser: Pick<RobloxBrowserLogin, 'signIn'>,
    private passwords?: Pick<PasswordStore, 'save' | 'get'>) {}

  async importCredentials(input: unknown): Promise<number> {
    if (!this.passwords) throw new Error('Cofre de senhas indisponível.');
    if (this.importing) throw new ConflictError('Uma importação já está em andamento.');
    const rows = parseCredentials(input);
    const usernames = rows.map(row => row.username);
    this.registry.prepareUsernames(usernames);
    this.importing = true;
    try {
      await this.passwords.save(rows);
      this.registry.addUsernames(usernames);
      return rows.length;
    } finally { this.importing = false; }
  }

  async signIn(aliasInput: unknown): Promise<Account> {
    const alias = aliasValue(aliasInput);
    const configured = this.configuredAccounts.find(account => account.alias.toLowerCase() === alias.toLowerCase());
    if (!configured) throw new InputError('Account alias is not configured');
    const before = await this.local.accounts();
    const password = await this.passwords?.get(configured.robloxUsername);
    const cookie = await this.browser.signIn(configured.robloxUsername, password);
    await this.local.importCookie(cookie);
    const after = await this.local.accounts();
    const previous = new Set(before.map(value => value.toLowerCase()));
    const added = after.filter(value => !previous.has(value.toLowerCase()));
    const username = added.length === 1 ? added[0] : after.find(value => value.toLowerCase() === configured.robloxUsername.toLowerCase());
    if (!username) throw new ConflictError('The signed-in account could not be mapped uniquely; use Sync existing account');
    const account = this.registry.add(alias, username);
    this.log.info('account_browser_login', { alias: account.alias, username });
    return account;
  }
}
