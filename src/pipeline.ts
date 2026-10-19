import type { McpClient, McpSession, RamClient } from './clients.js';
import type { Logger } from './logger.js';
import { makeLoader } from './loader.js';
import { ConflictError, Store, type Session } from './store.js';
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
  constructor(readonly store: Store, private launcher: Pick<RamClient, 'launch'> & { launchBatch?(games: { username: string; placeId: string }[]): Promise<void> },
    private mcp: Pick<McpClient, 'health' | 'sessions' | 'processes' | 'execute' | 'callTool'>,
    private accounts: Account[], private authorized: Set<string>, private log: Logger, private now = Date.now,
    private healthIntervalMs = 30_000, private launchTimeoutMs = 60_000,
    private injectionMode: 'project-real-autoexec' | 'mcp-execute' = 'mcp-execute') {
    // A crash between persistent claim and execute acknowledgment cannot be retried safely.
    for (const row of store.all()) {
      if (['pending', 'launching', 'connected', 'analyzing'].includes(row.status) &&
          (!authorized.has(row.place_id) || !accounts.some(account => account.alias === row.account_alias)))
        this.change(row, 'failed', 'Persisted session is no longer authorized/configured');
      else if (this.injectionMode === 'mcp-execute' && row.status === 'connected' && row.instance_id && store.claimed(row.instance_id))
        this.change(row, 'failed', 'Controller restarted before analyzing acknowledgment; execute outcome uncertain');
    }
  }

  registeredUsername(alias: string): string | undefined { return this.accounts.find(row => row.alias === alias)?.robloxUsername; }
  launchBatch(links: unknown, firstAlias: unknown): { session: Session; reused: boolean }[] {
    const first = aliasValue(firstAlias);
    const index = this.accounts.findIndex(account => account.alias === first);
    if (index < 0) throw new InputError('Unknown account alias');
    if (!Array.isArray(links) || !links.length || links.length > this.accounts.length) throw new InputError('Informe no máximo um link por conta disponível');
    const games = links.map(placeId);
    for (const game of games) if (!this.authorized.has(game)) throw new InputError(`PlaceId ${game} is not in AUTHORIZED_PLACE_IDS`);
    return links.flatMap((link, offset) => this.launch([link], this.accounts[(index + offset) % this.accounts.length]!.alias));
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
  attach(link: unknown, alias: unknown): Session {
    if (this.injectionMode !== 'project-real-autoexec') throw new InputError('Attaching requires Project Real autoexec mode');
    const account = aliasValue(alias);
    if (!this.accounts.some(row => row.alias === account)) throw new InputError('Unknown account alias');
    const game = placeId(link);
    if (!this.authorized.has(game)) throw new InputError(`PlaceId ${game} is not in AUTHORIZED_PLACE_IDS`);
    if (this.store.all().some(row => row.account_alias === account && ['pending', 'launching', 'connected', 'analyzing'].includes(row.status)))
      throw new ConflictError('This account already has an active session');
    const row = this.store.create(String(link), game, account).session;
    this.change(row, 'launching');
    this.log.info('existing_game_waiting_for_bootstrap', { id: row.id, worker_id: row.worker_id });
    return this.store.get(row.id)!;
  }
  retry(id: string): Session {
    const current = this.store.get(id);
    if (current && (!this.authorized.has(current.place_id) || !this.accounts.some(account => account.alias === current.account_alias))) throw new InputError('Session is no longer authorized/configured');
    const row = this.store.retry(id); this.log.info('retry_queued', { id }); this.kick(); return row;
  }
  registerAutoexec(username: unknown, rawPlaceId: unknown): Session {
    if (typeof username !== 'string') throw new InputError('username is required');
    const place = placeId(rawPlaceId);
    const account = this.accounts.find(row => row.robloxUsername.toLowerCase() === username.toLowerCase());
    if (!account) throw new InputError('Roblox username is not mapped in accounts.json');
    const matches = this.store.all().filter(row => row.account_alias === account.alias && row.place_id === place && ['launching', 'connected', 'analyzing'].includes(row.status));
    if (matches.length !== 1) throw new ConflictError(matches.length ? 'Ambiguous active session' : 'No launching session for this account/game');
    return matches[0]!;
  }
  private kick(): void {
    if (this.stopping) return;
    if (this.drainPromise) { this.drainRequested = true; return; }
    this.drainRequested = false;
    this.drainPromise = Promise.resolve().then(() => this.drain()).catch(error => this.log.error('queue_error', { error: String(error) })).finally(() => {
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
        sessions = await this.mcp.sessions();
        // Project Real identifies sessions by workerId; process discovery is optional.
        if (this.injectionMode === 'project-real-autoexec') {
          try { processes = await this.mcp.processes(); }
          catch (error) { processes = []; this.log.error('process_observation_unavailable', { error: String(error) }); }
        } else processes = await this.mcp.processes();
        this.online = true;
      } catch (error) {
        this.online = false; this.log.error('mcp_offline', { error: String(error) }); return;
      }
      const live = new Set(processes.map(process => process.instanceId));
      // Recover the same game after a temporary socket loss. Never resurrect a
      // historical worker after the operator has opened a newer session.
      const latest = new Map(this.store.all().map(row => [row.account_alias, row.id]));
      for (const row of this.store.all()) {
        if (row.status === 'disconnected' && this.injectionMode === 'project-real-autoexec' &&
            latest.get(row.account_alias) === row.id && this.authorized.has(row.place_id) &&
            this.accounts.some(account => account.alias === row.account_alias)) {
          const matches = sessions.filter(session => session.workerId === row.worker_id && session.instanceId === row.instance_id);
          if (matches.length === 1) this.change(row, 'connected', null, matches[0]!.instanceId);
        }
        if (row.status === 'launching') {
          const candidates = sessions.filter(session => this.injectionMode === 'project-real-autoexec'
            ? session.workerId === row.worker_id
            : live.has(session.instanceId) && session.accountAlias === row.account_alias && session.placeId === row.place_id &&
              !this.store.isBaseline(row.id, session.instanceId) && !this.store.claimed(session.instanceId) &&
              (!session.workerId || session.workerId === row.worker_id));
          // Never guess when two instances fit the same account/game.
          if (candidates.length === 1) {
            const match = candidates[0]!;
            this.change(row, 'connected', null, match.instanceId);
            if (this.injectionMode === 'mcp-execute') await this.inject(this.store.get(row.id)!, match);
            else await this.armAutoexecute(this.store.get(row.id)!, match);
          } else if (candidates.length > 1) this.log.error('ambiguous_instance', { id: row.id });
        } else if (row.status === 'connected' || row.status === 'analyzing') {
          const match = sessions.find(session => this.injectionMode === 'project-real-autoexec'
            ? session.workerId === row.worker_id
            : session.instanceId === row.instance_id && session.accountAlias === row.account_alias && session.placeId === row.place_id &&
              (!session.workerId || session.workerId === row.worker_id));
          if (!match || (this.injectionMode === 'mcp-execute' && !live.has(row.instance_id!))) this.change(row, 'disconnected', 'MCP session disappeared');
          else if (this.injectionMode === 'mcp-execute' && row.status === 'connected' && !this.store.claimed(match.instanceId)) await this.inject(row, match);
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
  private async armAutoexecute(row: Session, match: McpSession): Promise<void> {
    if (!this.store.claim(row, match.instanceId)) return;
    try {
      await this.mcp.callTool('set-autoexecute', { workerId: row.worker_id, enabled: true });
      this.log.info('autoexecute_armed', { id: row.id, worker_id: row.worker_id });
    } catch (error) {
      this.log.error('autoexecute_arm_failed', { id: row.id, worker_id: row.worker_id, error: String(error) });
    }
  }
  private async drain(): Promise<void> {
    if (this.launching || !this.online || this.stopping) return;
    this.launching = true;
    try {
      while (this.online && !this.stopping) {
        const all = this.store.all();
        // An account may only be used by one running game at a time.
        const ready = all.filter(candidate => candidate.status === 'pending' && !all.some(other => other.account_alias === candidate.account_alias && ['launching', 'connected', 'analyzing'].includes(other.status)));
        const row = ready[0];
        if (!row) break;
        if (!this.authorized.has(row.place_id) || !this.accounts.some(account => account.alias === row.account_alias)) {
          this.change(row, 'failed', 'Session is no longer authorized/configured'); continue;
        }
        let existing: McpSession[];
        try { await this.mcp.health(); existing = await this.mcp.sessions(); }
        catch (error) { this.online = false; this.log.error('queue_paused', { error: String(error) }); break; }
        const seen = new Set<string>();
        const batch = this.launcher.launchBatch ? ready.filter(candidate => {
          if (seen.has(candidate.account_alias) || !this.authorized.has(candidate.place_id) || !this.accounts.some(account => account.alias === candidate.account_alias)) return false;
          seen.add(candidate.account_alias); return true;
        }).slice(0, 10) : [row];
        for (const candidate of batch) {
          this.store.baseline(candidate.id, existing.map(session => session.instanceId));
          this.change(candidate, 'launching');
        }
        try {
          if (batch.length > 1 && this.launcher.launchBatch) await this.launcher.launchBatch(batch.map(candidate => ({
            username: this.accounts.find(account => account.alias === candidate.account_alias)!.ramAccount, placeId: candidate.place_id,
          })));
          else await this.launcher.launch(this.accounts.find(account => account.alias === row.account_alias)!.ramAccount, row.place_id);
          for (const candidate of batch) this.log.info('roblox_launch_requested', { id: candidate.id });
        } catch (error) {
          for (const candidate of batch) {
            const current = this.store.get(candidate.id)!;
            if (current.status === 'launching') this.change(current, 'failed', String(error));
          }
        }
      }
    } finally { this.launching = false; }
  }
}
