/**
 * Prova os dois consertos do solver contra servidores locais que imitam
 * CapSolver e 2Captcha:
 *   1. erro de saldo/chave vira failure classificado, nao fallback mudo
 *   2. o proxy da janela chega ao payload do provedor
 *
 * Rodar: node --test dist/test/captcha-proxy.test.js  (ou via tsx)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CaptchaSolver, classifyProviderError, parseCaptchaProxy } from '../src/roblox-login.js';
import type { Logger } from '../src/logger.js';

const silentLog: Logger = { info() {}, warn() {}, error() {} };

type Observed = { url: string; body: string; parsed?: Record<string, unknown> };
type Reply = Record<string, unknown>;

async function withServer<T>(handler: (o: Observed) => Reply, run: (port: number, seen: Observed[], restore: () => void) => Promise<T>): Promise<T> {
  const seen: Observed[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body) as Record<string, unknown>; } catch { return undefined; } })();
      const entry = { url: req.url ?? '', body, parsed };
      seen.push(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handler(entry)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const original = globalThis.fetch;
  const restore = () => { globalThis.fetch = original; };
  try { return await run(port, seen, restore); }
  finally { restore(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

/**
 * Redireciona o provedor para o servidor local. Usa o fetch NATIVO capturado
 * antes de qualquer override â€” chamar o global aqui causaria recursao.
 */
function redirect(nativeFetch: typeof fetch, host: string, port: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(String(input).replace(host, `http://127.0.0.1:${port}`), init)) as typeof fetch;
}

/**
 * Desvia TODOS os provedores para o servidor local. Sem isso um teste que
 * espera o fallback do CapSolver para o 2Captcha vaza para a internet real
 * e falha por rede em vez de provar o comportamento.
 */
function redirectAll(nativeFetch: typeof fetch, port: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(String(input)
      .replace('https://api.capsolver.com', `http://127.0.0.1:${port}`)
      .replace('https://2captcha.com', `http://127.0.0.1:${port}`), init)) as typeof fetch;
}

const NATIVE_FETCH = globalThis.fetch;

/**
 * Pagina falsa: o solver so precisa de url/content/evaluate/locator.
 * `clearAfter` simula o desafio saindo da pagina depois de N leituras de
 * content(), para o teste nao esperar os 30s reais do wait manual.
 */
function fakePage(html: string, clearAfter = 1) {
  let reads = 0;
  return {
    url: () => 'https://www.roblox.com/login',
    content: async () => {
      reads += 1;
      return reads > clearAfter ? '<html><body>sem captcha</body></html>' : html;
    },
    evaluate: async <T,>(script: string): Promise<T> => {
      // O extrator de pkey procura "pk="; o de blob procura "data-blob".
      const value = script.includes('pk=') ? 'A2A14B1D-1AF3-C791-9BBC-EE33CC7A0A6F' : 'BLOB-ABC';
      return value as unknown as T;
    },
    waitForSelector: async () => undefined,
    waitForTimeout: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    locator: () => ({
      count: async () => 0, isVisible: async () => false, textContent: async () => null,
      getAttribute: async () => null, click: async () => undefined, fill: async () => undefined,
    }),
  };
}

const ARKOSE_HTML = '<html><body><iframe src="https://roblox-api.arkoselabs.com/fc/gc/?pk=A2A14B1D-1AF3-C791-9BBC-EE33CC7A0A6F"></iframe><div data-blob="BLOB-ABC"></div></body></html>';
const TURNSTILE_HTML = '<html><body><div class="cf-turnstile" data-sitekey="0x4AAA"></div></body></html>';

