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

const config = loadConfig();
const log = new RotatingLogger(config.logDirectory);
const store = new Store(config.databaseFile);
const mcp = new McpClient(new HttpClient(config.mcpUrl, config.mcpToken));
const ram = new RamClient(new HttpClient(config.ramUrl), config.ramPassword, undefined, config.maxRetries, config.retryBaseDelayMs);
const direct = new DirectRobloxClient(config.directAccountsFile);
const launcher = config.launchBackend === 'direct' ? direct : ram;
const accountRegistry = new AccountRegistry(config.accountsFile, config.accounts);
const pipeline = new Pipeline(store,
  launcher,
  mcp,
  config.accounts, config.authorized, log, Date.now, config.healthIntervalMs, config.launchTimeoutMs, config.injectionMode);
const agent = new AgentRunner(config.agentCliCommand, config.agentModel, `http://${config.host}:${config.port}`, config.callbackToken, mcp, undefined, undefined, config.claudeCliCommand);
const savedAgent=store.agentSettings();
if (savedAgent) { try { agent.select(savedAgent); } catch { log.error('saved_agent_unavailable',{provider:savedAgent.provider}); } }
const origin = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
const automatic = config.autoConnect ? new AutoConnector(pipeline, mcp, new RealConnectionClient(config.realMcpExecutable),
  new LocalMcpServer(), writeBootstrap(origin, config.autoexecToken), log) : undefined;
const server = createApp(pipeline, config.callbackToken, config.autoexecToken, config.findingsDirectory, log, agent, config.accounts, accountRegistry, launcher,
  () => automatic?.status ?? { enabled: false, state: 'stopped', error: null }).listen(config.port, config.host, () => {
  log.info('server_started', { host: config.host, port: config.port });
  console.log(`Authorized pipeline: http://${config.host}:${config.port}`);
  pipeline.start();
  automatic?.start();
});
server.on('error', error => { log.error('server_error', { error: String(error) }); store.close(); process.exitCode = 1; });
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pipeline.stop();
  await automatic?.close();
  direct.close();
  await closed;
  store.close(); log.info('server_stopped');
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().catch(error => { console.error(String(error)); process.exitCode = 1; }); });
