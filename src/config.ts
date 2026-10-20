import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseAccounts, placeId } from './validation.js';

function findRealMcp(env: NodeJS.ProcessEnv): string {
  if (env.REAL_MCP_EXECUTABLE) return resolve(env.REAL_MCP_EXECUTABLE);
  const root = resolve(env.LOCALAPPDATA ?? resolve(homedir(), 'AppData/Local'), 'Real');
  const legacy = resolve(root, 'data/mcp/real-mcp.exe');
  if (existsSync(legacy)) return legacy;
  try {
    const versions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^real-[0-9.]+$/i.test(entry.name))
      .map(entry => entry.name).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    const installed = versions.map(version => resolve(root, version, 'bin/real-mcp.exe')).find(existsSync);
    if (installed) return installed;
  } catch { /* The validation error from the connector is clearer when Real is not installed. */ }
  return legacy;
}

export function loadConfig(env = process.env) {
  const resourceRoot = resolve(env.APP_RESOURCE_ROOT ?? process.cwd());
  const dataRoot = resolve(env.APP_DATA_ROOT ?? process.cwd());
  const fromRoot = (root: string, value: string) => resolve(root, value);
  const callbackToken = env.INTERNAL_CALLBACK_TOKEN ?? randomBytes(32).toString('hex');
  const autoexecToken = env.AUTOEXEC_TOKEN ?? randomBytes(32).toString('hex');
  const invalidSecret = (value: string) => value.length < 24 || /^replace-with-/i.test(value);
  if (invalidSecret(callbackToken)) throw new Error('INTERNAL_CALLBACK_TOKEN must be a non-placeholder secret of at least 24 characters when configured');
  if (invalidSecret(autoexecToken) || autoexecToken === callbackToken) throw new Error('AUTOEXEC_TOKEN must be a different non-placeholder secret of at least 24 characters when configured');
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('HOST must be loopback');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${key}`);
    return value;
  };
  const authorized = new Set((env.AUTHORIZED_PLACE_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(value => {
    if (!/^\d{6,15}$/.test(value)) throw new Error('AUTHORIZED_PLACE_IDS requires comma-separated 6–15 digit IDs');
    return placeId(value);
  }));
  if (!authorized.size) throw new Error('Configure AUTHORIZED_PLACE_IDS for games you own or are authorized to test');
  const upstream = (key: string, fallback: string) => {
    const value = new URL(env[key] ?? fallback);
    if (value.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname) || value.username || value.password || value.pathname !== '/' || value.search || value.hash)
      throw new Error(`${key} must be a loopback HTTP origin`);
    return value.origin;
  };
  const ramPort = integer('RAM_PORT', 7963, 1, 65535);
  const mcpPort = integer('MCP_PORT', 28429, 1, 65535);
  const mcpHost = env.MCP_HOST ?? '127.0.0.1';
  if (mcpHost !== '127.0.0.1' || mcpPort !== 28429) throw new Error('MCP_HOST/MCP_PORT must match the loader: 127.0.0.1:28429');
  const mcpUrl = upstream('MCP_URL', `http://${mcpHost}:${mcpPort}`);
  if (mcpUrl !== 'http://127.0.0.1:28429') throw new Error('MCP_URL must match the loader: http://127.0.0.1:28429');
  const ramPassword = env.RAM_PASSWORD ?? '';
  if (ramPassword && ramPassword.length < 6) throw new Error('RAM_PASSWORD must be empty or at least 6 characters');
  const browserProxyServer = env.BROWSER_PROXY_SERVER?.trim();
  let browserProxy: { server: string; username?: string; password?: string } | undefined;
  if (browserProxyServer) {
    const proxyUrl = new URL(browserProxyServer.includes('://') ? browserProxyServer : `http://${browserProxyServer}`);
    if (!['http:', 'https:', 'socks5:'].includes(proxyUrl.protocol) || proxyUrl.username || proxyUrl.password || proxyUrl.pathname !== '/' || proxyUrl.search || proxyUrl.hash)
      throw new Error('BROWSER_PROXY_SERVER must be an HTTP, HTTPS or SOCKS5 proxy without embedded credentials');
    browserProxy = { server: proxyUrl.origin, username: env.BROWSER_PROXY_USERNAME, password: env.BROWSER_PROXY_PASSWORD };
  } else if (env.BROWSER_PROXY_USERNAME || env.BROWSER_PROXY_PASSWORD) throw new Error('BROWSER_PROXY_SERVER is required when browser proxy credentials are configured');
  const accountsFile = fromRoot(dataRoot, env.ACCOUNTS_FILE ?? 'accounts.json');
  const launchBackend = env.LAUNCH_BACKEND ?? 'direct';
  if (!['direct', 'ram'].includes(launchBackend)) throw new Error('LAUNCH_BACKEND must be direct or ram');
  const agentCliCommand = env.AGENT_CLI_COMMAND ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(agentCliCommand)) throw new Error('AGENT_CLI_COMMAND must be an executable name without a path');
  const agentModel = env.AGENT_MODEL ?? 'gpt-6.1-sol';
  const claudeCliCommand = env.CLAUDE_CLI_COMMAND ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(claudeCliCommand)) throw new Error('Invalid CLAUDE_CLI_COMMAND');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(agentModel)) throw new Error('Invalid AGENT_MODEL');
  return {
    host, port, callbackToken, autoexecToken, authorized, mcpUrl, ramUrl: upstream('RAM_URL', `http://127.0.0.1:${ramPort}`),
    ramPassword, mcpToken: env.MCP_TOKEN ?? '',
    launchBackend, directAccountsFile: fromRoot(dataRoot, env.DIRECT_ACCOUNTS_FILE ?? 'data/roblox-accounts.dpapi'),
    directHelperFile: resolve(env.DIRECT_HELPER_FILE ?? fromRoot(resourceRoot, 'scripts/direct-roblox.ps1')),
    publicDirectory: resolve(env.PUBLIC_DIRECTORY ?? fromRoot(resourceRoot, 'public')),
    bootstrapFile: resolve(env.BOOTSTRAP_FILE ?? fromRoot(dataRoot, 'project-real-autoexec.lua')),
    robloxPreferencesFile: fromRoot(dataRoot, 'roblox-settings.json'),
    robloxSettingsFile: resolve(env.ROBLOX_SETTINGS_FILE ?? resolve(env.LOCALAPPDATA ?? resolve(homedir(), 'AppData/Local'), 'Roblox/GlobalBasicSettings_13.xml')),
    autoConnect: env.AUTO_CONNECT !== 'false',
    realMcpExecutable: findRealMcp(env),
    accountsFile, accounts: parseAccounts(JSON.parse(readFileSync(accountsFile, 'utf8')) as unknown),
    databaseFile: fromRoot(dataRoot, env.DB_PATH ?? env.DATABASE_FILE ?? 'data/sessions.sqlite'),
    logDirectory: fromRoot(dataRoot, env.LOG_DIRECTORY ?? 'logs'), findingsDirectory: fromRoot(dataRoot, env.FINDINGS_DIRECTORY ?? 'findings'),
    healthIntervalMs: integer('HEALTH_CHECK_INTERVAL_MS', 3_000, 1_000, 3_600_000),
    launchTimeoutMs: integer('LAUNCH_TIMEOUT_MS', 120_000, 10_000, 3_600_000),
    maxRetries: integer('MAX_RETRIES', 3, 1, 10),
    retryBaseDelayMs: integer('RETRY_BASE_DELAY_MS', 2_000, 1, 60_000),
    injectionMode: env.INJECTION_MODE === 'mcp-execute' ? 'mcp-execute' as const : 'project-real-autoexec' as const,
    agentCliCommand, agentModel, claudeCliCommand, browserProxy,
  };
}
