import { startApplication } from './runtime.js';

const running = await startApplication();
console.log(`Authorized pipeline: ${running.url}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await running.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown().catch(error => { console.error(String(error)); process.exitCode = 1; }); });
}
