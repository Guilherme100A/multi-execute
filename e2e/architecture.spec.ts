import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

test('architecture diagram explains Project Real and MCP interactively on desktop and mobile', async ({ page }, info) => {
  const files: Record<string, [string, string]> = {
    '/architecture.html': ['public/architecture.html', 'text/html; charset=utf-8'],
    '/architecture.css': ['public/architecture.css', 'text/css; charset=utf-8'],
    '/architecture.js': ['public/architecture.js', 'text/javascript; charset=utf-8'],
  };
  const server = createServer((request, response) => {
    const file = files[request.url ?? ''];
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', file[1]); response.end(readFileSync(file[0]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
  try {
    await page.goto(`http://127.0.0.1:${address.port}/architecture.html`);
    await expect(page.getByRole('heading', { name: 'Project Real ↔ MCP, por dentro' })).toBeVisible();
    await expect(page.locator('.map-node')).toHaveCount(9);
    await expect(page.getByRole('heading', { name: 'Como a porta 28429 não mistura os Roblox' })).toBeVisible();
    await expect(page.locator('.session-route')).toHaveCount(3);
    await page.locator('[data-route="b"]').click();
    await expect(page.locator('#routeWorker')).toHaveText('Terminal B → conta2-c91e');
    await expect(page.locator('#routePath')).toContainText('canal #2');
    await expect(page.locator('.route-row.route-b')).toHaveClass(/active/);
    await page.locator('[data-step="real"]').last().click();
    await expect(page.locator('#detailTitle')).toHaveText('Project Real');
    await expect(page.locator('#detailGuarantee')).toContainText('PID');
    await page.screenshot({ path: info.outputPath('architecture-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('[data-step="proxy"]').click();
    await expect(page.locator('#detailTitle')).toHaveText('Proxy MCP por worker');
    await page.screenshot({ path: info.outputPath('architecture-mobile.png'), fullPage: true });
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
