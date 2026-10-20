/**
 * Central Roblox login module with captcha solver integrated.
 *
 * Edit this file to change the isolated Edge window, username prefill, optional
 * browser-only proxy, login timeout, session capture, DPAPI import, account
 * mapping, or captcha handling. Captcha is solved automatically via CapSolver
 * or 2Captcha when API keys are configured; falls back to operator manual solve.
 */
import { chromium, type Browser } from 'playwright-core';
import type { Account } from './validation.js';
import { aliasValue, InputError } from './validation.js';
import type { AccountRegistry } from './account-registry.js';
import type { RamClient } from './clients.js';
import type { Logger } from './logger.js';
import { ConflictError } from './store.js';
import { parseCredentials, type PasswordStore } from './password-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// CAPTCHA SOLVER
// ─────────────────────────────────────────────────────────────────────────────

export type CaptchaType = 'roblox-image-grid' | 'arkose-funcaptcha' | 'cloudflare-turnstile' | 'none';

export interface CaptchaSolveResult {
  solved: boolean;
  type: CaptchaType;
  token?: string;
  method: 'api' | 'manual' | 'none-required';
  elapsedMs: number;
}

export interface CaptchaSolverConfig {
  capsolverApiKey?: string;
  twocaptchaApiKey?: string;
  /** Max time to wait for API solve before falling back to manual. */
  apiTimeoutMs?: number;
  /** Polling interval when checking API job status. */
  pollIntervalMs?: number;
  /** Whether to fall back to manual operator solve if API fails. */
  fallbackToManual?: boolean;
}

const CAPSOLVER_API = 'https://api.capsolver.com';
const TWOCAPTCHA_API = 'https://2captcha.com';

interface LoginBrowserContext {
  url(): string;
  content(): string;
  evaluate<T>(fn: string): Promise<T>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options?: { path?: string; type?: string }): Promise<Buffer>;
  locator(selector: string): {
    count(): Promise<number>;
    isVisible(): Promise<boolean>;
    textContent(): Promise<string | null>;
    getAttribute(name: string): Promise<string | null>;
    click(options?: Record<string, unknown>): Promise<void>;
    fill(value: string): Promise<void>;
  };
}

/** Detects what captcha challenge (if any) is present on the Roblox login page. */
export async function detectCaptchaType(page: LoginBrowserContext): Promise<CaptchaType> {
  const html = await page.content();

  // Roblox custom image-grid captcha (primary on roblox.com/login)
  if (html.includes('captcha-container') || html.includes('image-captcha') ||
      html.includes('captcha-image-container') || html.includes('challenge')) {
    return 'roblox-image-grid';
  }

  // Arkose Labs / FunCaptcha (used by Roblox on suspicious logins)
  if (html.includes('arkoselabs') || html.includes('funcaptcha') ||
      html.includes('arkose') || html.includes('fc-ca') ||
      (await page.locator('#arkose_iframe').isVisible?.().catch(() => false))) {
    return 'arkose-funcaptcha';
  }

  // Cloudflare Turnstile (used on some Roblox endpoints)
  if (html.includes('challenges.cloudflare.com') || html.includes('cf-turnstile') ||
      (await page.locator('.cf-turnstile').isVisible?.().catch(() => false))) {
    return 'cloudflare-turnstile';
  }

  return 'none';
}

/** Extracts the public key and site URL needed for API-based solving. */
async function extractCaptchaParams(page: LoginBrowserContext): Promise<{ publicKey?: string; siteUrl: string; blobData?: string }> {
  const siteUrl = page.url();
  let publicKey: string | undefined;
  let blobData: string | undefined;

  try {
    publicKey = await page.evaluate<string>(`
      (() => {
        // Arkose public key from the enforcement script
        const scripts = document.querySelectorAll('script[src*="arkoselabs"], script[src*="funcaptcha"]');
        for (const s of scripts) {
          const match = s.src.match(/[?&]pk=([a-f0-9-]+)/);
          if (match) return match[1];
        }
        const iframe = document.querySelector('iframe[src*="arkose"]');
        if (iframe) {
          const match = iframe.src.match(/[?&]pk=([a-f0-9-]+)/);
          if (match) return match[1];
        }
        // Roblox inline data
        const meta = document.querySelector('meta[name="captcha-public-key"]');
        if (meta) return meta.content;
        const dataEl = document.querySelector('[data-captcha-key]');
        if (dataEl) return dataEl.getAttribute('data-captcha-key');
        return '';
      })()
    `);
  } catch { /* page context may be restricted */ }

  try {
    blobData = await page.evaluate<string>(`
      (() => {
        const el = document.querySelector('[data-blob]');
        return el ? el.getAttribute('data-blob') : '';
      })()
    `);
  } catch { /* not present */ }

  return { publicKey: publicKey || undefined, siteUrl, blobData: blobData || undefined };
}

