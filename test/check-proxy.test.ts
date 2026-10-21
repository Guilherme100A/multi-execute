import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/check-proxy.js';

test('sem proxy configurado o comando explica como configurar e falha', async () => {
  const names = ['BROWSER_PROXY_SERVER', 'BROWSER_PROXY_USERNAME', 'BROWSER_PROXY_PASSWORD'] as const;
  const saved = names.map(name => [name, process.env[name]] as const);
  for (const [name] of saved) delete process.env[name];

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  let code: number;
  try {
    code = await main([]);
  } finally {
    console.error = originalError;
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }

  assert.equal(code, 1);
  assert.match(errors.join('\n'), /BROWSER_PROXY_SERVER/);
  assert.match(errors.join('\n'), /check:proxy/);
});

test('proxy invalido passado por argumento e recusado com mensagem clara', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  let code: number;
  try {
    code = await main(['isso-nao-e-proxy']);
  } finally {
    console.error = originalError;
  }

  assert.equal(code, 1);
  assert.match(errors.join('\n'), /host:porta/);
});
