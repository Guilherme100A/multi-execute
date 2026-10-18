import type { McpClient, McpSession, RamClient } from './clients.js';
import type { Logger } from './logger.js';
import { makeLoader } from './loader.js';
import { Store, type Session } from './store.js';
import { InputError, placeId, aliasValue, type Account } from './validation.js';

export class Pipeline {
  online = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private launching = false;
  private stopping = false;
  private tickPromise?: Promise<void>;
  private drainPromise?: Promise<void>;
  private drainRequested = false;
  constructor(readonly store: Store, private ram: Pick<RamClient, 'launch'>,
    private mcp: Pick<McpClient, 'health' | 'sessions' | 'processes' | 'execute'>,
    private accounts: Account[], private authorized: Set<string>, private log: Logger, private now = Date.now,
    private healthIntervalMs = 30_000, private launchTimeoutMs = 60_000) {
    // A crash between persistent claim and execute acknowledgment cannot be retried safely.
    for (const row of store.all()) {
      if (['pending', 'launching', 'connected', 'analyzing'].includes(row.status) &&
          (!authorized.has(row.place_id) || !accounts.some(account => account.alias === row.account_alias)))
        this.change(row, 'failed', 'Persisted session is no longer authorized/configured');
      else if (row.status === 'connected' && row.instance_id && store.claimed(row.instance_id))
        this.change(row, 'failed', 'Controller restarted before analyzing acknowledgment; execute outcome uncertain');
    }
  }

  launch(links: unknown, alias: unknown): { session: Session; reused: boolean }[] {
    const account = aliasValue(alias);
    if (!this.accounts.some(row => row.alias === account)) throw new InputError('Unknown account alias');
    if (!Array.isArray(links) || !links.length || links.length > 100 || links.some(link => typeof link !== 'string')) throw new InputError('links must contain 1–100 strings');
    // Validate the entire batch before creating any rows.
    const games = links.map(link => ({ link: link as string, place: placeId(link) }));
    for (const game of games) if (!this.authorized.has(game.place)) throw new InputError(`PlaceId ${game.place} is not in AUTHORIZED_PLACE_IDS`);
    const result = games.map(game => this.store.create(game.link, game.place, account));
    this.log.info('launch_queued', { ids: result.map(row => row.session.id) });
    this.kick(); return result;
  }
  retry(id: string): Session {
    const current = this.store.get(id);
    if (current && (!this.authorized.has(current.place_id) || !this.accounts.some(account => account.alias === current.account_alias))) throw new InputError('Session is no longer authorized/configured');
    const row = this.store.retry(id); this.log.info('retry_queued', { id }); this.kick(); return row;
  }
  private kick(): void {
    if (this.stopping) return;
    if (this.drainPromise) { this.drainRequested = true; return; }
    this.drainRequested = false;
    this.drainPromise = this.drain().catch(error => this.log.error('queue_error', { error: String(error) })).finally(() => {
      this.drainPromise = undefined;
      if (this.drainRequested) this.kick();
    });
  }
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick(); }, this.healthIntervalMs);
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPromise;
    await this.drainPromise;
  }
  tick(): Promise<void> {
    if (this.ticking || this.stopping) return this.tickPromise ?? Promise.resolve();
    this.tickPromise = this.monitor(); return this.tickPromise;
  }
  private async monitor(): Promise<void> {
    this.ticking = true;
    try {
      // Expiration uses persisted launching_at even when MCP is offline.
      for (const row of this.store.all()) if (row.status === 'launching' && row.launching_at !== null && this.now() - row.launching_at > this.launchTimeoutMs)
        this.change(row, 'failed', `MCP connection timeout (>${this.launchTimeoutMs}ms)`);
      let sessions: McpSession[], processes: { instanceId: string }[];
      try {
        await this.mcp.health();
        [sessions, processes] = await Promise.all([this.mcp.sessions(), this.mcp.processes()]);
        this.online = true;
      } catch (error) {
        this.online = false; this.log.error('mcp_offline', { error: String(error) }); return;
      }
      const live = new Set(processes.map(process => process.instanceId));
      for (const row of this.store.all()) {
        if (row.status === 'launching') {
          const candidates = sessions.filter(session => session.accountAlias === row.account_alias && session.placeId === row.place_id &&
            live.has(session.instanceId) && !this.store.isBaseline(row.id, session.instanceId) && !this.store.claimed(session.instanceId) &&
            (!session.workerId || session.workerId === row.worker_id));
          // Never guess when two instances fit the same account/game.
          if (candidates.length === 1) {
            const match = candidates[0]!;
            this.change(row, 'connected', null, match.instanceId);
            await this.inject(this.store.get(row.id)!, match);
          } else if (candidates.length > 1) this.log.error('ambiguous_instance', { id: row.id });
        } else if (row.status === 'connected' || row.status === 'analyzing') {
          const match = sessions.find(session => session.instanceId === row.instance_id && session.accountAlias === row.account_alias && session.placeId === row.place_id && (!session.workerId || session.workerId === row.worker_id));
          if (!match || !live.has(row.instance_id!)) this.change(row, 'disconnected', 'MCP session/process disappeared');
          else if (row.status === 'connected' && !this.store.claimed(match.instanceId)) await this.inject(row, match);
        }
      }
      this.kick();
    } catch (error) { this.log.error('monitor_error', { error: String(error) }); }
    finally { this.ticking = false; }
  }
  private change(row: Session, status: Parameters<Store['transition']>[1], error: string | null = null, instance?: string): void {
    this.store.transition(row.id, status, error, instance);
    this.log.info('session_transition', { id: row.id, worker_id: row.worker_id, from: row.status, to: status, error });
  }
  private async inject(row: Session, match: McpSession): Promise<void> {
    if (!this.store.claim(row, match.instanceId)) return;
    try {
      await this.mcp.execute(match.id, makeLoader(row.worker_id, row.id));
      this.log.info('loader_submitted', { id: row.id, instance_id: match.instanceId });
    } catch (error) {
      // An ambiguous HTTP outcome must never cause a second execute on this instance.
      const current = this.store.get(row.id)!;
      if (current.status === 'connected' || current.status === 'analyzing') this.change(current, 'failed', `Loader execution outcome uncertain: ${String(error)}`);
    }
  }
  private async drain(): Promise<void> {
    if (this.launching || !this.online || this.stopping) return;
    this.launching = true;
    try {
      while (this.online && !this.stopping) {
        const all = this.store.all();
        // A RAM account may only be used by one running game at a time.
        const row = all.find(candidate => candidate.status === 'pending' && !all.some(other => other.account_alias === candidate.account_alias && ['launching', 'connected', 'analyzing'].includes(other.status)));
        if (!row) break;
        if (!this.authorized.has(row.place_id) || !this.accounts.some(account => account.alias === row.account_alias)) {
          this.change(row, 'failed', 'Session is no longer authorized/configured'); continue;
        }
        let existing: McpSession[];
        try { await this.mcp.health(); existing = await this.mcp.sessions(); }
        catch (error) { this.online = false; this.log.error('queue_paused', { error: String(error) }); break; }
        this.store.baseline(row.id, existing.map(session => session.instanceId));
        this.change(row, 'launching');
        try {
          await this.ram.launch(this.accounts.find(account => account.alias === row.account_alias)!.ramAccount, row.place_id);
          this.log.info('ram_launch_requested', { id: row.id });
        } catch (error) {
          const current = this.store.get(row.id)!;
          if (current.status === 'launching') this.change(current, 'failed', String(error));
        }
      }
    } finally { this.launching = false; }
  }
}