test('saldo zerado: o resultado carrega zero-balance em vez de cair mudo para o manual', async () => {
  await withServer(() => ({ errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', errorDescription: 'no funds' }), async (port, seen, restore) => {
    globalThis.fetch = redirect(NATIVE_FETCH, 'https://api.capsolver.com', port);
    const solver = new CaptchaSolver({ capsolverApiKey: 'CAP-KEY', fallbackToManual: false, pollIntervalMs: 1000 }, silentLog);
    const result = await solver.solveIfNeeded(fakePage(TURNSTILE_HTML) as never, 5_000);
    restore();
    assert.equal(result.solved, false);
    assert.equal(result.failure?.code, 'zero-balance');
    assert.equal(result.failure?.provider, 'capsolver');
    assert.equal(seen.length, 1, 'nao deve fazer polling depois de erro no createTask');
  });
});

test('chave invalida vira invalid-key, nao provider-error generico', async () => {
  await withServer(() => ({ errorId: 1, errorCode: 'ERROR_INVALID_KEY', errorDescription: 'bad key' }), async (port, _seen, restore) => {
    globalThis.fetch = redirect(NATIVE_FETCH, 'https://api.capsolver.com', port);
    const solver = new CaptchaSolver({ capsolverApiKey: 'RUIM', fallbackToManual: false, pollIntervalMs: 1000 }, silentLog);
    const result = await solver.solveIfNeeded(fakePage(TURNSTILE_HTML) as never, 5_000);
    restore();
    assert.equal(result.failure?.code, 'invalid-key');
  });
});

test('Arkose no CapSolver falha antes da requisicao: a CapSolver nao lista mais FunCaptcha', async () => {
  await withServer(() => ({ errorId: 0, taskId: 'T1' }),
    async (port, seen, restore) => {
      globalThis.fetch = redirect(NATIVE_FETCH, 'https://api.capsolver.com', port);
      const solver = new CaptchaSolver({ capsolverApiKey: 'CAP-KEY', pollIntervalMs: 1000 }, silentLog);
      const result = await solver.solveIfNeeded(fakePage(ARKOSE_HTML) as never, 5_000);
      restore();
      assert.equal(result.failure?.code, 'unsupported-type');
      assert.equal(result.failure?.provider, 'capsolver');
      assert.equal(seen.length, 0, 'nao pode gastar requisicao num task type que a CapSolver removeu');
    });
});

test('Arkose cai para o 2Captcha com proxy e usa o task type com proxy', async () => {
  await withServer(({ url }) => (url.includes('in.php') ? { status: 1, request: 'ID-1' } : { status: 1, request: 'TOKEN-X' }),
    async (port, seen, restore) => {
      globalThis.fetch = redirectAll(NATIVE_FETCH, port);
      const solver = new CaptchaSolver({
        capsolverApiKey: 'CAP-KEY', twocaptchaApiKey: '2C-KEY', pollIntervalMs: 1000,
        proxy: { type: 'http', address: '9.9.9.9', port: 8080, login: 'u', password: 'p' },
      }, silentLog);
      await solver.solveIfNeeded(fakePage(ARKOSE_HTML) as never, 5_000);
      restore();
      // A submissao e o POST em in.php; o polling posterior e GET em res.php.
      const form = new URLSearchParams(seen.find(entry => entry.url.includes('in.php'))?.body ?? '');
      assert.equal(form.get('method'), 'funcaptcha');
      assert.equal(form.get('proxy'), '9.9.9.9:8080');
      assert.equal(form.get('proxytype'), 'HTTP');
      assert.equal(form.get('publickey'), 'A2A14B1D-1AF3-C791-9BBC-EE33CC7A0A6F');
    });
});

test('2Captcha recebe proxy, proxytype e credenciais na submissao', async () => {
  await withServer(({ url }) => (url.includes('in.php') ? { status: 1, request: 'ID-1' } : { status: 1, request: 'TOKEN-Z' }),
    async (port, seen, restore) => {
      globalThis.fetch = redirect(NATIVE_FETCH, 'https://2captcha.com', port);
      const solver = new CaptchaSolver({
        twocaptchaApiKey: '2C-KEY', pollIntervalMs: 1000,
        proxy: { type: 'socks5', address: '8.8.8.8', port: 1080, login: 'user', password: 'pass' },
      }, silentLog);
      await solver.solveIfNeeded(fakePage(ARKOSE_HTML) as never, 5_000);
      restore();
      const form = new URLSearchParams(seen[0]?.body ?? '');
      assert.equal(form.get('method'), 'funcaptcha');
      assert.equal(form.get('proxy'), '8.8.8.8:1080');
      assert.equal(form.get('proxytype'), 'SOCKS5');
      assert.equal(form.get('proxylogin'), 'user');
      assert.equal(form.get('proxypassword'), 'pass');
    });
});

test('parseCaptchaProxy aceita os formatos do .env e recusa invalido', () => {
  assert.deepEqual(parseCaptchaProxy('1.2.3.4:8080'), { type: 'http', address: '1.2.3.4', port: 8080, login: undefined, password: undefined });
  assert.deepEqual(parseCaptchaProxy('u:p@1.2.3.4:8080'), { type: 'http', address: '1.2.3.4', port: 8080, login: 'u', password: 'p' });
  assert.deepEqual(parseCaptchaProxy('socks5://1.2.3.4:1080'), { type: 'socks5', address: '1.2.3.4', port: 1080, login: undefined, password: undefined });
  assert.equal(parseCaptchaProxy(undefined), undefined);
  assert.equal(parseCaptchaProxy('  '), undefined);
  assert.throws(() => parseCaptchaProxy('1.2.3.4'), /host:porta/);
});

test('classifyProviderError distingue saldo, chave e timeout', () => {
  assert.equal(classifyProviderError('ERROR_ZERO_BALANCE').code, 'zero-balance');
  assert.equal(classifyProviderError('ERROR_KEY_DOES_NOT_EXIST').code, 'invalid-key');
  assert.equal(classifyProviderError('CAPCHA_NOT_READY').code, 'timeout');
  assert.equal(classifyProviderError('algo estranho').code, 'provider-error');
});
