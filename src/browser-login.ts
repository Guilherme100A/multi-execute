import { chromium, type Browser } from 'playwright-core';
import { ConflictError } from './store.js';

export interface LoginBrowser {
  newPage(): Promise<{ goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>; locator(selector: string): { fill(value: string): Promise<void> }; isClosed(): boolean; bringToFront(): Promise<void> }>;
  contexts(): { cookies(url: string): Promise<{ name: string; value: string }[]> }[];
  close(): Promise<void>;
  isConnected(): boolean;
}

export type BrowserProxy = { server: string; username?: string; password?: string };
export type LoginBrowserFactory = (proxy?: BrowserProxy) => Promise<LoginBrowser>;

async function openEdge(proxy?: BrowserProxy): Promise<Browser> {
  return chromium.launch({ channel: 'msedge', headless: false, proxy, args: ['--start-maximized'], ignoreDefaultArgs: ['--no-startup-window'] });
}

/** Opens an isolated official Roblox login and returns only the resulting session cookie. */
export class RobloxBrowserLogin {
  private active = false;
  constructor(private open: LoginBrowserFactory = openEdge, private timeoutMs = 5 * 60_000, private proxy?: BrowserProxy) {}

  async signIn(username?: string): Promise<string> {
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
