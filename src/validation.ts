export class InputError extends Error {}

export function placeId(input: unknown): string {
  if (typeof input !== 'string') throw new InputError('PlaceId/link must be a string');
  const value = input.trim();
  if (/^\d{6,15}$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new InputError('Expected 6–15 digits or a Roblox /games/{id} URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || !['roblox.com', 'www.roblox.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port)
    throw new InputError('Expected a Roblox game URL');
  const match = /^\/games\/(\d{6,15})(?:\/[^/]*)?\/?$/.exec(url.pathname);
  if (!match) throw new InputError('Only /games/{id} URLs are allowed; profiles, groups and catalog are rejected');
  return match[1]!;
}

export function aliasValue(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input)) throw new InputError('Invalid account alias');
  return input;
}

export interface Account { alias: string; ramAccount: string; robloxUsername: string }
export function parseAccounts(value: unknown): Account[] {
  if (!Array.isArray(value)) throw new InputError('accounts.json must be an array');
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new InputError('Invalid account entry');
    const row = raw as Record<string, unknown>;
    const alias = aliasValue(row.alias);
    if (seen.has(alias)) throw new InputError(`Duplicate alias: ${alias}`);
    seen.add(alias);
    if (typeof row.ramAccount !== 'string' || !row.ramAccount.trim()) throw new InputError(`Missing RAM account: ${alias}`);
    if (typeof row.robloxUsername !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(row.robloxUsername)) throw new InputError(`Missing/invalid Roblox username: ${alias}`);
    return { alias, ramAccount: row.ramAccount, robloxUsername: row.robloxUsername };
  });
}
