import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InputError } from './validation.js';

export type Credential = { username: string; password: string };
export function parseCredentials(input: unknown): Credential[] {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 64 * 1024)
    throw new InputError('Informe uma lista de até 64 KiB no formato usuario:senha.');
  const rows: Credential[] = [], seen = new Set<string>();
  for (const [index, raw] of input.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const colon = raw.indexOf(':');
    const username = raw.slice(0, colon).trim(), password = raw.slice(colon + 1);
    if (colon < 0 || !/^[A-Za-z0-9_]{3,20}$/.test(username) || !password.length || password.length > 1024 || /[\x00-\x1f\x7f]/.test(password))
      throw new InputError(`Linha ${index + 1}: use usuario:senha com username válido e senha não vazia.`);
    if (seen.has(username.toLowerCase())) throw new InputError(`Linha ${index + 1}: usuário repetido.`);
    seen.add(username.toLowerCase()); rows.push({ username, password });
  }
  if (!rows.length || rows.length > 100) throw new InputError('Informe de 1 a 100 contas.');
  return rows;
}

// Only fixed code reaches command-line arguments; plaintext travels through stdin/stdout.
async function dpapi(value: string, decrypt: boolean): Promise<string> {
  if (process.platform !== 'win32') throw new Error('O cofre de senhas requer Windows.');
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.Encoding]::UTF8
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Security
    try {
      $inputValue = [Console]::In.ReadToEnd()
      ${decrypt ? '$bytes = [Convert]::FromBase64String($inputValue)' : '$bytes = [Text.Encoding]::UTF8.GetBytes($inputValue)'}
      $result = [Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Write(${decrypt ? '[Text.Encoding]::UTF8.GetString($result)' : '[Convert]::ToBase64String($result)'})
    } catch { exit 1 }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const fail = () => reject(new Error('Não foi possível acessar o cofre de senhas do Windows.'));
    const timer = setTimeout(() => { child.kill(); fail(); }, 15_000);
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1024 * 1024) child.kill(); });
    child.once('error', () => { clearTimeout(timer); fail(); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else fail(); });
    child.stdin.end(value, 'utf8');
  });
}

export class PasswordStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  private async read(): Promise<Record<string, string>> {
    let encrypted: string;
    try { encrypted = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Não foi possível ler o cofre de senhas.'); }
    try { return JSON.parse(await dpapi(encrypted, true)) as Record<string, string>; }
    catch { throw new Error('Não foi possível abrir o cofre de senhas neste usuário do Windows.'); }
  }
  async get(username: string): Promise<string | undefined> {
    await this.pending;
    const values = await this.read(), key = username.toLowerCase();
    return Object.hasOwn(values, key) ? values[key] : undefined;
  }
  async save(rows: Credential[]): Promise<void> {
    const operation = this.pending.then(async () => {
      const values = await this.read();
      for (const row of rows) Object.defineProperty(values, row.username.toLowerCase(), { value: row.password, enumerable: true, configurable: true, writable: true });
      const encrypted = await dpapi(JSON.stringify(values), false);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, encrypted, { encoding: 'utf8', mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    });
    this.pending = operation.catch(() => {});
    await operation;
  }
}
