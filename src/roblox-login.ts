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
  /**
   * Why an API attempt did not produce a usable token. Present whenever the
   * solver fell through to the operator, so a silent manual fallback is no
   * longer indistinguishable from a solver that never ran.
   */
  failure?: CaptchaFailure;
}

/** Machine-readable reason an API solve did not complete. */
export type CaptchaFailureCode =
  | 'no-api-key'          // nenhuma chave configurada
  | 'zero-balance'        // conta sem saldo
  | 'invalid-key'         // chave recusada
  | 'unsupported-type'    // provedor nao cobre esse tipo de captcha
  | 'missing-params'      // pkey/blob nao extraidos da pagina
  | 'timeout'             // provedor nao devolveu a tempo
  | 'provider-error'      // qualquer outro erro do provedor
  | 'network';            // falha de transporte

export interface CaptchaFailure {
  code: CaptchaFailureCode;
  provider: 'capsolver' | 'twocaptcha';
  /** Texto cru do provedor, para diagnostico. */
  detail?: string;
}

/** Credenciais de saida usadas pelo solver, no formato aceito pelos provedores. */
export interface CaptchaProxy {
  type: 'http' | 'https' | 'socks4' | 'socks5';
  address: string;
  port: number;
  login?: string;
  password?: string;
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
  /**
   * Saida usada pelo solver. Deve ser o MESMO proxy da janela do navegador:
   * um token resolvido de outro IP costuma ser rejeitado pelo Arkose.
   * Ausente = ProxyLess (IP do provedor).
   */
  proxy?: CaptchaProxy;
}

const CAPSOLVER_API = 'https://api.capsolver.com';
const TWOCAPTCHA_API = 'https://2captcha.com';

/**
 * Interpreta um valor de proxy no formato host:porta ou usuario:senha@host:porta.
 * Aceita prefixo de esquema (http://, socks5://). Devolve undefined quando vazio.
 */
export function parseCaptchaProxy(value: string | undefined): CaptchaProxy | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const scheme = /^(https?|socks[45]):\/\//i.exec(trimmed)?.[1]?.toLowerCase() ?? 'http';
  const bare = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = bare.lastIndexOf('@');
  const credentials = at >= 0 ? bare.slice(0, at) : undefined;
  const hostPort = at >= 0 ? bare.slice(at + 1) : bare;
  const separator = hostPort.lastIndexOf(':');
  const address = separator >= 0 ? hostPort.slice(0, separator) : '';
  const port = Number(separator >= 0 ? hostPort.slice(separator + 1) : '');
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('CAPTCHA_PROXY deve estar em host:porta ou usuario:senha@host:porta');
  const [login, password] = credentials !== undefined ? credentials.split(':') : [];
  const type = (scheme === 'https' ? 'https' : scheme === 'socks4' ? 'socks4' : scheme === 'socks5' ? 'socks5' : 'http') as CaptchaProxy['type'];
  return { type, address, port, login: login || undefined, password: password ?? undefined };
}

/**
 * Classifica a resposta de erro de um provedor. A distincao que importa e
 * saldo/chave: sem ela o operador ve "captcha nao resolveu" quando o problema
 * e a conta, nao o codigo.
 */
export function classifyProviderError(text: string): { code: CaptchaFailureCode; detail: string } {
  const raw = text.trim();
  const upper = raw.toUpperCase();
  if (/ZERO_BALANCE|INSUFFICIENT|NOT_ENOUGH_BALANCE|NO_BALANCE|BALANCE/.test(upper))
    return { code: 'zero-balance', detail: raw };
  if (/INVALID_KEY|ERROR_KEY_DOES_NOT_EXIST|WRONG_KEY|ACCOUNT_SUSPENDED|AUTHENTICATION/.test(upper))
    return { code: 'invalid-key', detail: raw };
  if (/UNSUPPORTED|UNKNOWN_TASK|TASK_NOT_SUPPORTED|ERROR_TASK_NOT_SUPPORTED/.test(upper))
    return { code: 'unsupported-type', detail: raw };
  if (/TIMEOUT|TIMED_OUT|NOT_READY/.test(upper)) return { code: 'timeout', detail: raw };
  return { code: 'provider-error', detail: raw };
}

