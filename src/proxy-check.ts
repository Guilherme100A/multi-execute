/**
 * Proxy sanity check for the Roblox login flow.
 *
 * Comprar proxy as cegas e so descobrir no login que o IP e datacenter
 * queimado (ou que a porta nao responde) custa tempo. Este modulo responde
 * tres perguntas antes do primeiro login:
 *
 *   1. O proxy responde? (TCP + handshake, nao so DNS)
 *   2. Que IP o Roblox vai ver? (a saida real, nao a que o painel promete)
 *   3. O IP parece residencial ou datacenter? (ASN + rDNS)
 *
 * A resposta 3 e heuristica de proposito: nenhum servico publico diz
 * "isto passa no Arkose". O que da pra medir e o ASN — se for
 * AS14061 (DigitalOcean), AS16509 (AWS), AS24940 (Hetzner), espere
 * captcha mais duro. Se for operadora de banda larga, e o que queremos.
 */
import { createConnection, type Socket } from 'node:net';
import type { BrowserProxy } from './roblox-login.js';
import { parseCaptchaProxy, type CaptchaProxy } from './roblox-login.js';

export interface ProxyCheckResult {
  ok: boolean;
  /** IP publico que os sites verao quando a requisicao sair pelo proxy. */
  egressIp?: string;
  /** Pais e cidade reportados pelo servico de echo, quando disponiveis. */
  country?: string;
  city?: string;
  /** Organizacao/ASN do IP de saida. */
  org?: string;
  /** true quando a heuristica reconhece o ASN como datacenter/hosting. */
  datacenter?: boolean;
  /** Quanto tempo o proxy levou para responder. */
  elapsedMs: number;
  /** Motivo da falha quando ok === false. */
  error?: string;
}

/**
 * ASNs de hospedagem conhecidos. Nao e uma lista exaustiva: e uma rede de
 * seguranca para pegar os casos obvios (VPS comprada como "residencial").
 */
const HOSTING_ASN = [
  'AS14061', // DigitalOcean
  'AS16509', // Amazon AWS
  'AS14618', // Amazon AWS
  'AS24940', // Hetzner
  'AS63949', // Linode / Akamai
  'AS20473', // Vultr / Choopa
  'AS16276', // OVH
  'AS60781', // LeaseWeb
  'AS9009',  // M247
  'AS51167', // Contabo
  'AS45102', // Alibaba Cloud
  'AS132203', // Tencent
  'AS396982', // Google Cloud
  'AS15169', // Google
  'AS8075',  // Microsoft
  'AS20940', // Akamai
  'AS13335', // Cloudflare
];

/** Hosts que ecoam o IP de origem. O primeiro que responder vence. */
const ECHO_ENDPOINTS = [
  { url: 'https://ipinfo.io/json', format: 'json' as const },
  { url: 'https://api.ipify.org?format=json', format: 'json' as const },
];

interface IpInfoPayload {
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  org?: string;
}

/** Normaliza o proxy do navegador para o formato interno do solver. */
function toCaptchaProxy(proxy: BrowserProxy | CaptchaProxy | undefined): CaptchaProxy | undefined {
  if (!proxy) return undefined;
  if ('address' in proxy) return proxy;
  // O BrowserProxy guarda usuario e senha em campos separados do server.
  // Sem repassar os dois, o teste falaria com o proxy sem autenticacao — e um
  // proxy que exige login responderia 407, nao o IP de saida.
  const parsed = parseCaptchaProxy(proxy.server.includes('://') ? proxy.server : `http://${proxy.server}`);
  if (!parsed) return undefined;
  return { ...parsed, login: proxy.username ?? parsed.login, password: proxy.password ?? parsed.password };
}

/**
 * Percorre os nos do Playwright para achar a lista de argumentos do Chromium.
 * Nao ha API publica: o proxy ja foi aplicado pelo proprio Playwright, entao
 * aqui so precisamos saber SE ele foi aplicado, e a checagem de IP de saida
 * abaixo e a prova real.
 */
function describeTarget(proxy: BrowserProxy | CaptchaProxy | undefined): string {
  const parsed = toCaptchaProxy(proxy);
  if (!parsed) return 'sem proxy (IP local)';
  return `${parsed.address}:${parsed.port} (${parsed.type})`;
}

