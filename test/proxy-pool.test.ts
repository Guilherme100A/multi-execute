import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyLogin, loadProxyPool, proxyForAccount, sessionIdFor, type ProxyPoolConfig } from '../src/proxy-pool.js';

const POOL: ProxyPoolConfig = {
  host: 'res.proxy-seller.com', port: 10000,
  username: 'minhacredencial', password: 'segredo',
  country: 'BR', ttl: '15m',
};

test('monta o login no formato documentado da Proxy-Seller', () => {
  const login = buildProxyLogin(POOL, 'alpha');
  // xxx_c_BR_s_<id>_ttl_15m — ordem documentada: pais, sessao, TTL.
  assert.match(login, /^minhacredencial_c_BR_s_[0-9a-f]{12}_ttl_15m$/);
});

test('a mesma conta sempre cai no mesmo IP de saida', () => {
  assert.equal(sessionIdFor('alpha'), sessionIdFor('alpha'));
  assert.equal(sessionIdFor('Alpha'), sessionIdFor('alpha'), 'alias nao diferencia maiuscula');
  assert.equal(buildProxyLogin(POOL, 'alpha'), buildProxyLogin(POOL, 'alpha'));
});

test('contas diferentes caem em IPs diferentes', () => {
  const ids = ['alpha', 'beta', 'gamma', 'delta'].map(sessionIdFor);
  assert.equal(new Set(ids).size, 4, 'dois aliases nao podem compartilhar sessao');
});

test('o id de sessao nao expoe o alias no login do proxy', () => {
  assert.ok(!buildProxyLogin(POOL, 'minhaContaSecreta').includes('minhaContaSecreta'));
});

test('sem TTL nao emite sufixo _ttl_ (o sufixo so vale depois do _s_)', () => {
  const login = buildProxyLogin({ ...POOL, ttl: undefined }, 'alpha');
  assert.match(login, /^minhacredencial_c_BR_s_[0-9a-f]{12}$/);
  assert.ok(!login.includes('_ttl_'));
});

test('sem pais omite o _c_ em vez de mandar vazio', () => {
  const login = buildProxyLogin({ ...POOL, country: undefined }, 'alpha');
  assert.match(login, /^minhacredencial_s_[0-9a-f]{12}_ttl_15m$/);
});

test('proxyForAccount devolve servidor, login com sessao e senha', () => {
  const proxy = proxyForAccount(POOL, 'alpha');
  assert.equal(proxy?.server, 'http://res.proxy-seller.com:10000');
  assert.match(proxy?.username ?? '', /^minhacredencial_c_BR_s_[0-9a-f]{12}_ttl_15m$/);
  assert.equal(proxy?.password, 'segredo');
});

test('sem pool configurado o login continua direto', () => {
  assert.equal(proxyForAccount(undefined, 'alpha'), undefined);
  assert.equal(loadProxyPool({}), undefined);
});

test('loadProxyPool le o ambiente e normaliza', () => {
  const pool = loadProxyPool({
    PROXY_HOST: 'res.proxy-seller.com', PROXY_PORT: '10005',
    PROXY_USERNAME: 'user', PROXY_PASSWORD: 'pass',
    PROXY_COUNTRY: 'br', PROXY_TTL: '15m', PROXY_SCHEME: 'socks5',
  });
  assert.equal(pool?.port, 10005);
  assert.equal(pool?.country, 'BR', 'pais sobe para maiuscula (ISO, case-sensitive na API)');
  assert.equal(pool?.scheme, 'socks5');
});

test('loadProxyPool usa porta 10000 quando ausente ou invalida', () => {
  const base = { PROXY_HOST: 'h', PROXY_USERNAME: 'u', PROXY_PASSWORD: 'p' };
  assert.equal(loadProxyPool(base)?.port, 10000);
  assert.equal(loadProxyPool({ ...base, PROXY_PORT: 'abc' })?.port, 10000);
  assert.equal(loadProxyPool({ ...base, PROXY_PORT: '99999' })?.port, 10000);
});

test('loadProxyPool recusa configuracao incompleta ou malformada', () => {
  assert.throws(() => loadProxyPool({ PROXY_USERNAME: 'u' }), /PROXY_HOST/);
  assert.throws(() => loadProxyPool({ PROXY_HOST: 'h' }), /PROXY_USERNAME/);
  assert.throws(() => loadProxyPool({ PROXY_HOST: 'h', PROXY_USERNAME: 'u' }), /PROXY_PASSWORD/);
  assert.throws(() => loadProxyPool({ PROXY_HOST: 'h', PROXY_USERNAME: 'u', PROXY_PASSWORD: 'p', PROXY_COUNTRY: 'BRA' }), /2 letras/);
  assert.throws(() => loadProxyPool({ PROXY_HOST: 'h', PROXY_USERNAME: 'u', PROXY_PASSWORD: 'p', PROXY_TTL: '15' }), /s\/m\/h/);
  assert.throws(() => loadProxyPool({ PROXY_HOST: 'h', PROXY_USERNAME: 'u', PROXY_PASSWORD: 'p', PROXY_SCHEME: 'ftp' }), /http ou socks5/);
});

test('socks5 falha alto: o Playwright descartaria a credencial em silencio', () => {
  // Sem esta trava o login do proxy sairia sem senha, a sessao sticky nunca
  // seria criada e o solve seria queimado num IP diferente do submit.
  assert.throws(() => proxyForAccount({ ...POOL, scheme: 'socks5' }, 'alpha'), /socks5 nao suporta credenciais/);
});

test('http explicito continua funcionando', () => {
  const proxy = proxyForAccount({ ...POOL, scheme: 'http' }, 'alpha');
  assert.equal(proxy?.server, 'http://res.proxy-seller.com:10000');
  assert.equal(proxy?.password, 'segredo');
});
