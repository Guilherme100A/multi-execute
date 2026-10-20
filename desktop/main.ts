import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { startApplication, type RunningApplication } from '../src/runtime.js';
import { logDesktop } from './diagnostics.cjs';
import { roundedWindowShape } from './window-shape.js';

type DesktopSettings = { authorizedPlaceIds: string[] };

const userDataDirectory = process.env.MULTI_EXECUTE_DATA_DIR ?? join(app.getPath('appData'), 'Multi Execute');
mkdirSync(userDataDirectory, { recursive: true });
app.setPath('userData', userDataDirectory);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow: BrowserWindow | undefined;
let running: RunningApplication | undefined;
let startupError: string | null = null;
let quitting = false;
let starting = false;

const appRoot = app.getAppPath();
const setupFile = join(appRoot, 'desktop', 'setup.html');
const preloadFile = join(appRoot, 'dist', 'desktop', 'preload.cjs');
const setupUrl = pathToFileURL(setupFile).href;

function settingsFile(): string { return join(app.getPath('userData'), 'app-config.json'); }

function readSettings(): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<DesktopSettings>;
    return { authorizedPlaceIds: Array.isArray(parsed.authorizedPlaceIds) ? parsed.authorizedPlaceIds.filter(value => typeof value === 'string') : [] };
  } catch { return { authorizedPlaceIds: [] }; }
}

function writeSettings(settings: DesktopSettings): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const temporary = `${settingsFile()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(temporary, settingsFile());
}

function validatePlaces(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('Informe ao menos um PlaceId autorizado.');
  const ids = [...new Set(input.map(value => String(value).trim()).filter(Boolean))];
  if (!ids.length) throw new Error('Informe ao menos um PlaceId autorizado.');
  if (ids.some(value => !/^\d{6,15}$/.test(value))) throw new Error('Cada PlaceId deve conter entre 6 e 15 dígitos.');
  return ids;
}

function prepareEnvironment(settings: DesktopSettings): void {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const accounts = join(userData, 'accounts.json');
  if (!existsSync(accounts)) writeFileSync(accounts, '[]\n', { mode: 0o600 });
  process.env.APP_RESOURCE_ROOT = appRoot;
  process.env.APP_DATA_ROOT = userData;
  process.env.ACCOUNTS_FILE = accounts;
  process.env.PUBLIC_DIRECTORY = join(appRoot, 'public');
  process.env.BOOTSTRAP_FILE = join(userData, 'project-real-autoexec.lua');
  process.env.AUTHORIZED_PLACE_IDS = settings.authorizedPlaceIds.join(',');
  if (app.isPackaged) process.env.DIRECT_HELPER_FILE = join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'direct-roblox.ps1');
}

async function stopBackend(): Promise<void> {
  const active = running;
  running = undefined;
  await active?.close();
}

async function startBackend(settings: DesktopSettings): Promise<void> {
  prepareEnvironment(settings);
  await stopBackend();
  running = await startApplication(process.env);
  logDesktop('backend_started');
  startupError = null;
  await mainWindow?.loadURL(running.url);
}

async function showSettings(): Promise<void> {
  await mainWindow?.loadFile(setupFile);
}

function createWindow(): BrowserWindow {
  const available = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(900, Math.floor(available.width * .74));
  const height = Math.min(550, Math.floor(available.height * .72));
  const window = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(800, width),
    minHeight: Math.min(520, height),
    center: true,
    show: false,
    backgroundColor: '#000000',
    frame: false,
    thickFrame: false,
    hasShadow: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#bdbdbd', height: 38 },
    roundedCorners: true,
    accentColor: '#000000',
    icon: app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'desktop', 'icon.ico') : join(appRoot, 'desktop', 'icon.ico'),
    webPreferences: { preload: preloadFile, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const updateShape = () => {
    if (process.platform !== 'win32' || window.isDestroyed()) return;
    try {
      const { width, height } = window.getBounds();
      window.setShape(window.isMaximized() || window.isFullScreen() ? [] : roundedWindowShape(width, height));
    } catch (error) { logDesktop('window_shape_failed', error); }
  };
  updateShape();
  window.on('resize', updateShape);
  window.on('maximize', updateShape);
  window.on('unmaximize', updateShape);
  window.on('enter-full-screen', updateShape);
  window.on('leave-full-screen', updateShape);
  window.once('ready-to-show', () => window.show());
  window.webContents.on('preload-error', (_event, _path, error) => logDesktop('preload_failed', error));
  window.webContents.on('render-process-gone', (_event, details) => {
    logDesktop('renderer_stopped', new Error(`${details.reason} (exit ${details.exitCode})`));
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = url === setupUrl ||
      (running !== undefined && new URL(url).origin === running.url);
    if (!allowed) { event.preventDefault(); if (/^https:\/\//i.test(url)) void shell.openExternal(url); }
  });
  return window;
}

function installMenu(): void {
  Menu.setApplicationMenu(null);
}

ipcMain.on('window:settings', event => {
  if (event.sender === mainWindow?.webContents && event.senderFrame === mainWindow.webContents.mainFrame) void showSettings();
});

function isSettingsWindow(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender === mainWindow?.webContents && event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame?.url === setupUrl;
}

ipcMain.handle('settings:read', event => {
  if (!isSettingsWindow(event)) throw new Error('Settings are only available from the configuration window');
  return { ...readSettings(), error: startupError };
});
ipcMain.handle('settings:save', async (event, payload: { authorizedPlaceIds?: unknown }) => {
  if (starting || quitting) return { ok: false, error: 'Aguarde a operação atual terminar.' };
  starting = true;
  try {
    if (!isSettingsWindow(event)) throw new Error('Settings are only available from the configuration window');
    const settings = { authorizedPlaceIds: validatePlaces(payload?.authorizedPlaceIds) };
    writeSettings(settings);
    await startBackend(settings);
    return { ok: true };
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    logDesktop('settings_or_startup_failed', error);
    return { ok: false, error: startupError };
  } finally {
    starting = false;
  }
});

app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!running || quitting) return;
  event.preventDefault();
  quitting = true;
  void stopBackend().catch(error => logDesktop('shutdown_failed', error)).finally(() => app.quit());
});

void app.whenReady().then(async () => {
  if (!singleInstance) return;
  app.setAppUserModelId('com.guilherme100a.multiexecute');
  logDesktop('desktop_started');
  nativeTheme.themeSource = 'dark';
  if (!app.isPackaged) {
    try { process.loadEnvFile(join(appRoot, '.env')); } catch { /* Development works with the desktop settings file too. */ }
  }
  mainWindow = createWindow();
  installMenu();
  const settings = readSettings();
  const inherited = (process.env.AUTHORIZED_PLACE_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!settings.authorizedPlaceIds.length && inherited.length) settings.authorizedPlaceIds = inherited;
  if (!settings.authorizedPlaceIds.length) await showSettings();
  else {
    try { await startBackend(settings); }
    catch (error) {
      startupError = error instanceof Error ? error.message : String(error);
      logDesktop('backend_startup_failed', error);
      await showSettings();
      void dialog.showMessageBox(mainWindow, { type: 'error', title: 'Falha ao iniciar', message: 'O Multi Execute não pôde iniciar.', detail: startupError });
    }
  }
}).catch(error => {
  logDesktop('desktop_startup_failed', error);
  dialog.showErrorBox('Multi Execute', error instanceof Error ? error.message : String(error));
  app.quit();
});
