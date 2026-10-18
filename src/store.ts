import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Status = 'pending' | 'launching' | 'connected' | 'analyzing' | 'done' | 'failed' | 'disconnected';
export interface Session {
  id: string; link: string; place_id: string; account_alias: string; worker_id: string;
  status: Status; last_error: string | null; retry_count: number;
  created_at: number; updated_at: number; launching_at: number | null;
  connected_at: number | null; finished_at: number | null; instance_id: string | null;
}
export type PromptStatus = 'queued' | 'running' | 'done' | 'failed';
export interface PromptRun {
  id: string; session_id: string; worker_id: string; prompt: string; status: PromptStatus;
  response: string | null; error: string | null; created_at: number; updated_at: number;
}
export interface AgentPolicy { filename: string; content: string; updated_at: number }
const transitions: Record<Status, Status[]> = {
  pending: ['launching', 'failed'], launching: ['connected', 'failed'],
  connected: ['analyzing', 'failed', 'disconnected'], analyzing: ['done', 'failed', 'disconnected'],
  done: [], failed: [], disconnected: [],
};
export class ConflictError extends Error {}

export class Store {
  private db: DatabaseSync;
  constructor(path: string, private now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, link TEXT NOT NULL, place_id TEXT NOT NULL, account_alias TEXT NOT NULL,
        worker_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','launching','connected','analyzing','done','failed','disconnected')),
        last_error TEXT, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 1),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, launching_at INTEGER,
        connected_at INTEGER, finished_at INTEGER, instance_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_game_account ON sessions(account_alias,place_id)
        WHERE status IN ('pending','launching','connected','analyzing');
      CREATE TABLE IF NOT EXISTS injections (
        instance_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, worker_id TEXT NOT NULL, claimed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS launch_baselines (
        session_id TEXT NOT NULL, instance_id TEXT NOT NULL, PRIMARY KEY(session_id, instance_id)
      );
      CREATE TABLE IF NOT EXISTS prompt_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, worker_id TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')),
        response TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_runs_created ON prompt_runs(created_at DESC);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_policy (
      id INTEGER PRIMARY KEY CHECK(id=1), filename TEXT NOT NULL, content TEXT NOT NULL, updated_at INTEGER NOT NULL
    );`);
  }
  get(id: string): Session | undefined { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Session | undefined; }
  all(): Session[] { return this.db.prepare('SELECT * FROM sessions ORDER BY created_at,rowid').all() as unknown as Session[]; }
  private worker(alias: string): string { return `${alias}-${this.now()}-${randomUUID()}`; }
  create(link: string, place: string, alias: string): { session: Session; reused: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare("SELECT * FROM sessions WHERE account_alias=? AND place_id=? AND status IN ('pending','launching','connected','analyzing')").get(alias, place) as Session | undefined;
      if (active) { this.db.exec('COMMIT'); return { session: active, reused: true }; }
      const id = randomUUID(), timestamp = this.now();
      this.db.prepare("INSERT INTO sessions(id,link,place_id,account_alias,worker_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)")
        .run(id, link, place, alias, this.worker(alias), timestamp, timestamp);
      this.db.exec('COMMIT'); return { session: this.get(id)!, reused: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transition(id: string, next: Status, error: string | null = null, instance?: string): Session {
    const current = this.get(id);
    if (!current) throw new ConflictError('Unknown session');
    if (!transitions[current.status].includes(next)) throw new ConflictError(`Invalid transition: ${current.status} -> ${next}`);
    const timestamp = this.now();
    const result = this.db.prepare(`UPDATE sessions SET status=?,last_error=?,updated_at=?,
      launching_at=CASE WHEN ?='launching' THEN ? ELSE launching_at END,
      connected_at=CASE WHEN ?='connected' THEN ? ELSE connected_at END,
      finished_at=CASE WHEN ? IN ('done','failed','disconnected') THEN ? ELSE finished_at END,
      instance_id=COALESCE(?,instance_id) WHERE id=? AND status=?`)
      .run(next, error, timestamp, next, timestamp, next, timestamp, next, timestamp, instance ?? null, id, current.status);
    if (!result.changes) throw new ConflictError('Session changed concurrently');
    return this.get(id)!;
  }
  retry(id: string): Session {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.get(id);
      if (!row || !['failed', 'disconnected'].includes(row.status) || row.retry_count !== 0) throw new ConflictError('Only one retry is allowed, from failed/disconnected');
      const active = this.db.prepare("SELECT id FROM sessions WHERE account_alias=? AND place_id=? AND status IN ('pending','launching','connected','analyzing')").get(row.account_alias, row.place_id);
      if (active) throw new ConflictError('An active session already exists for this account and game');
      this.db.prepare("UPDATE sessions SET status='pending',worker_id=?,retry_count=1,last_error=NULL,updated_at=?,launching_at=NULL,connected_at=NULL,finished_at=NULL,instance_id=NULL WHERE id=?")
        .run(this.worker(row.account_alias), this.now(), id);
      this.db.prepare('DELETE FROM launch_baselines WHERE session_id=?').run(id);
      this.db.exec('COMMIT'); return this.get(id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  baseline(id: string, instances: string[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const instance of instances) this.db.prepare('INSERT OR IGNORE INTO launch_baselines VALUES(?,?)').run(id, instance);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  isBaseline(id: string, instance: string): boolean { return !!this.db.prepare('SELECT 1 FROM launch_baselines WHERE session_id=? AND instance_id=?').get(id, instance); }
  claimed(instance: string): boolean { return !!this.db.prepare('SELECT 1 FROM injections WHERE instance_id=?').get(instance); }
  claim(session: Session, instance: string): boolean {
    return !!this.db.prepare('INSERT OR IGNORE INTO injections VALUES(?,?,?,?)').run(instance, session.id, session.worker_id, this.now()).changes;
  }
  createPrompt(session: Session, prompt: string): PromptRun {
    const id = randomUUID(), timestamp = this.now();
    this.db.prepare("INSERT INTO prompt_runs(id,session_id,worker_id,prompt,status,created_at,updated_at) VALUES(?,?,?,?, 'queued',?,?)")
      .run(id, session.id, session.worker_id, prompt, timestamp, timestamp);
    return this.db.prepare('SELECT * FROM prompt_runs WHERE id=?').get(id) as unknown as PromptRun;
  }
  prompts(limit = 100): PromptRun[] {
    return this.db.prepare('SELECT * FROM prompt_runs ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as PromptRun[];
  }
  updatePrompt(id: string, status: PromptStatus, response: string | null = null, error: string | null = null): PromptRun {
    const result = this.db.prepare('UPDATE prompt_runs SET status=?,response=?,error=?,updated_at=? WHERE id=?').run(status, response, error, this.now(), id);
    if (!result.changes) throw new ConflictError('Unknown prompt run');
    return this.db.prepare('SELECT * FROM prompt_runs WHERE id=?').get(id) as unknown as PromptRun;
  }
  agentPolicy(): AgentPolicy | undefined {
    return this.db.prepare('SELECT filename,content,updated_at FROM agent_policy WHERE id=1').get() as unknown as AgentPolicy | undefined;
  }
  setAgentPolicy(filename: string, content: string): AgentPolicy {
    this.db.prepare(`INSERT INTO agent_policy(id,filename,content,updated_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,content=excluded.content,updated_at=excluded.updated_at`)
      .run(filename, content, this.now());
    return this.agentPolicy()!;
  }
  close(): void { this.db.close(); }
}
