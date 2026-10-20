import { renameSync, writeFileSync } from 'node:fs';
import type { Account } from './validation.js';
import { ConflictError } from './store.js';
import { parseAccounts } from './validation.js';

export class AccountRegistry {
  constructor(private file: string, readonly values: Account[]) {}

  prepareUsernames(usernames: string[]): Account[] {
    const next = [...this.values];
    for (const username of usernames) {
      if (next.some(row => row.robloxUsername.toLowerCase() === username.toLowerCase())) continue;
      if (next.some(row => row.alias.toLowerCase() === username.toLowerCase() || row.ramAccount.toLowerCase() === username.toLowerCase()))
        throw new ConflictError('Username conflicts with an existing account alias');
      next.push(parseAccounts([{ alias: username, ramAccount: username, robloxUsername: username }])[0]!);
    }
    return next;
  }

  addUsernames(usernames: string[]): void {
    const next = this.prepareUsernames(usernames);
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
    this.values.splice(0, this.values.length, ...next);
  }

  add(alias: unknown, username: unknown): Account {
    const candidate = parseAccounts([{ alias, ramAccount: username, robloxUsername: username }])[0]!;
    const duplicate = this.values.find(row => row.alias.toLowerCase() === candidate.alias.toLowerCase() ||
      row.ramAccount.toLowerCase() === candidate.ramAccount.toLowerCase());
    if (duplicate) {
      if (duplicate.alias === candidate.alias && duplicate.ramAccount.toLowerCase() === candidate.ramAccount.toLowerCase()) return duplicate;
      throw new ConflictError('Account alias or RAM username is already configured');
    }
    const next = [...this.values, candidate];
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.file);
    this.values.push(candidate);
    return candidate;
  }
}
