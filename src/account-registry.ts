import { renameSync, writeFileSync } from 'node:fs';
import type { Account } from './validation.js';
import { ConflictError } from './store.js';
import { parseAccounts } from './validation.js';

export class AccountRegistry {
  constructor(private file: string, readonly values: Account[]) {}

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