/** Monta os campos de proxy no formato do provedor; vazio quando ProxyLess. */
function proxyFields(proxy: CaptchaProxy | undefined): Record<string, string | number> {
  if (!proxy) return {};
  return {
    proxyType: proxy.type,
    proxyAddress: proxy.address,
    proxyPort: proxy.port,
    ...(proxy.login ? { proxyLogin: proxy.login, proxyPassword: proxy.password ?? '' } : {}),
  };
}

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

/**
 * Solves via CapSolver API. Returns the token, or a classified failure.
 *
 * O task type acompanha o proxy: com proxy valido vale a variante que aceita
 * proxyAddress (FunCaptchaTask / AntiTurnstileTask / ReCaptchaV2Task), sem
 * proxy vale a ProxyLess. Mandar proxy para uma task ProxyLess e recusado.
 */
async function solveViaCapSolver(
  config: CaptchaSolverConfig,
  type: CaptchaType,
  params: { publicKey?: string; siteUrl: string; blobData?: string },
  log?: Logger
): Promise<{ token?: string; failure?: CaptchaFailure }> {
  const apiKey = config.capsolverApiKey;
  if (!apiKey) return { failure: { code: 'no-api-key', provider: 'capsolver' } };
  const timeout = config.apiTimeoutMs ?? 120_000;
  const pollMs = config.pollIntervalMs ?? 3_000;
  const start = Date.now();
  const proxy = proxyFields(config.proxy);
  const suffix = config.proxy ? '' : 'ProxyLess';

  let task: Record<string, unknown>;

  switch (type) {
    case 'arkose-funcaptcha':
      if (!params.publicKey) return { failure: { code: 'missing-params', provider: 'capsolver', detail: 'pkey do Arkose nao encontrada' } };
      task = {
        type: `FunCaptchaTask${suffix}`,
        websiteURL: params.siteUrl,
        websitePublicKey: params.publicKey,
        funcaptchaApiJSSubdomain: 'https://roblox-api.arkoselabs.com',
        data: JSON.stringify({ blob: params.blobData }),
        ...proxy
      };
      break;
    case 'cloudflare-turnstile':
      task = {
        type: `AntiTurnstileTask${suffix}`,
        websiteURL: params.siteUrl,
        websiteKey: params.publicKey,
        metadata: { action: 'login' },
        ...proxy
      };
      break;
    case 'roblox-image-grid':
      // O grid do Roblox e proprietario; mapear para ReCaptchaV2 nao devolve token
      // utilizavel. Falha explicita em vez de gastar credito numa tarefa invalida.
      log?.warn?.('captcha_unsupported_type', { provider: 'capsolver', type });
      return { failure: { code: 'unsupported-type', provider: 'capsolver', detail: 'grid do Roblox nao e suportado por API' } };
    default:
      return { failure: { code: 'unsupported-type', provider: 'capsolver', detail: `tipo ${type}` } };
  }

  const createPayload = { clientKey: apiKey, task };

  let createJson: { errorId?: number; taskId?: string; errorCode?: string; errorDescription?: string };
  try {
    const createRes = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createPayload)
    });
    createJson = await createRes.json() as typeof createJson;
  } catch (error) {
    return { failure: { code: 'network', provider: 'capsolver', detail: String(error) } };
  }

  if (createJson.errorId && createJson.errorId !== 0) {
    const classified = classifyProviderError(`${createJson.errorCode ?? ''} ${createJson.errorDescription ?? ''}`);
    log?.warn?.('captcha_capsolver_create_failed', { code: classified.code, error: createJson.errorCode, description: createJson.errorDescription });
    return { failure: { code: classified.code, provider: 'capsolver', detail: classified.detail } };
  }
  const taskId = createJson.taskId;
  if (!taskId) return { failure: { code: 'provider-error', provider: 'capsolver', detail: 'createTask sem taskId' } };

  // Poll for result
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    let statusJson: { errorId?: number; errorCode?: string; errorDescription?: string; status?: string; solution?: { token?: string; gRecaptchaResponse?: string; jsonObject?: { token?: string } } };
    try {
      const statusRes = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId })
      });
      statusJson = await statusRes.json() as typeof statusJson;
    } catch (error) {
      return { failure: { code: 'network', provider: 'capsolver', detail: String(error) } };
    }

    if (statusJson.errorId && statusJson.errorId !== 0) {
      const classified = classifyProviderError(`${statusJson.errorCode ?? ''} ${statusJson.errorDescription ?? ''}`);
      log?.warn?.('captcha_capsolver_result_failed', { code: classified.code, taskId, error: statusJson.errorCode });
      return { failure: { code: classified.code, provider: 'capsolver', detail: classified.detail } };
    }
    if (statusJson.status === 'ready') {
      const token = statusJson.solution?.token ?? statusJson.solution?.gRecaptchaResponse ?? statusJson.solution?.jsonObject?.token;
      if (token) {
        log?.info('captcha_solved_capsolver', { type, taskId, proxied: Boolean(config.proxy) });
        return { token };
      }
      return { failure: { code: 'provider-error', provider: 'capsolver', detail: 'ready sem token' } };
    }
  }
  return { failure: { code: 'timeout', provider: 'capsolver', detail: `sem token em ${timeout}ms` } };
}

