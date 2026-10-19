import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { aliasValue, placeId } from './validation.js';

export type DirectResult = { ok: boolean; accounts?: string[]; username?: string; error?: string };
export type DirectAction = 'List' | 'ImportRam' | 'ImportCookie' | 'Verify' | 'Launch' | 'LaunchBatch';
export type DirectExecutor = (action: DirectAction, input: Record<string, unknown>) => Promise<DirectResult>;

/** Cookies stay in the Windows helper and DPAPI vault, never in command-line arguments. */
export class DirectRobloxClient {
  private holder?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  constructor(private vault: string, private execute: DirectExecutor = (action, input) => this.invoke(action, input),
    private multi = true) {}

  private args(action: string): string[] {
    return ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/direct-roblox.ps1'), '-Action', action, '-Vault', this.vault];
  }
  private invoke(action: DirectAction, input: Record<string, unknown>): Promise<DirectResult> {
    if (process.platform !== 'win32') return Promise.reject(new Error('Direct Roblox launching requires Windows'));
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', this.args(action), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local Roblox operation timed out')); }, 45_000);
      child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-65_536); });
      child.stderr.resume(); // Never expose PowerShell diagnostics containing secret request inputs.
      child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new Error('Windows account helper could not start')); });
      child.once('close', () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output.trim()) as DirectResult;
          if (!result.ok) { reject(new Error(result.error || 'Local Roblox operation failed')); return; }
          resolve(result);
        } catch { reject(new Error('Windows account helper returned an invalid response')); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
  private async ensureMulti(): Promise<void> {
    if (!this.multi || this.holder) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', this.args('HoldMulti'), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('Multi-instance helper timed out')); }, 10_000);
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new Error('Multi-instance helper could not start')); });
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (!output.includes('\n') || ready) return;
        clearTimeout(timer);
        try {
          const result = JSON.parse(output.trim()) as DirectResult;
          if (!result.ok) { child.kill(); reject(new Error(result.error || 'Multi-instance launching unavailable')); return; }
          ready = true; this.holder = child; resolve();
        } catch { child.kill(); reject(new Error('Multi-instance helper returned an invalid response')); }
      });
      child.once('close', () => {
        clearTimeout(timer);
        if (this.holder === child) this.holder = undefined;
        if (!ready) reject(new Error('Multi-instance helper stopped before becoming ready'));
      });
    });
    try { await this.starting; } finally { this.starting = undefined; }
  }
  close(): void { this.holder?.stdin.end('\n'); this.holder = undefined; }
  async accounts(): Promise<string[]> { return (await this.execute('List', {})).accounts ?? []; }
  async verify(username: string): Promise<void> {
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Invalid Roblox username');
    await this.execute('Verify', { username });
  }
  async importRam(source: string, usernames: string[]): Promise<string[]> {
    usernames.forEach(aliasValue);
    if (!usernames.length || new Set(usernames.map(value => value.toLowerCase())).size !== usernames.length) throw new Error('Choose unique usernames to import');
    return (await this.execute('ImportRam', { source: resolve(source), usernames })).accounts ?? [];
  }
  async importCookie(cookie: string): Promise<void> {
    if (typeof cookie !== 'string' || !/^[^\s;]{20,4096}$/.test(cookie)) throw new Error('Invalid Roblox session cookie');
    await this.execute('ImportCookie', { cookie });
  }
  async launch(username: string, rawPlace: string): Promise<void> {
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Invalid Roblox username');
    const game = placeId(rawPlace);
    await this.ensureMulti();
    await this.execute('Launch', { username, placeId: game });
  }
  async launchBatch(games: { username: string; placeId: string }[]): Promise<void> {
    if (!games.length || games.length > 10 || new Set(games.map(game => game.username.toLowerCase())).size !== games.length) throw new Error('A batch requires 1–10 distinct accounts');
    const validated = games.map(game => {
      if (!/^[A-Za-z0-9_]{3,20}$/.test(game.username)) throw new Error('Invalid Roblox username');
      return { username: game.username, placeId: placeId(game.placeId) };
    });
    await this.ensureMulti();
    await this.execute('LaunchBatch', { games: validated });
  }
}
