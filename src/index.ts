import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { HttpClient, McpClient, RamClient } from './clients.js';
import { RotatingLogger } from './logger.js';
import { Pipeline } from './pipeline.js';
import { Store } from './store.js';

const config = loadConfig();
const log = new RotatingLogger(config.logDirectory);
const store = new Store(config.databaseFile);
const pipeline = new Pipeline(store,
  new RamClient(new HttpClient(config.ramUrl, config.ramToken), undefined, config.maxRetries, config.retryBaseDelayMs),
  new McpClient(new HttpClient(config.mcpUrl, config.mcpToken)),
  config.accounts, config.authorized, log, Date.now, config.healthIntervalMs, config.launchTimeoutMs);
const server = createApp(pipeline, config.token, config.callbackToken, config.findingsDirectory, log).listen(config.port, config.host, () => {
  log.info('server_started', { host: config.host, port: config.port });
  console.log(`Authorized pipeline: http://${config.host}:${config.port}`);
  pipeline.start();
});
server.on('error', error => { log.error('server_error', { error: String(error) }); store.close(); process.exitCode = 1; });
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return; stopping = true;
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pipeline.stop();
  await closed;
  store.close(); log.info('server_stopped');
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().catch(error => { console.error(String(error)); process.exitCode = 1; }); });