/** Solves via 2Captcha API. Returns the token, or a classified failure. */
async function solveViaTwoCaptcha(
  config: CaptchaSolverConfig,
  type: CaptchaType,
  params: { publicKey?: string; siteUrl: string },
  log?: Logger
): Promise<{ token?: string; failure?: CaptchaFailure }> {
  const apiKey = config.twocaptchaApiKey;
  if (!apiKey) return { failure: { code: 'no-api-key', provider: 'twocaptcha' } };
  const timeout = config.apiTimeoutMs ?? 120_000;
  const pollMs = config.pollIntervalMs ?? 5_000;
  const start = Date.now();

  let method: string;
  let extraParams: Record<string, string> = {};

  switch (type) {
    case 'arkose-funcaptcha':
      if (!params.publicKey) return { failure: { code: 'missing-params', provider: 'twocaptcha', detail: 'pkey do Arkose nao encontrada' } };
      method = 'funcaptcha';
      extraParams = { publickey: params.publicKey, surl: 'https://roblox-api.arkoselabs.com' };
      break;
    case 'cloudflare-turnstile':
      method = 'turnstile';
      break;
    case 'roblox-image-grid':
      log?.warn?.('captcha_unsupported_type', { provider: 'twocaptcha', type });
      return { failure: { code: 'unsupported-type', provider: 'twocaptcha', detail: 'grid do Roblox nao e suportado por API' } };
    default:
      return { failure: { code: 'unsupported-type', provider: 'twocaptcha', detail: `tipo ${type}` } };
  }

  // O 2Captcha exige o proxy na submissao; sem ele usa a saida do proprio servico.
  const proxy = config.proxy;
  const submitBody = new URLSearchParams({
    key: apiKey, method, json: '1', pageurl: params.siteUrl, ...extraParams,
    ...(proxy ? {
      proxy: `${proxy.address}:${proxy.port}`,
      proxytype: proxy.type.toUpperCase(),
      ...(proxy.login ? { proxylogin: proxy.login, proxypassword: proxy.password ?? '' } : {}),
    } : {})
  });

  let submitJson: { status: number; request: string };
  try {
    const submitRes = await fetch(`${TWOCAPTCHA_API}/in.php`, { method: 'POST', body: submitBody });
    submitJson = await submitRes.json() as typeof submitJson;
  } catch (error) {
    return { failure: { code: 'network', provider: 'twocaptcha', detail: String(error) } };
  }
  if (submitJson.status !== 1) {
    const classified = classifyProviderError(submitJson.request ?? '');
    log?.warn?.('captcha_2captcha_submit_failed', { code: classified.code, error: submitJson.request });
    return { failure: { code: classified.code, provider: 'twocaptcha', detail: classified.detail } };
  }
  const captchaId = submitJson.request;

  // Poll for result
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    let pollJson: { status: number; request: string };
    try {
      const pollRes = await fetch(`${TWOCAPTCHA_API}/res.php?key=${apiKey}&action=get&json=1&id=${captchaId}`);
      pollJson = await pollRes.json() as typeof pollJson;
    } catch (error) {
      return { failure: { code: 'network', provider: 'twocaptcha', detail: String(error) } };
    }
    if (pollJson.status === 1) {
      log?.info('captcha_solved_2captcha', { type, captchaId, proxied: Boolean(config.proxy) });
      return { token: pollJson.request };
    }
    if (pollJson.request !== 'CAPCHA_NOT_READY') {
      const classified = classifyProviderError(pollJson.request ?? '');
      log?.warn?.('captcha_2captcha_result_failed', { code: classified.code, captchaId, error: pollJson.request });
      return { failure: { code: classified.code, provider: 'twocaptcha', detail: classified.detail } };
    }
  }
  return { failure: { code: 'timeout', provider: 'twocaptcha', detail: `sem token em ${timeout}ms` } };
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
    // CAPTCHA_PROXY tem precedencia sobre o proxy do navegador: o operador pode
    // querer resolver por outra saida sem mexer na janela.
    const explicitProxy = parseCaptchaProxy(env.CAPTCHA_PROXY);
    this.config = {
      ...this.config,
      capsolverApiKey: this.config.capsolverApiKey || env.CAPSOLVER_API_KEY?.trim(),
      twocaptchaApiKey: this.config.twocaptchaApiKey || env.TWOCAPTCHA_API_KEY?.trim(),
      proxy: this.config.proxy ?? explicitProxy,
    };
    return this.config;
  }

  /**
   * Herda a saida da janela do navegador. Um token Arkose resolvido de outro IP
   * costuma ser rejeitado, entao o solver fala pelo mesmo proxy do login.
   */
  useBrowserProxy(proxy: BrowserProxy | undefined): void {
    if (!proxy || this.config.proxy) return;
    this.config = { ...this.config, proxy: parseCaptchaProxy(proxy.server.includes('://') ? proxy.server : `http://${proxy.server}`) };
    if (this.config.proxy && proxy.username) this.config.proxy.login = proxy.username;
    if (this.config.proxy && proxy.password !== undefined) this.config.proxy.password = proxy.password;
  }

  hasApiKey(): boolean {
    return Boolean(this.config.capsolverApiKey || this.config.twocaptchaApiKey);
  }

  /**
   * Detects and solves any captcha present on the current Roblox login page.
   * Tries CapSolver first (faster for Roblox), then 2Captcha, then manual fallback.
   *
   * Cada tentativa que falha deixa o motivo em `failure`. Quando o solver cai
   * para o operador, o resultado diz por que — saldo zerado, chave invalida ou
   * rede aparecem no evento `captcha_api_exhausted`, em vez de virarem um
   * fallback silencioso indistinguivel de "nunca tentei".
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
      return { solved: true, type, method: 'none-required', elapsedMs: Date.now() - start };
    }

    this.log?.info('captcha_detected', { type, proxied: Boolean(this.config.proxy) });

    const params = await extractCaptchaParams(page);
    const failures: CaptchaFailure[] = [];

    // Tenta cada provedor configurado; o primeiro token que a pagina aceita vence.
    const providers: { provider: CaptchaFailure['provider']; key?: string; solve: () => Promise<{ token?: string; failure?: CaptchaFailure }> }[] = [
      { provider: 'capsolver', key: this.config.capsolverApiKey, solve: () => solveViaCapSolver(this.config, type, params, this.log) },
      { provider: 'twocaptcha', key: this.config.twocaptchaApiKey, solve: () => solveViaTwoCaptcha(this.config, type, params, this.log) },
    ];

    for (const candidate of providers) {
      if (!candidate.key) continue;
      let outcome: { token?: string; failure?: CaptchaFailure };
      try {
        outcome = await candidate.solve();
      } catch (error) {
        outcome = { failure: { code: 'network', provider: candidate.provider, detail: String(error) } };
        this.log?.warn?.(`captcha_${candidate.provider}_error`, { error: String(error) });
      }
      if (!outcome.token) {
        if (outcome.failure) failures.push(outcome.failure);
        continue;
      }
      const injected = await injectCaptchaToken(page, type, outcome.token);
      if (!injected) {
        failures.push({ code: 'provider-error', provider: candidate.provider, detail: 'token nao injetado na pagina' });
        continue;
      }
      // Espera o desafio sair da pagina antes de declarar vitoria.
      const cleared = await waitForManualCaptchaSolve(page, 30_000);
      if (cleared) return { solved: true, type, token: outcome.token, method: 'api', elapsedMs: Date.now() - start };
      failures.push({ code: 'provider-error', provider: candidate.provider, detail: 'desafio continuou na pagina apos injecao' });
    }

    // Nenhum provedor entregou: registra o motivo exato antes do fallback manual.
    const primary = failures[0];
    if (!this.hasApiKey()) {
      failures.push({ code: 'no-api-key', provider: 'capsolver' });
    }
    this.log?.warn?.('captcha_api_exhausted', {
      type,
      failures: failures.map(entry => ({ code: entry.code, provider: entry.provider, detail: entry.detail })),
    });

    // Manual fallback — operator solves in the visible Edge window
    if (this.config.fallbackToManual !== false) {
      this.log?.info('captcha_manual_fallback', { type, reason: primary?.code ?? 'api-unavailable' });
      const manualSolved = await waitForManualCaptchaSolve(page, timeoutMs);
      return { solved: manualSolved, type, method: 'manual', elapsedMs: Date.now() - start, failure: primary };
    }

    return { solved: false, type, method: 'api', elapsedMs: Date.now() - start, failure: primary };
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
  constructor(private open: LoginBrowserFactory = openEdge, private timeoutMs = 5 * 60_000, private proxy?: BrowserProxy,
    private captcha?: CaptchaSolver, private log?: Logger) {}

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

      // The captcha challenge only appears on suspicious logins; when it does, the
      // solver resolves it while the session poll below keeps running. Without a
      // configured key the operator solves it in the visible window as before.
      // O solver herda a saida da janela: token de outro IP costuma ser recusado.
      this.captcha?.useBrowserProxy(this.proxy);
      const deadline = Date.now() + this.timeoutMs;
      const captchaRun = this.captcha
        ? this.captcha.solveIfNeeded(page as unknown as LoginBrowserContext, this.timeoutMs)
            .then(result => {
              if (result.method === 'manual' && result.failure)
                this.log?.warn?.('captcha_unresolved_by_api', { code: result.failure.code, provider: result.failure.provider, detail: result.failure.detail });
              return result;
            })
            .catch(error => { this.log?.error('captcha_solver_error', { error: String(error) }); return undefined; })
        : Promise.resolve(undefined);

      while (Date.now() < deadline && browser.isConnected() && !page.isClosed()) {
        const cookies = await browser.contexts()[0]?.cookies('https://www.roblox.com') ?? [];
        const session = cookies.find(cookie => cookie.name === '.ROBLOSECURITY' && cookie.value.length >= 20);
        if (session) return session.value;
        await new Promise(resolve => setTimeout(resolve, 750));
      }
      await captchaRun;
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
