import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

process.loadEnvFile('.env');
const accounts = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? 'accounts.json', 'utf8')) as { alias: string }[];
const links = [
  'https://www.roblox.com/games/107778070777162/Steal-An-Egg',
  'https://www.roblox.com/games/134719268825886/Clicker-Simulator',
];

test('links open both games, connect workers automatically, and return real worker responses', async ({ page }, testInfo) => {
  if (accounts.length < 2) throw new Error('Configure two imported accounts before this live test');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('input[name="launchMode"][value="round-robin"]').check();
  await page.locator('#account').selectOption(accounts[0]!.alias);
  await page.locator('#game').fill(links.join('\n'));
  const launching = page.waitForResponse(response => response.url().endsWith('/launch-batch') && response.request().method() === 'POST');
  await page.locator('#launchButton').click();
  const response = await launching;
  expect(response.status()).toBe(202);
  const body = await response.json() as { sessions: { session: { id: string; worker_id: string; account_alias: string } }[] };
  expect(body.sessions).toHaveLength(2);
  const sessions = body.sessions.map(row => row.session);
  expect(new Set(sessions.map(row => row.worker_id)).size).toBe(2);
  for (const session of sessions) {
    await expect(page.locator(`#sessions .session[data-session-id="${session.id}"] .status`)).toHaveAttribute('data-status', 'connected', { timeout: 125_000 });
  }
  const bindings = await page.evaluate(async ids => {
    const result = await fetch('/status');
    const body = await result.json();
    return body.sessions.filter((row: { id: string }) => ids.includes(row.id)).map((row: { status: string; instance_id: string }) => ({ status: row.status, instance: row.instance_id }));
  }, sessions.map(row => row.id));
  expect(bindings.map(row => row.status)).toEqual(['connected', 'connected']);
  expect(new Set(bindings.map(row => row.instance)).size).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('both-workers-connected.png'), fullPage: true });
  await page.locator('[data-view="console"]').click();
  await page.locator('#prompt').fill('Teste de conexão somente leitura: use get-metadata e get-player no worker atribuído. Informe o PlaceId real e o nome da conta real encontrados. Não altere o jogo nem execute outras ações. Responda em português, de forma curta, com os valores observados.');
  const sending = page.waitForResponse(response => response.url().endsWith('/prompts') && response.request().method() === 'POST');
  await page.locator('#sendPrompt').click();
  const promptResponse = await sending;
  expect(promptResponse.status()).toBe(202);
  const submitted = await promptResponse.json() as { runs: { id: string; session_id: string }[] };
  expect(submitted.runs).toHaveLength(2);
  expect(submitted.runs.map(row => row.session_id).sort()).toEqual(sessions.map(row => row.id).sort());
  for (const session of sessions) {
    const terminal = page.locator(`.worker-terminal[data-session-id="${session.id}"]`);
    await expect(terminal.locator('.worker-terminal-output')).toContainText(session.account_alias, { timeout: 100_000 });
  }
  const promptIds = submitted.runs.map(row => row.id);
  await expect.poll(async () => page.evaluate(async ids => {
    const result = await fetch('/prompts');
    const body = await result.json();
    return body.runs.filter((row: { id: string }) => ids.includes(row.id)).map((row: { status: string }) => row.status).sort();
  }, promptIds), { timeout: 100_000, intervals: [2000, 5000] }).toEqual(['done', 'done']);
  const completed = await page.evaluate(async ids => {
    const result = await fetch('/prompts');
    const body = await result.json();
    return body.runs.filter((row: { id: string }) => ids.includes(row.id)) as { session_id: string; response: string }[];
  }, promptIds);
  for (const [index, session] of sessions.entries()) {
    const result = completed.find(row => row.session_id === session.id);
    expect(result?.response).toContain(accounts[index]!.alias);
    expect(result?.response).toContain(links[index]!.match(/games\/(\d+)/)![1]);
    expect(result?.response).not.toMatch(/requires approval|but approval policy is never|não foi possível observar/i);
  }
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('both-worker-responses.png'), fullPage: true });
});
