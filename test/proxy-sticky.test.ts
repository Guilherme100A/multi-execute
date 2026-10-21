/**
 * O login da Proxy-Seller carrega a sessao sticky no proprio username
 * (xxx_c_BR_s_<id>_ttl_15m). Se qualquer camada cortar, normalizar ou perder
 * esse sufixo, a conta cai num IP aleatorio a cada requisicao — e o captcha
 * resolve num IP enquanto o login chega de outro. Estes testes travam o
 * caminho inteiro: montagem -> proxy do navegador -> credencial do solver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyLogin, proxyForAccount, sessionIdFor, type ProxyPoolConfig } from '../src/proxy-pool.js';
import { parseCaptchaProxy } from '../src/roblox-login.js';

const POOL: ProxyPoolConfig = {
  host: 'res.proxy-seller.com', port: 10000,
  username: 'cred', password: 'segredo', country: 'BR', ttl: '15m',
};

test('o sufixo de sessao sobrevive ao parser com credenciais embutidas', () => {
  const login = buildProxyLogin(POOL, 'alpha');
  const parsed = parseCaptchaProxy(`http://${login}:segredo@res.proxy-seller.com:10000`);
  assert.equal(parsed?.login, login, 'o login inteiro precisa chegar ao proxy, com _s_ e _ttl_');
  assert.equal(parsed?.password, 'segredo');
  assert.equal(parsed?.address, 'res.proxy-seller.com');
  assert.equal(parsed?.port, 10000);
});

test('o sufixo de sessao nao e confundido com a porta nem com o host', () => {
  const login = buildProxyLogin(POOL, 'alpha');
  const parsed = parseCaptchaProxy(`http://${login}:segredo@res.proxy-seller.com:10000`);
  assert.ok(!parsed?.address.includes('_s_'), 'host nao pode absorver o sufixo');
  assert.ok(!String(parsed?.port).includes('_'), 'porta nao pode absorver o sufixo');
});

test('o login montado nunca contem dois-pontos (quebraria o parser)', () => {
  for (const alias of ['alpha', 'beta', 'conta-com-hifen', 'conta_com_underline']) {
    assert.ok(!buildProxyLogin(POOL, alias).includes(':'), `alias ${alias} gerou login com ":"`);
  }
});

test('o proxy do navegador preserva usuario e senha em campos separados', () => {
  const proxy = proxyForAccount(POOL, 'alpha');
  assert.equal(proxy?.server, 'http://res.proxy-seller.com:10000');
  assert.match(proxy?.username ?? '', /_s_[0-9a-f]{12}_ttl_15m$/);
  const parsed = parseCaptchaProxy(proxy!.server);
  assert.equal(parsed?.login, undefined, 'o server sozinho nao tem credencial — quem as carrega e o BrowserProxy');
});

test('sessao derivada e estavel entre execucoes e distinta por conta', () => {
  const first = sessionIdFor('alpha');
  const second = sessionIdFor('alpha');
  assert.equal(first, second);
  assert.notEqual(first, sessionIdFor('beta'));
  assert.match(first, /^[0-9a-f]{12}$/, 'id alfanumerico aceito pela Proxy-Seller');
});
