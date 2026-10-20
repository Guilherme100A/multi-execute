import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function desktopLogFile(): string {
  const root = process.env.MULTI_EXECUTE_DATA_DIR ?? join(app.getPath('appData'), 'Multi Execute');
  return join(root, 'logs', 'desktop.jsonl');
}

export function logDesktop(event: string, error?: unknown): void {
  try {
    const file = desktopLogFile();
    mkdirSync(dirname(file), { recursive: true });
    try { if (statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`); } catch { /* No previous log yet. */ }
    const message = error === undefined ? undefined : error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), event, error: message?.slice(0, 16_384) })}\n`, { mode: 0o600 });
  } catch { /* Diagnostics must never prevent the application from opening. */ }
}
