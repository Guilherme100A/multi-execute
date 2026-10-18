import express, { type ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pipeline } from './pipeline.js';
import { ConflictError } from './store.js';
import { InputError } from './validation.js';
import type { Logger } from './logger.js';

export function createApp(pipeline: Pipeline, token: string, callbackToken: string, findings: string, log: Logger) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${req.path.startsWith('/internal/') ? callbackToken : token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/status', (_req, res) => res.json({ mcp_online: pipeline.online, queue_paused: !pipeline.online, sessions: pipeline.store.all() }));
  app.post('/launch', (req, res) => {
    const result = pipeline.launch(req.body?.links, req.body?.alias);
    res.status(result.every(row => row.reused) ? 200 : 202).json({ sessions: result });
  });
  app.post('/sessions/:id/retry', (req, res) => {
    if (!pipeline.store.get(req.params.id)) { res.status(404).json({ error: 'Unknown session' }); return; }
    res.status(202).json({ session: pipeline.retry(req.params.id) });
  });
  for (const status of ['analyzing', 'done', 'failed'] as const) {
    app.post(`/internal/sessions/:id/${status}`, (req, res) => {
      const row = pipeline.store.get(req.params.id);
      if (!row) { res.status(404).json({ error: 'Unknown session' }); return; }
      if (!req.body || req.body.worker_id !== row.worker_id) throw new ConflictError('Stale or missing worker_id');
      if (status === 'failed' && (typeof req.body.error !== 'string' || !req.body.error.trim() || req.body.error.length > 4000)) throw new InputError('failed requires an error string (1–4000 characters)');
      // Identical callbacks are idempotent; stale callbacks after retry are rejected above.
      if (row.status === status) { res.json({ session: row, reused: true }); return; }
      if (status === 'failed' && !['connected', 'analyzing'].includes(row.status)) throw new ConflictError('Worker must be connected before reporting failure');
      if (status === 'done' && req.body.findings !== undefined) {
        if (row.status !== 'analyzing') throw new ConflictError('Must be analyzing before done');
        mkdirSync(findings, { recursive: true });
        // Generated UUIDs are the only path components; aliases and links never become paths.
        writeFileSync(join(findings, `${row.id}-${row.retry_count}.json`), JSON.stringify({ session_id: row.id, worker_id: row.worker_id, findings: req.body.findings }, null, 2), { mode: 0o600 });
      }
      const session = pipeline.store.transition(row.id, status, status === 'failed' ? req.body.error as string : null);
      log.info('worker_callback', { id: row.id, worker_id: row.worker_id, from: row.status, to: status });
      res.json({ session });
    });
  }
  app.use((_req, res) => { res.status(404).json({ error: 'Unknown endpoint' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const code = error instanceof InputError || error instanceof SyntaxError ? 400 : error instanceof ConflictError ? 409 :
      error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 500;
    if (code === 500) log.error('request_error', { error: String(error) });
    res.status(code).json({ error: code === 500 ? 'Internal server error' : error instanceof Error ? error.message : String(error) });
  };
  app.use(errors);
  return app;
}
