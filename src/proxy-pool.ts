/**
 * Pool de proxies com sessao sticky por conta.
 *
 * O login tem tres passos que precisam sair do MESMO IP: carregar a pagina,
 * resolver o captcha e submeter o login. Proxy rotativo puro troca de IP no
 * meio disso e o token e recusado. Por isso cada conta ganha um ID de sessao
 * estavel, derivado do alias: a mesma conta sempre cai no mesmo IP de saida,
 * e contas diferentes caem em IPs diferentes.
 *
 * Testado contra o formato documentado da Proxy-Seller
 * (docs.proxy-seller.com/api-v2/residential-proxy/connect-target-via-login):
 *
 *   xxx_c_BR_s_alpha_ttl_15m
 *    |   |      |     |
 *    |   |      |     +-- TTL: precisa vir DEPOIS do _s_
 *    |   |      +-------- sessao: mesmo id = mesmo IP
 *    |   +--------------- pais (ISO 3166-1, case-sensitive)
 *    +------------------- credencial base
 */
import { createHash } from 'node:crypto';
import type { BrowserProxy } from './roblox-login.js';

export interface ProxyPoolConfig {
  /** Host do provedor, ex.: res.proxy-seller.com */
  host: string;
  /** Porta. 10000-10999 (Proxy-Seller): cada porta = um IP de saida distinto. */
  port: number;
  /** Credencial base, sem sufixos. */
  username: string;
  password: string;
  /** Pais alvo no formato ISO 3166-1 alpha-2, ex.: "BR". */
  country?: string;
  /** TTL da sessao sticky. Precisa cobrir o login inteiro (5-10 min minimo). */
  ttl?: string;
  /** Esquema do proxy. A Proxy-Seller auto-detecta HTTPS/SOCKS5 na mesma porta. */
  scheme?: 'http' | 'socks5';
}

/**
 * Deriva um id de sessao estavel a partir do alias da conta.
 *
 * Deterministico de proposito: a mesma conta sempre recebe o mesmo id, e
 * portanto o mesmo IP de saida, sem precisar guardar estado em disco. O hash
 * evita que o id exponha o alias no login do proxy.
 */
export function sessionIdFor(alias: string): string {
  return createHash('sha256').update(alias.trim().toLowerCase()).digest('hex').slice(0, 12);
}

/** Monta o login com sufixos na ordem documentada: pais, sessao, TTL. */
export function buildProxyLogin(config: ProxyPoolConfig, alias: string): string {
  const parts = [config.username];
  if (config.country) parts.push(`_c_${config.country.toUpperCase()}`);
  parts.push(`_s_${sessionIdFor(alias)}`);
  if (config.ttl) parts.push(`_ttl_${config.ttl}`);
  return parts.join('');
}

/**
 * Proxy da conta: mesmo IP de saida em toda a janela de login.
 * Devolve undefined quando nao ha pool configurado, preservando o
 * comportamento manual anterior.
 */
export function proxyForAccount(config: ProxyPoolConfig | undefined, alias: string): BrowserProxy | undefined {
  if (!config) return undefined;
  const scheme = config.scheme ?? 'http';
  // Playwright so aceita username/password em proxy HTTP. Em SOCKS5 os campos
  // existem na API mas sao descartados em silencio, e o login do proxy chega
  // sem credencial: a conexao falha, ou pior, cai num IP sem sessao sticky —
  // que e justamente o que queima o solve e a conta.
  if (scheme === 'socks5') {
    throw new Error(
      'PROXY_SCHEME=socks5 nao suporta credenciais no Playwright. Use PROXY_SCHEME=http ' +
        '(a Proxy-Seller atende HTTP e SOCKS5 na mesma porta).',
    );
  }
  return {
    server: `${scheme}://${config.host}:${config.port}`,
    username: buildProxyLogin(config, alias),
    password: config.password,
  };
}

function port(value: string | undefined, fallback = 10000): number {
  const parsed = Number(value?.trim() ?? '');
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

/**
 * Le a configuracao do pool do ambiente.
 *
 * Variaveis: PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD,
 * PROXY_COUNTRY, PROXY_TTL, PROXY_SCHEME.
 *
 * Sem PROXY_HOST o pool fica desligado e o login continua usando
 * BROWSER_PROXY_SERVER (um proxy unico para todas as contas).
 */
export function loadProxyPool(env: Record<string, string | undefined> = process.env): ProxyPoolConfig | undefined {
  const host = env.PROXY_HOST?.trim();
  const username = env.PROXY_USERNAME?.trim();
  const password = env.PROXY_PASSWORD;
  if (!host) {
    if (username || password) throw new Error('PROXY_HOST e obrigatorio quando ha credenciais de pool configuradas');
    return undefined;
  }
  if (!username) throw new Error('PROXY_USERNAME e obrigatorio quando PROXY_HOST esta definido');
  if (password === undefined) throw new Error('PROXY_PASSWORD e obrigatorio quando PROXY_HOST esta definido');
  if (/[\s_]/i.test(host)) throw new Error('PROXY_HOST nao pode conter espacos nem underscores');

  const scheme = env.PROXY_SCHEME?.trim().toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'socks5') throw new Error('PROXY_SCHEME deve ser http ou socks5');

  const country = env.PROXY_COUNTRY?.trim();
  if (country && !/^[A-Za-z]{2}$/.test(country)) throw new Error('PROXY_COUNTRY deve ter 2 letras (ISO 3166-1), ex.: BR');

  const ttl = env.PROXY_TTL?.trim();
  if (ttl && !/^\d+[smh]$/.test(ttl)) throw new Error('PROXY_TTL deve ser numero + s/m/h, ex.: 15m');

  return {
    host, port: port(env.PROXY_PORT), username, password,
    country: country?.toUpperCase(),
    ttl,
    scheme: (scheme as 'http' | 'socks5' | undefined) ?? 'http',
  };
}
