import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface Logger { info(event: string, fields?: Record<string, unknown>): void; warn?(event: string, fields?: Record<string, unknown>): void; error(event: string, fields?: Record<string, unknown>): void }
export class RotatingLogger implements Logger {
  private path: string;
  constructor(directory: string, private maxBytes = 50 * 1024 * 1024) {
    mkdirSync(directory, { recursive: true }); this.path = join(directory, 'pipeline.jsonl');
  }
  private write(level: string, event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }) + '\n';
    if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes) {
      if (existsSync(this.path + '.2')) unlinkSync(this.path + '.2');
      if (existsSync(this.path + '.1')) renameSync(this.path + '.1', this.path + '.2');
      renameSync(this.path, this.path + '.1');
    }
    appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 });
  }
  info(event: string, fields?: Record<string, unknown>): void { this.write('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.write('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.write('error', event, fields); }
}
