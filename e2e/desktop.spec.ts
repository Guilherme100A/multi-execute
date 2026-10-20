import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

test('desktop setup persists, loads the dashboard and releases its server on exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'multi-execute-desktop-'));
  const clientFile = join(directory, 'GlobalBasicSettings_13.xml');
  const clientXml = '<roblox><Item class="UserGameSettings"><Properties><int name="FramerateCap">-1</int><float name="MasterVolume">0.5</float><bool name="Fullscreen">false</bool><token name="SavedQualityLevel">10</token></Properties></Item></roblox>';
  await writeFile(clientFile, clientXml);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = String(address.port);
  await new Promise<void>(resolve => server.close(() => resolve()));
  const env = Object.fromEntries(Object.entries({ ...process.env,
    MULTI_EXECUTE_DATA_DIR: directory,
    AUTO_CONNECT: 'false', AUTHORIZED_PLACE_IDS: '', PORT: port, HOST: '127.0.0.1',
    DB_PATH: join(directory, 'data', 'sessions.sqlite'),
    DIRECT_ACCOUNTS_FILE: join(directory, 'data', 'accounts.dpapi'),
    LOG_DIRECTORY: join(directory, 'logs'), FINDINGS_DIRECTORY: join(directory, 'findings'),
    ROBLOX_SETTINGS_FILE: clientFile,
  }).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>;
  const executablePath = process.env.DESKTOP_TEST_EXECUTABLE;
  const launch = async () => {
    const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [resolve('.')], env, timeout: 30000 });
    return application;
  };
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow({ timeout: 15000 });
    const windowState = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      return { bounds: window.getBounds(), maximized: window.isMaximized(), menu: window.isMenuBarVisible() };
    });
    expect(windowState.bounds.width).toBeLessThanOrEqual(900);
    expect(windowState.bounds.height).toBeLessThanOrEqual(550);
    expect(windowState.maximized).toBe(false);
    expect(windowState.menu).toBe(false);
    await expect(page.locator('h1')).toHaveText('Configuração do Multi Execute');
    await page.locator('#places').fill('invalid-id');
    await page.locator('#save').click();
    await expect(page.locator('#error')).toContainText('6 e 15');
    await page.locator('#places').fill('123456789');
    await page.locator('#save').click();
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
    await expect(page.locator('#groupGame')).toBeAttached();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    await expect(page.locator('html')).toHaveCSS('scrollbar-width', 'none');
    await expect(page.locator('#feedState')).toHaveClass(/online/);
    const navigation = await page.locator('.app-nav').boundingBox();
    const content = await page.locator('#accountsView').boundingBox();
    expect(navigation!.x + navigation!.width).toBeLessThan(content!.x);
    await page.getByRole('button', { name: 'Configurações', exact: true }).click();
    await expect(page.locator('#places')).toHaveValue('123456789');
    await page.locator('#save').click();
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
    await expect(page.locator('#feedState')).toHaveClass(/online/);
    expect(JSON.parse(await readFile(join(directory, 'app-config.json'), 'utf8'))).toEqual({ authorizedPlaceIds: ['123456789'] });
    const config = await (await fetch(`http://127.0.0.1:${port}/config`)).json();
    expect(config.accounts).toEqual([]);
    await page.getByRole('button', { name: 'Setup', exact: true }).click();
    await expect(page.locator('#setupItems .setup-item')).toHaveCount(10);
    await expect(page.locator('#setupItems')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#setupItems')).toContainText('Roblox Player');
    await expect(page.locator('#setupItems')).toContainText('Contas de teste');
    let checks = 0;
    page.on('request', request => { if (request.url().endsWith('/setup-check')) checks++; });
    await page.getByRole('button', { name: 'Verificar novamente', exact: true }).click();
    await expect.poll(() => checks).toBe(1);
    await expect(page.locator('#setupItems')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#setupCheckedAt')).toContainText('Última verificação');
    await page.getByRole('button', { name: 'Configurações Roblox', exact: true }).click();
    await expect(page.locator('#robloxNativeStatus')).toContainText('Atual no Roblox');
    await page.locator('#rbFps').selectOption('120');
    await page.locator('#rbRecentLimit').fill('4');
    await page.locator('#robloxSave').click();
    await expect(page.locator('#robloxSettingsMessage')).toContainText('Preferências salvas');
    expect(await readFile(clientFile, 'utf8')).toBe(clientXml);
    expect(JSON.parse(await readFile(join(directory, 'roblox-settings.json'), 'utf8')).fpsCap).toBe(120);
    await page.locator('#robloxRamImport').setInputFiles({name:'RAMSettings.ini',mimeType:'text/plain',buffer:Buffer.from('[General]\nUnlockFPS=true\nMaxFPSValue=144\nDisableImages=true\nMaxRecentGames=5\n[WebServer]\nPassword=not-imported')});
    await expect(page.locator('#robloxImportMessage')).toContainText('3 opção');
    await expect(page.locator('#rbFps')).toHaveValue('144');
    await page.locator('#robloxSave').click();
    await expect(page.locator('html')).toHaveClass(/hide-interface-images/);
    expect(await readFile(join(directory, 'roblox-settings.json'), 'utf8')).not.toContain('not-imported');
    await page.getByRole('button', { name: 'Agentes', exact: true }).click();
    await expect(page.locator('#agentsHeading')).toHaveText('Agentes');
    await expect(page.locator('#agentProvider option')).toHaveCount(2);
    await page.locator('#policyContent').fill('# AGENTS.md\n\nInstruções compartilhadas de teste.');
    await page.locator('#saveAgentPolicy').click();
    await expect(page.locator('#policyMessage')).toContainText('AGENTS.md salvo');
    const sharedPolicy = await (await fetch(`http://127.0.0.1:${port}/agent-policy`)).json();
    expect(sharedPolicy.policy.filename).toBe('AGENTS.md');
    expect(sharedPolicy.policy.content).toBe('# AGENTS.md\n\nInstruções compartilhadas de teste.');
    await page.locator('#policyFile').setInputFiles({name:'AGENTS.md',mimeType:'text/markdown',buffer:Buffer.from('# AGENTS.md\n\nArquivo de instruções importado.')});
    await page.locator('#saveAgentPolicy').click();
    await expect(page.locator('#policyMessage')).toContainText('AGENTS.md salvo');
    const desktopLog = await readFile(join(directory, 'logs', 'desktop.jsonl'), 'utf8');
    expect(desktopLog).toContain('desktop_started');
    expect(desktopLog).toContain('backend_started');
    expect(desktopLog).toContain('settings_or_startup_failed');
    expect(desktopLog).not.toContain('window_shape_failed');
    await page.screenshot({ path: test.info().outputPath('desktop-setup.png'), animations: 'disabled' });
    const nativeScreenshot = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const bounds = window.getBounds();
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: bounds.width, height: bounds.height } });
      return sources.find(source => source.id === window.getMediaSourceId())?.thumbnail.toPNG().toString('base64');
    });
    if (nativeScreenshot) await writeFile(test.info().outputPath('desktop-native.png'), Buffer.from(nativeScreenshot, 'base64'));
    await app.close();
    app = undefined;
    await expect.poll(async () => {
      try { await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) }); return false; }
      catch { return true; }
    }).toBe(true);
    app = await launch();
    page = await app.firstWindow({ timeout: 15000 });
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
    await expect(page.locator('#groupGame')).toBeAttached();
    await page.getByRole('button', { name: 'Configurações Roblox', exact: true }).click();
    await expect(page.locator('#rbFps')).toHaveValue('144');
    await page.getByRole('button', { name: 'Agentes', exact: true }).click();
    await expect(page.locator('#policyContent')).toHaveValue('# AGENTS.md\n\nArquivo de instruções importado.');
    await app.close();
    app = undefined;
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
