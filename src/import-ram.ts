import { loadConfig } from './config.js';
import { DirectRobloxClient } from './direct-client.js';

const source = process.argv[2];
if (!source || process.argv.length !== 3) throw new Error('Usage: npm run import:ram -- "C:\\path\\AccountData.json"');
const config = loadConfig();
const direct = new DirectRobloxClient(config.directAccountsFile);
try {
  const imported = await direct.importRam(source, config.accounts.map(account => account.robloxUsername));
  console.log(JSON.stringify({ imported, storage: 'Windows DPAPI (current user)', accountManagerRequired: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Account import failed');
  process.exitCode = 1;
} finally { direct.close(); }
