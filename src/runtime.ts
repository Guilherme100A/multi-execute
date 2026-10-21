import type { Server } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { HttpClient, McpClient, RamClient } from './clients.js';
import { RotatingLogger } from './logger.js';
import { Pipeline } from './pipeline.js';
import { Store } from './store.js';
import { AgentRunner } from './agent.js';
import { AccountRegistry } from './account-registry.js';
import { DirectRobloxClient } from './direct-client.js';
import { AutoConnector, LocalMcpServer, RealConnectionClient, writeBootstrap } from './auto-connect.js';
import { inspectSetup } from './setup-check.js';
import { RobloxSettings } from './roblox-settings.js';
import { PasswordStore } from './password-store.js';
import { loadRobloxLoginOptions, RobloxBrowserLogin, RobloxLogin, CaptchaSolver } from './roblox-login.js';

export type RunningApplication = {
  url: string;
  close(): Promise<void>;
};

export async function startApplication(env = process.env): Promise<RunningApplication> {
  const config = loadConfig(env);
  const log = new RotatingLogger(config.logDirectory);
  const store = new Store(config.databaseFile);
  const mcp = new McpClient(new HttpClient(config.mcpUrl, config.mcpToken));
  const ram = new RamClient(new HttpClient(config.ramUrl), config.ramPassword, undefined, config.maxRetries, config.retryBaseDelayMs);
  const direct = new DirectRobloxClient(config.directAccountsFile, undefined, true, config.directHelperFile);
  const launcher = config.launchBackend === 'direct' ? direct : ram;
  const accountRegistry = new AccountRegistry(config.accountsFile, config.accounts);
  const browserLogin = new RobloxBrowserLogin(undefined, undefined, loadRobloxLoginOptions(env).proxy,
    new CaptchaSolver({
      capsolverApiKey: env.CAPSOLVER_API_KEY?.trim(),
      twocaptchaApiKey: env.TWOCAPTCHA_API_KEY?.trim(),
    }, log));
  const passwords = new PasswordStore(`${config.directAccountsFile}.passwords`);
  const robloxLogin = new RobloxLogin(config.accounts, accountRegistry, launcher, log, browserLogin, passwords);
  const pipeline = new Pipeline(store, launcher, mcp, config.accounts, config.authorized, log, Date.now,
    config.healthIntervalMs, config.launchTimeoutMs, config.injectionMode);
  const agent = new AgentRunner(config.agentCliCommand, config.agentModel, `http://${config.host}:${config.port}`,
    config.callbackToken, mcp, undefined, undefined, config.claudeCliCommand);
  const savedAgent = store.agentSettings();
  if (savedAgent) { try { agent.select(savedAgent); } catch { log.error('saved_agent_unavailable', { provider: savedAgent.provider }); } }
  const origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
  const automatic = config.autoConnect ? new AutoConnector(pipeline, mcp, new RealConnectionClient(config.realMcpExecutable),
    new LocalMcpServer(), writeBootstrap(origin, config.autoexecToken, config.bootstrapFile), log) : undefined;
  const expressApp = createApp(pipeline, config.callbackToken, config.autoexecToken, config.findingsDirectory, log,
    agent, config.accounts, accountRegistry, launcher,
    () => automatic?.status ?? { enabled: false, state: 'stopped', error: null }, config.publicDirectory,
    () => inspectSetup(config, agent.selection.provider, env), new RobloxSettings(config.robloxPreferencesFile, config.robloxSettingsFile), robloxLogin);
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const candidate = expressApp.listen(config.port, config.host, () => {
        candidate.removeListener('error', reject);
        resolve(candidate);
      });
      candidate.once('error', reject);
    });
  } catch (error) {
    direct.close();
    store.close();
    throw error;
  }
  log.info('server_started', { host: config.host, port: config.port });
  pipeline.start();
  automatic?.start();
  let stopping = false;
  return {
    url: origin,
    async close() {
      if (stopping) return;
      stopping = true;
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // The dashboard keeps an SSE connection open for live updates.
      server.closeAllConnections();
      await expressApp.shutdown();
      await pipeline.stop();
      await automatic?.close();
      direct.close();
      await closed;
      store.close();
      log.info('server_stopped');
    },
  };
}
