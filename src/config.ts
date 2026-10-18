import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAccounts, placeId } from './validation.js';

export function loadConfig(env = process.env) {
  const token = env.PIPELINE_TOKEN ?? '';
  const callbackToken = env.INTERNAL_CALLBACK_TOKEN ?? '';
  const invalidSecret = (value: string) => value.length < 24 || /^replace-with-/i.test(value);
  if (invalidSecret(token)) throw new Error('PIPELINE_TOKEN must be a non-placeholder secret of at least 24 characters');
  if (invalidSecret(callbackToken) || callbackToken === token) throw new Error('INTERNAL_CALLBACK_TOKEN must be a different non-placeholder secret of at least 24 characters');
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
  const ramPort = integer('RAM_PORT', 8080, 1, 65535);
  const mcpPort = integer('MCP_PORT', 28429, 1, 65535);
  const mcpHost = env.MCP_HOST ?? '127.0.0.1';
  if (mcpHost !== '127.0.0.1' || mcpPort !== 28429) throw new Error('MCP_HOST/MCP_PORT must match the loader: 127.0.0.1:28429');
  const mcpUrl = upstream('MCP_URL', `http://${mcpHost}:${mcpPort}`);
  if (mcpUrl !== 'http://127.0.0.1:28429') throw new Error('MCP_URL must match the loader: http://127.0.0.1:28429');
  return {
    host, port, token, callbackToken, authorized, mcpUrl, ramUrl: upstream('RAM_URL', `http://127.0.0.1:${ramPort}`),
    ramToken: env.RAM_TOKEN ?? '', mcpToken: env.MCP_TOKEN ?? '',
    accounts: parseAccounts(JSON.parse(readFileSync(resolve(env.ACCOUNTS_FILE ?? 'accounts.json'), 'utf8')) as unknown),
    databaseFile: resolve(env.DB_PATH ?? env.DATABASE_FILE ?? 'data/sessions.sqlite'),
    logDirectory: resolve(env.LOG_DIRECTORY ?? 'logs'), findingsDirectory: resolve(env.FINDINGS_DIRECTORY ?? 'findings'),
    healthIntervalMs: integer('HEALTH_CHECK_INTERVAL_MS', 30_000, 1_000, 3_600_000),
    launchTimeoutMs: integer('LAUNCH_TIMEOUT_MS', 60_000, 10_000, 3_600_000),
    maxRetries: integer('MAX_RETRIES', 3, 1, 10),
    retryBaseDelayMs: integer('RETRY_BASE_DELAY_MS', 2_000, 1, 60_000),
  };
}
