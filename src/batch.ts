import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HttpClient, sleep } from './clients.js';
import { parseAccounts, placeId, type Account } from './validation.js';

export async function runBatch(links: string[], accounts: Account[], submit: (link: string, alias: string) => Promise<unknown>, wait = sleep): Promise<void> {
  if (!accounts.length || !links.length) throw new Error('Batch requires links and accounts');
  links.forEach(placeId); // Fail before submitting anything if the input contains an invalid URL.
  for (let index = 0; index < links.length; index++) {
    await submit(links[index]!, accounts[index % accounts.length]!.alias);
    if (index < links.length - 1) await wait(5000);
  }
}
async function main(): Promise<void> {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error('Usage: npm run batch -- links.txt');
  const links = readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const accounts = parseAccounts(JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? 'accounts.json', 'utf8')) as unknown);
  const base = new URL(process.env.PIPELINE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('PIPELINE_URL must be a loopback HTTP origin');
  const client = new HttpClient(base.origin);
  await runBatch(links, accounts, async (link, alias) => {
    const result = await client.request('/launch', 'POST', { links: [link], alias });
    console.log(JSON.stringify({ alias, link, result }));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