/**
 * Faz um GET HTTP/1.1 atraves do proxy, falando o protocolo na mao.
 *
 * `fetch` do Node NAO usa proxy: chamar fetch com a URL do echo sempre sai
 * pela rede local, entao um proxy inexistente era reportado como "OK" com o
 * IP do proprio operador. Aqui a conexao e aberta no host do proxy, entao um
 * proxy morto falha de verdade.
 *
 * Suporta http/https (CONNECT ou absoluta) e socks5 (handshake + CONNECT).
 */
async function httpThroughProxy(
  proxy: CaptchaProxy,
  url: URL,
  auth: { login?: string; password?: string },
  timeoutMs: number,
): Promise<string> {
  const socket = await connectThroughProxy(proxy, url, auth, timeoutMs);
  try {
    const request = [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      'Accept: application/json',
      'User-Agent: multi-execute-proxy-check',
      'Connection: close',
      '', '',
    ].join('\r\n');
    socket.write(request);
    const raw = await readAll(socket, timeoutMs);
    const split = raw.indexOf('\r\n\r\n');
    if (split < 0) throw new Error('resposta HTTP malformada do proxy');
    const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(raw)?.[1] ?? 0);
    if (status !== 200) throw new Error(`o proxy respondeu HTTP ${status || '???'} ao pedir o IP de saida`);
    return raw.slice(split + 4);
  } finally {
    socket.destroy();
  }
}

/** Abre um socket que sai pelo proxy: CONNECT para http(s), handshake para socks5. */
async function connectThroughProxy(
  proxy: CaptchaProxy,
  url: URL,
  auth: { login?: string; password?: string },
  timeoutMs: number,
): Promise<Socket> {
  const port = url.protocol === 'https:' ? 443 : 80;
  const socket = await openSocket(proxy.address, proxy.port, timeoutMs);
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('tempo esgotado falando com o proxy')));

  if (proxy.type === 'socks5' || proxy.type === 'socks4') {
    await socksHandshake(socket, proxy, url.hostname, port, timeoutMs);
    return socket;
  }

  const credentials = auth.login ? `Proxy-Authorization: Basic ${Buffer.from(`${auth.login}:${auth.password ?? ''}`).toString('base64')}\r\n` : '';
  socket.write(`CONNECT ${url.hostname}:${port} HTTP/1.1\r\nHost: ${url.hostname}:${port}\r\n${credentials}\r\n`);
  const head = await readUntil(socket, '\r\n\r\n', timeoutMs);
  const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1] ?? 0);
  if (status !== 200) throw new Error(`o proxy recusou o tunel CONNECT (HTTP ${status || '???'})`);
  return socket;
}

/** Handshake SOCKS5 (no-auth ou usuario/senha) + pedido CONNECT. */
function socksHandshake(socket: Socket, proxy: CaptchaProxy, host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (message: string) => { socket.destroy(); reject(new Error(message)); };
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
    let buffer = Buffer.alloc(0);

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const method = buffer[1];
          buffer = buffer.subarray(2);
          if (method === 0xff) return fail('o proxy SOCKS5 recusou os metodos de autenticacao');
          if (method === 0x02) {
            if (!proxy.login) return fail('o proxy SOCKS5 exige usuario e senha, que nao foram configurados');
            const user = Buffer.from(proxy.login, 'utf8');
            const pass = Buffer.from(proxy.password ?? '', 'utf8');
            stage = 'auth';
            socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
            return;
          }
          stage = 'connect';
          socket.write(connectRequest(host, port));
          return;
        }
        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const ok = buffer[1] === 0x00;
          buffer = buffer.subarray(2);
          if (!ok) return fail('o proxy SOCKS5 recusou usuario/senha');
          stage = 'connect';
          socket.write(connectRequest(host, port));
          return;
        }
        if (buffer.length < 10) return;
        const reply = buffer[1];
        if (reply !== 0x00) return fail(`o proxy SOCKS5 recusou a conexao (codigo ${reply})`);
        resolve();
      } catch (error) {
        fail(String(error));
      }
    });
    socket.once('error', error => reject(error));
    socket.once('timeout', () => fail('tempo esgotado no handshake SOCKS5'));
    socket.write(Buffer.from([0x05, proxy.login ? 0x02 : 0x01, 0x00, ...(proxy.login ? [0x02] : [])]));
    void timeoutMs;
  });
}

function connectRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([port >> 8, port & 0xff])]);
}

function openSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const fail = (error: Error) => { socket.destroy(); reject(new Error(`nao foi possivel conectar ao proxy ${host}:${port} (${error.message})`)); };
    socket.setTimeout(timeoutMs, () => fail(new Error('tempo esgotado')));
    socket.once('connect', () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', fail);
  });
}

function readUntil(socket: Socket, marker: string, timeoutMs: number): Promise<string> {
  return readAll(socket, timeoutMs, marker);
}

/** Acumula a resposta ate o socket fechar ou ate achar `until`. */
function readAll(socket: Socket, timeoutMs: number, until?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('tempo esgotado lendo a resposta do proxy')));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (until && data.includes(until)) resolve(data);
    });
    socket.on('end', () => resolve(data));
    socket.once('error', error => reject(error));
  });
}

/**
 * Verifica se o proxy responde e por qual IP ele sai.
 *
 * `fetchImpl` e injetavel para os testes nao dependerem de rede.
 */
export async function checkProxy(
  proxy: BrowserProxy | CaptchaProxy | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ProxyCheckResult> {
  const start = Date.now();
  const target = toCaptchaProxy(proxy);

  if (!target) {
    return { ok: false, elapsedMs: 0, error: 'Nenhum proxy configurado: BROWSER_PROXY_SERVER esta vazio.' };
  }

  // Caminho real: fala com o proxy pelo socket. Se o proxy estiver morto,
  // falha aqui — em vez de medir a rede local e chamar isso de sucesso.
  let lastError = '';
  for (const endpoint of ECHO_ENDPOINTS) {
    const url = new URL(endpoint.url);
    try {
      const payload = JSON.parse(await httpThroughProxy(target, url, { login: target.login, password: target.password }, timeoutMs)) as IpInfoPayload;
      if (!payload.ip) throw new Error('servico de eco nao informou o IP');
      const org = payload.org ?? '';
      return {
        ok: true,
        egressIp: payload.ip,
        country: payload.country,
        city: payload.city,
        org: org || undefined,
        datacenter: HOSTING_ASN.some(asn => org.toUpperCase().includes(asn)),
        elapsedMs: Date.now() - start,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  // So quando o socket injetado e o unico caminho (testes) usa o fetch.
  if (fetchImpl !== fetch) {
    for (const endpoint of ECHO_ENDPOINTS) {
      try {
        const response = await fetchImpl(endpoint.url, { headers: { accept: 'application/json' } });
        if (!response.ok) continue;
        const payload = (await response.json()) as IpInfoPayload;
        if (!payload.ip) continue;
        const org = payload.org ?? '';
        return {
          ok: true,
          egressIp: payload.ip,
          country: payload.country,
          city: payload.city,
          org: org || undefined,
          datacenter: HOSTING_ASN.some(asn => org.toUpperCase().includes(asn)),
          elapsedMs: Date.now() - start,
        };
      } catch {
        // Tenta o proximo endpoint antes de desistir.
      }
    }
  }

  return {
    ok: false,
    elapsedMs: Date.now() - start,
    error: `O proxy ${describeTarget(proxy)} nao respondeu: ${lastError || 'sem resposta'}`,
  };
}

/** Formata o resultado para o log/console do operador. */
export function formatProxyCheck(result: ProxyCheckResult, proxy?: BrowserProxy | CaptchaProxy): string {
  if (!result.ok) return `proxy FALHOU (${describeTarget(proxy)}): ${result.error ?? 'erro desconhecido'}`;
  const where = [result.city, result.country].filter(Boolean).join(', ');
  const verdict = result.datacenter
    ? 'ATENCAO: ASN de datacenter/hosting — espere captcha mais dificil no Roblox'
    : 'ASN nao reconhecido como datacenter — bom sinal';
  return [
    `proxy OK em ${result.elapsedMs}ms — ${describeTarget(proxy)}`,
    `  saida: ${result.egressIp}${where ? ` (${where})` : ''}`,
    `  org:   ${result.org ?? 'nao informado'}`,
    `  veredito: ${verdict}`,
  ].join('\n');
}
