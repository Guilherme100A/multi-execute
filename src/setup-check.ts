import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, extname } from 'node:path';

export type SetupItem = {
  id: string; label: string; status: 'ok' | 'missing' | 'attention' | 'optional';
  detail: string; required: boolean;
};
export type SetupReport = { checkedAt: string; ready: boolean; passed: number; total: number; items: SetupItem[] };
type SetupOptions = {
  realMcpExecutable: string; autoConnect: boolean; authorized: Set<string>;
  accounts: unknown[]; accountsFile: string; agentCliCommand: string; claudeCliCommand: string;
};

async function isFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

export async function installedCommand(command: string, env = process.env, platform = process.platform): Promise<boolean> {
  const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32' && !extname(command)
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const candidates = directories.flatMap(directory => extensions.map(extension => join(directory.replace(/^"|"$/g, ''), `${command}${extension}`)));
  return (await Promise.all(candidates.map(isFile))).some(Boolean);
}

async function robloxInstalled(env: NodeJS.ProcessEnv): Promise<boolean> {
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const versions = join(root, 'Roblox', 'Versions');
    try {
      const directories = (await readdir(versions, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('version-'));
      if ((await Promise.all(directories.map(directory => isFile(join(versions, directory.name, 'RobloxPlayerBeta.exe'))))).some(Boolean)) return true;
    } catch { /* Check the other standard installation folders. */ }
  }
  return false;
}

export async function inspectSetup(config: SetupOptions, selectedProvider = 'codex', env = process.env): Promise<SetupReport> {
  const [roblox, real, powershell, codex, claude] = await Promise.all([
    robloxInstalled(env), isFile(config.realMcpExecutable), installedCommand('powershell.exe', env),
    installedCommand(config.agentCliCommand, env), installedCommand(config.claudeCliCommand, env),
  ]);
  let accountsFileAccessible = false;
  try { await access(config.accountsFile, constants.R_OK | constants.W_OK); accountsFileAccessible = true; } catch { /* Shown below. */ }
  const windows = process.platform === 'win32';
  const nodeCompatible = Number(process.versions.node.split('.')[0]) >= 24;
  const providerInstalled = selectedProvider === 'claude' ? claude : codex;
  const items: SetupItem[] = [
    { id: 'windows', label: 'Windows', status: windows ? 'ok' : 'missing', required: true,
      detail: windows ? 'Sistema compatível com o aplicativo.' : 'A abertura dos jogos requer Windows.' },
    { id: 'runtime', label: 'Runtime do aplicativo', status: nodeCompatible ? 'ok' : 'missing', required: true,
      detail: `Node.js ${process.versions.node}${process.versions.electron ? ' incluído no app.' : ' — requer versão 24 ou superior.'}` },
    { id: 'powershell', label: 'Windows PowerShell', status: powershell ? 'ok' : 'missing', required: true,
      detail: powershell ? 'Disponível para as operações locais.' : 'powershell.exe não foi encontrado no PATH do aplicativo.' },
    { id: 'roblox', label: 'Roblox Player', status: roblox ? 'ok' : 'missing', required: true,
      detail: roblox ? 'Cliente encontrado neste computador.' : 'Não encontrado nas pastas padrão. Instale o Roblox Player e verifique novamente.' },
    { id: 'real', label: 'Project Real', status: real ? 'ok' : config.autoConnect ? 'missing' : 'optional', required: config.autoConnect,
      detail: real ? 'Conector encontrado. Mantenha o Real aberto com o MCP habilitado.' : config.autoConnect ? 'Conector não encontrado na instalação configurada do Real.' : 'Conexão automática desativada nesta configuração.' },
    { id: 'codex', label: 'Codex CLI', status: codex ? 'ok' : selectedProvider === 'codex' ? 'missing' : 'optional', required: selectedProvider === 'codex',
      detail: codex ? 'Encontrada no PATH. O login deve estar feito na CLI.' : 'CLI não encontrada no PATH. Instale-a e reabra o app para carregar o PATH atualizado.' },
    { id: 'claude', label: 'Claude Code', status: claude ? 'ok' : selectedProvider === 'claude' ? 'missing' : 'optional', required: selectedProvider === 'claude',
      detail: claude ? 'Encontrada no PATH. O login deve estar feito na CLI.' : 'Alternativa ao Codex CLI; necessária apenas quando selecionada nos terminais.' },
    { id: 'games', label: 'Jogos autorizados', status: config.authorized.size ? 'ok' : 'attention', required: true,
      detail: config.authorized.size ? `${config.authorized.size} jogo(s) configurado(s).` : 'Adicione os PlaceIds em Configurações na barra superior.' },
    { id: 'accounts', label: 'Contas de teste', status: config.accounts.length ? 'ok' : 'attention', required: true,
      detail: config.accounts.length ? `${config.accounts.length} conta(s) cadastrada(s). A validade da sessão é confirmada ao usar a conta.` : 'Adicione uma conta na aba Contas para começar.' },
    { id: 'storage', label: 'Configuração local', status: accountsFileAccessible ? 'ok' : 'attention', required: true,
      detail: accountsFileAccessible ? 'Arquivo de contas disponível para leitura e gravação.' : 'O aplicativo não conseguiu acessar o arquivo local de contas.' },
  ];
  const required = items.filter(item => item.required);
  const passed = required.filter(item => item.status === 'ok').length;
  return { checkedAt: new Date().toISOString(), ready: passed === required.length && providerInstalled, passed, total: required.length, items };
}
