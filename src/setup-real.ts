import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { makeProjectRealAutoexec } from './project-real.js';

const output = resolve(process.argv[2] ?? 'project-real-autoexec.lua');
const config = loadConfig();
const base = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
writeFileSync(output, makeProjectRealAutoexec(base, config.autoexecToken), { encoding: 'utf8', mode: 0o600 });
console.log(`Project Real Auto-Execute bootstrap written to ${output}`);
console.log('Import this file once into Real > Explorer > Auto-Execute, save it, and keep Auto Execute enabled.');
