import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProxy, formatProxyCheck } from '../src/proxy-check.js';

const IPINFO_JSON = { ip: '203.0.113.7', city: 'Sao Paulo', region: 'SP', country: 'BR', org: 'AS27699 TELEFONICA BRASIL S.A.' };
const HOSTING_JSON = { ip: '198.51.100.9', country: 'US', org: 'AS14061 DigitalOcean, LLC' };

function respondWith(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

test('proxy residencial: reporta IP de saida e nao marca datacenter', async () => {
  const result = await checkProxy({ server: 'http://1.2.3.4:8080' }, respondWith(IPINFO_JSON));
  assert.equal(result.ok, true);
  assert.equal(result.egressIp, '203.0.113.7');
  assert.equal(result.country, 'BR');
  assert.equal(result.city, 'Sao Paulo');
  assert.equal(result.datacenter, false);
  assert.match(formatProxyCheck(result, { server: 'http://1.2.3.4:8080' }), /saida: 203\.0\.113\.7/);
});

test('proxy de datacenter: marca datacenter pelo ASN', async () => {
  const result = await checkProxy({ server: 'http://1.2.3.4:8080' }, respondWith(HOSTING_JSON));
  assert.equal(result.ok, true);
  assert.equal(result.datacenter, true);
  assert.match(formatProxyCheck(result, { server: 'http://1.2.3.4:8080' }), /ATENCAO/);
});

test('sem proxy configurado: falha com mensagem explicita, nao com silencio', async () => {
  const result = await checkProxy(undefined, respondWith(IPINFO_JSON));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /BROWSER_PROXY_SERVER/);
  assert.match(formatProxyCheck(result), /FALHOU/);
});

test('proxy que nao responde: falha sem estourar excecao', async () => {
  const failing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const result = await checkProxy({ server: 'http://1.2.3.4:8080' }, failing);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /nao respondeu/);
});

test('primeiro endpoint fora do ar cai para o segundo', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) throw new Error('timeout');
    return { ok: true, json: async () => IPINFO_JSON };
  }) as unknown as typeof fetch;
  const result = await checkProxy({ server: 'http://1.2.3.4:8080' }, flaky);
  assert.equal(result.ok, true);
  assert.equal(result.egressIp, '203.0.113.7');
  assert.equal(calls, 2);
});

test('aceita CaptchaProxy direto e o formato usuario:senha@host:porta', async () => {
  const result = await checkProxy({ type: 'socks5', address: '5.6.7.8', port: 1080, login: 'u', password: 'p' }, respondWith(IPINFO_JSON));
  assert.equal(result.ok, true);
  assert.match(formatProxyCheck(result, { type: 'socks5', address: '5.6.7.8', port: 1080 }), /5\.6\.7\.8:1080 \(socks5\)/);
});

test('resposta sem ip e tratada como endpoint inutil, nao como sucesso', async () => {
  const result = await checkProxy({ server: 'http://1.2.3.4:8080' }, respondWith({ country: 'BR' }));
  assert.equal(result.ok, false);
});
