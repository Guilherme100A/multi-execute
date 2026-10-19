import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageFile = resolve('node_modules/roblox-mcp-difz/package.json');
const target = resolve('node_modules/roblox-mcp-difz/dist/ws-server.js');
const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
if (metadata.version !== '1.6.1') throw new Error(`Unsupported roblox-mcp-difz version: ${metadata.version}`);

let source = readFileSync(target, 'utf8');
const edits = [
  [
    'finalizeReg(matchRobloxPid(m.Name, m.PlaceId), m.Name, m.JobId, m.PlaceId, info.username);',
    'finalizeReg(info.pid ?? matchRobloxPid(m.Name, m.PlaceId), m.Name, m.JobId, m.PlaceId, info.username);',
  ],
  [
    '    get connectedCount() { return this.workers.size; }\n    _startHeartbeat() {',
    `    get connectedCount() { return this.workers.size; }
    destroy() {
        clearInterval(this._heartbeatTimer);
        if (this._taskHandler)
            this.queue.off('task', this._taskHandler);
        for (const ws of this.allConnections)
            ws.terminate();
        this.wss?.close();
        this.allConnections.clear();
        this.workers.clear();
        this.pidMap.clear();
    }
    _startHeartbeat() {`,
  ],
  [
    '    _startHeartbeat() {\n        setInterval(() => {',
    '    _startHeartbeat() {\n        this._heartbeatTimer = setInterval(() => {',
  ],
];

let changed = false;
for (const [before, after] of edits) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`roblox-mcp-difz patch context not found: ${before.slice(0, 70)}`);
  source = source.replace(before, after);
  changed = true;
}
if (changed) writeFileSync(target, source);
console.log(`roblox-mcp-difz@${metadata.version} identity/lifecycle patch ${changed ? 'applied' : 'already present'}`);