/** Solves via CapSolver API. Returns the solution token. */
async function solveViaCapSolver(
  config: CaptchaSolverConfig,
  type: CaptchaType,
  params: { publicKey?: string; siteUrl: string; blobData?: string },
  log?: Logger
): Promise<string | undefined> {
  const apiKey = config.capsolverApiKey;
  if (!apiKey) return undefined;
  const timeout = config.apiTimeoutMs ?? 120_000;
  const pollMs = config.pollIntervalMs ?? 3_000;
  const start = Date.now();

  let createPayload: Record<string, unknown>;

  switch (type) {
    case 'arkose-funcaptcha':
      if (!params.publicKey) return undefined;
      createPayload = {
        clientKey: apiKey,
        task: {
          type: 'FunCaptchaTaskProxyLess',
          websiteURL: params.siteUrl,
          funcaptchaApiJSSubdomain: 'https://roblox-api.arkoselabs.com',
          data: JSON.stringify({ blob: params.blobData }) 
        }
      };
      break;
    case 'cloudflare-turnstile':
      createPayload = {
        clientKey: apiKey,
        task: {
          type: 'AntiTurnstileTaskProxyLess',
          websiteURL: params.siteUrl,
          metadata: { action: 'login' }
        }
      };
      break;
    case 'roblox-image-grid':
      // Roblox's custom captcha requires a screenshot-based approach
      createPayload = {
        clientKey: apiKey,
        task: {
          type: 'ReCaptchaV2TaskProxyLess', // CapSolver maps Roblox grids to image classification
          websiteURL: params.siteUrl,
          websiteKey: params.publicKey || 'roblox-default'
        }
      };
      break;
    default:
      return undefined;
  }

  const createRes = await fetch(`${CAPSOLVER_API}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createPayload)
  });
  const createJson = await createRes.json() as { errorId?: number; taskId?: string; errorCode?: string };

  if (createJson.errorId && createJson.errorId !== 0) {
    log?.warn('captcha_capsolver_create_failed', { error: createJson.errorCode });
    return undefined;
  }
  const taskId = createJson.taskId;
  if (!taskId) return undefined;

  // Poll for result
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const statusRes = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId })
    });
    const statusJson = await statusRes.json() as { errorId?: number; status?: string; solution?: { token?: string; gRecaptchaResponse?: string; jsonObject?: { token?: string } } };

    if (statusJson.errorId && statusJson.errorId !== 0) return undefined;
    if (statusJson.status === 'ready') {
      const token = statusJson.solution?.token ?? statusJson.solution?.gRecaptchaResponse ?? statusJson.solution?.jsonObject?.token;
      if (token) {
        log?.info('captcha_solved_capsolver', { type, taskId });
        return token;
      }
      return undefined;
    }
  }
  return undefined;
}

/** Solves via 2Captcha API. Returns the solution token. */
async function solveViaTwoCaptcha(
  config: CaptchaSolverConfig,
  type: CaptchaType,
  params: { publicKey?: string; siteUrl: string },
  log?: Logger
): Promise<string | undefined> {
  const apiKey = config.twocaptchaApiKey;
  if (!apiKey) return undefined;
  const timeout = config.apiTimeoutMs ?? 120_000;
  const pollMs = config.pollIntervalMs ?? 5_000;
  const start = Date.now();

  let method: string;
  let extraParams: Record<string, string> = {};

  switch (type) {
    case 'arkose-funcaptcha':
      if (!params.publicKey) return undefined;
      method = 'funcaptcha';
      extraParams = { publickey: params.publicKey, surl: 'https://roblox-api.arkoselabs.com' };
      break;
    case 'cloudflare-turnstile':
      method = 'turnstile';
      break;
    case 'roblox-image-grid':
      method = 'userrecaptcha';
      extraParams = { googlekey: params.publicKey || 'roblox-default' };
      break;
    default:
      return undefined;
  }

  // Submit task
  const submitBody = new URLSearchParams({ key: apiKey, method, json: '1', pageurl: params.siteUrl, ...extraParams });
  const submitRes = await fetch(`${TWOCAPTCHA_API}/in.php`, { method: 'POST', body: submitBody });
  const submitJson = await submitRes.json() as { status: number; request: string };
  if (submitJson.status !== 1) {
    log?.warn('captcha_2captcha_submit_failed', { error: submitJson.request });
    return undefined;
  }
  const captchaId = submitJson.request;

  // Poll for result
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const pollRes = await fetch(`${TWOCAPTCHA_API}/res.php?key=${apiKey}&action=get&json=1&id=${captchaId}`);
    const pollJson = await pollRes.json() as { status: number; request: string };
    if (pollJson.status === 1) {
      log?.info('captcha_solved_2captcha', { type, captchaId });
      return pollJson.request;
    }
    if (pollJson.request !== 'CAPCHA_NOT_READY') return undefined;
  }
  return undefined;
}

/** Injects a solved token back into the page so the login form can proceed. */
async function injectCaptchaToken(page: LoginBrowserContext, type: CaptchaType, token: string): Promise<boolean> {
  try {
    await page.evaluate(`
      (() => {
        const token = ${JSON.stringify(token)};
        // Set hidden captcha response fields
        const setIfExists = (sel, val) => {
          const el = document.querySelector(sel);
          if (el) {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = val;
            else el.textContent = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        };
        setIfExists('#captcha-response', token);
        setIfExists('input[name="captchaResponse"]', token);
        setIfExists('input[name="cf-turnstile-response"]', token);
        setIfExists('textarea[name="g-recaptcha-response"]', token);
        // Trigger any callbacks registered by the captcha widget
        if (window.__captchaCallback && typeof window.__captchaCallback === 'function') {
          window.__captchaCallback(token);
        }
        if (window.turnstileCallback && typeof window.turnstileCallback === 'function') {
          window.turnstileCallback(token);
        }
        // Roblox stores it in a state container on some flows
        if (window.__robloxState) window.__robloxState.captchaToken = token;
      })()
    `);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the operator to manually solve a captcha if API methods fail. */
async function waitForManualCaptchaSolve(page: LoginBrowserContext, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    try {
      const type = await detectCaptchaType(page);
      if (type === 'none') return true;
    } catch { /* page may navigate */ }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAPTCHA SOLVER ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────

export class CaptchaSolver {
  constructor(private config: CaptchaSolverConfig, private log?: Logger) {}

  loadConfigFromEnv(env: Record<string, string | undefined> = process.env): CaptchaSolverConfig {
    this.config = {
      ...this.config,
      capsolverApiKey: this.config.capsolverApiKey || env.CAPSOLVER_API_KEY?.trim(),
      twocaptchaApiKey: this.config.twocaptchaApiKey || env.TWOCAPTCHA_API_KEY?.trim(),
    };
    return this.config;
  }

  hasApiKey(): boolean {
    return Boolean(this.config.capsolverApiKey || this.config.twocaptchaApiKey);
  }

  /**
   * Detects and solves any captcha present on the current Roblox login page.
   * Tries CapSolver first (faster for Roblox), then 2Captcha, then manual fallback.
   */
  async solveIfNeeded(page: LoginBrowserContext, timeoutMs = 3 * 60_000): Promise<CaptchaSolveResult> {
    const start = Date.now();
    let type: CaptchaType;
    try {
      type = await detectCaptchaType(page);
    } catch {
      type = 'none';
    }

    if (type === 'none') {
      return { solved: true, type: 'none', method: 'none-required', elapsedMs: Date.now() - start };
    }

    this.log?.info('captcha_detected', { type });

    const params = await extractCaptchaParams(page);

    // Try CapSolver first — best Roblox/Arkose support
    if (this.config.capsolverApiKey) {
      try {
        const token = await solveViaCapSolver(this.config, type, params, this.log);
        if (token) {
          const injected = await injectCaptchaToken(page, type, token);
          if (injected) {
            // Wait for captcha to clear from page
            const cleared = await waitForManualCaptchaSolve(page, 30_000);
            if (cleared) {
              return { solved: true, type, token, method: 'api', elapsedMs: Date.now() - start };
            }
          }
        }
      } catch (err) {
        this.log?.warn('captcha_capsolver_error', { error: String(err) });
      }
    }

    // Try 2Captcha
    if (this.config.twocaptchaApiKey) {
      try {
        const token = await solveViaTwoCaptcha(this.config, type, params, this.log);
        if (token) {
          const injected = await injectCaptchaToken(page, type, token);
          if (injected) {
            const cleared = await waitForManualCaptchaSolve(page, 30_000);
            if (cleared) {
              return { solved: true, type, token, method: 'api', elapsedMs: Date.now() - start };
            }
          }
        }
      } catch (err) {
        this.log?.warn('captcha_2captcha_error', { error: String(err) });
      }
    }

    // Manual fallback — operator solves in the visible Edge window
    if (this.config.fallbackToManual !== false) {
      this.log?.info('captcha_manual_fallback', { type });
      const manualSolved = await waitForManualCaptchaSolve(page, timeoutMs);
      return { solved: manualSolved, type, method: 'manual', elapsedMs: Date.now() - start };
    }

    return { solved: false, type, method: 'api', elapsedMs: Date.now() - start };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER & LOGIN
// ─────────────────────────────────────────────────────────────────────────────

export interface LoginBrowser {
  newPage(): Promise<{ url(): string; goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>; locator(selector: string): { fill(value: string): Promise<void> }; isClosed(): boolean; bringToFront(): Promise<void> }>;
  contexts(): { cookies(url: string): Promise<{ name: string; value: string }[]> }[];
  close(): Promise<void>;
  isConnected(): boolean;
}

export type BrowserProxy = { server: string; username?: string; password?: string };
export type LoginBrowserFactory = (proxy?: BrowserProxy) => Promise<LoginBrowser>;
export type LocalAccountStore = Pick<RamClient, 'accounts' | 'importCookie'>;

export function loadRobloxLoginOptions(env
