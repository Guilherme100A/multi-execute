import { readFile, writeFile, rename, mkdir, copyFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XMLValidator } from 'fast-xml-parser';
import { InputError } from './validation.js';
import { ConflictError } from './store.js';

export type RobloxPreferences = {
  fpsCap: number | null; masterVolume: number | null; fullscreen: boolean | null;
  graphicsQuality: number | null; hideImages: boolean; maxRecentGames: number;
};
export const defaultRobloxPreferences: RobloxPreferences = {
  fpsCap: null, masterVolume: null, fullscreen: null, graphicsQuality: null, hideImages: false, maxRecentGames: 8,
};

export function parseRobloxPreferences(value: unknown): RobloxPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Configurações inválidas.');
  if (Object.keys(value).some(key => !Object.hasOwn(defaultRobloxPreferences, key))) throw new InputError('Opção de configuração desconhecida.');
  const next = { ...defaultRobloxPreferences, ...value } as RobloxPreferences;
  const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  if (next.fpsCap !== null && next.fpsCap !== -1 && !integer(next.fpsCap, 30, 480)) throw new InputError('O limite de FPS deve ficar entre 30 e 480, ou Automático.');
  if (next.masterVolume !== null && !integer(next.masterVolume, 0, 100)) throw new InputError('O volume deve ficar entre 0 e 100.');
  if (next.graphicsQuality !== null && !integer(next.graphicsQuality, 0, 10)) throw new InputError('A qualidade gráfica deve ficar entre 0 e 10.');
  if (next.fullscreen !== null && typeof next.fullscreen !== 'boolean') throw new InputError('A opção de tela cheia é inválida.');
  if (typeof next.hideImages !== 'boolean' || !integer(next.maxRecentGames, 1, 50)) throw new InputError('As preferências de interface são inválidas.');
  return next;
}

function settingsBlock(xml: string): string {
  if (xml.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new InputError('O arquivo de configurações do Roblox não contém XML válido.');
  const blocks = [...xml.matchAll(/<Item\b(?=[^>]*\bclass=["']UserGameSettings["'])[^>]*>[\s\S]*?<\/Item>/g)];
  if (blocks.length !== 1) throw new InputError('Não foi encontrada uma configuração única de usuário do Roblox.');
  return blocks[0]![0];
}

function property(tag: string, name: string): RegExp {
  return new RegExp(`(<${tag}\\b[^>]*\\bname=["']${name}["'][^>]*>)([^<]*)(<\\/${tag}>)`, 'g');
}

export function updateRobloxXml(xml: string, settings: RobloxPreferences): string {
  let block = settingsBlock(xml);
  const original = block;
  const updates: [string, string, number | boolean | null][] = [
    ['int', 'FramerateCap', settings.fpsCap], ['float', 'MasterVolume', settings.masterVolume === null ? null : settings.masterVolume / 100],
    ['bool', 'Fullscreen', settings.fullscreen], ['token', 'SavedQualityLevel', settings.graphicsQuality],
  ];
  let changes = 0;
  for (const [tag, name, value] of updates) {
    if (value === null) continue;
    const pattern = property(tag, name);
    if ([...block.matchAll(pattern)].length !== 1) throw new InputError(`A configuração ${name} não está disponível nesta versão do Roblox.`);
    block = block.replace(pattern, (_match, start: string, _previous: string, end: string) => `${start}${String(value)}${end}`);
    changes++;
  }
  if (!changes) throw new InputError('Escolha ao menos uma configuração do Roblox para aplicar.');
  const updated = xml.replace(original, () => block);
  if (XMLValidator.validate(updated) !== true) throw new InputError('Não foi possível validar a configuração resultante.');
  return updated;
}

async function robloxRunning(): Promise<boolean> {
  if (process.platform !== 'win32') throw new InputError('Aplicar configurações requer Windows.');
  try {
    const result = await promisify(execFile)('tasklist.exe', ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    return /"RobloxPlayerBeta\.exe"/i.test(result.stdout);
  } catch { throw new ConflictError('Não foi possível confirmar se o Roblox está fechado. Tente novamente.'); }
}

export class RobloxSettings {
  private writing = false;
  constructor(private preferencesFile: string, private clientFile: string, private isRunning = robloxRunning) {}

  async preferences(): Promise<RobloxPreferences> {
    try { return parseRobloxPreferences(JSON.parse(await readFile(this.preferencesFile, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultRobloxPreferences };
      throw error;
    }
  }

  async snapshot() {
    const preferences = await this.preferences();
    try {
      const block = settingsBlock(await this.readClient());
      const read = (tag: string, name: string) => [...block.matchAll(property(tag, name))][0]?.[2]?.trim() ?? null;
      const number = (tag: string, name: string) => { const value = read(tag, name); return value === null || !Number.isFinite(Number(value)) ? null : Number(value); };
      const volume = number('float', 'MasterVolume');
      return { preferences, client: { available: true, values: { fpsCap: number('int', 'FramerateCap'), masterVolume: volume === null ? null : Math.round(volume * 100),
        fullscreen: read('bool', 'Fullscreen') === 'true', graphicsQuality: number('token', 'SavedQualityLevel') }, error: null } };
    } catch (error) {
      return { preferences, client: { available: false, values: null, error: error instanceof InputError ? error.message : 'Abra o Roblox uma vez para gerar as configurações locais.' } };
    }
  }

  async save(value: unknown): Promise<RobloxPreferences> {
    if (this.writing) throw new ConflictError('Outra alteração está em andamento.');
    this.writing = true;
    try {
      const next = parseRobloxPreferences(value);
      await mkdir(dirname(this.preferencesFile), { recursive: true });
      const temporary = `${this.preferencesFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.preferencesFile);
      return next;
    } finally { this.writing = false; }
  }

  private async readClient(): Promise<string> {
    if ((await stat(this.clientFile)).size > 1024 * 1024) throw new InputError('O arquivo de configurações do Roblox está acima do tamanho esperado.');
    return readFile(this.clientFile, 'utf8');
  }

  async apply(): Promise<void> {
    if (this.writing) throw new ConflictError('Outra alteração está em andamento.');
    this.writing = true;
    try {
      if (await this.isRunning()) throw new ConflictError('Feche todas as janelas do Roblox antes de aplicar. Elas não serão fechadas automaticamente.');
      let original: string;
      try { original = await this.readClient(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InputError('Abra o Roblox uma vez e feche-o para gerar as configurações locais.'); throw error; }
      const updated = updateRobloxXml(original, await this.preferences());
      if (await this.isRunning() || await this.readClient() !== original) throw new ConflictError('O Roblox ou suas configurações mudaram durante a operação. Feche-o e tente novamente.');
      try { await copyFile(this.clientFile, `${this.clientFile}.multi-execute.bak`, constants.COPYFILE_EXCL); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const temporary = `${this.clientFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, updated, { mode: 0o600 });
      await rename(temporary, this.clientFile);
    } finally { this.writing = false; }
  }
}
