/**
 * Testa o proxy configurado antes do primeiro login.
 *
 * Uso:
 *   npm run check:proxy
 *   npm run check:proxy -- usuario:senha@host:porta
 *
 * Sem argumento le BROWSER_PROXY_* do ambiente/.env, o mesmo que a janela de
 * login usa. Sai com codigo 1 quando o proxy nao responde, para encadear em
 * script de compra/validacao.
 */
import { pathToFileURL } from 'node:url';
import { checkProxy, formatProxyCheck } from './proxy-check.js';
import { loadRobloxLoginOptions, type BrowserProxy } from './roblox-login.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [explicit] = argv;
  let proxy: BrowserProxy | undefined;
  try {
    proxy = explicit
      ? { server: explicit.includes('://') ? explicit : `http://${explicit}` }
      : loadRobloxLoginOptions().proxy;
    if (!proxy) {
      console.error('Nenhum proxy configurado.');
      console.error('Defina BROWSER_PROXY_SERVER (+ _USERNAME/_PASSWORD) no .env, ou passe um argumento:');
      console.error('  npm run check:proxy -- usuario:senha@host:porta');
      return 1;
    }
    // Valida o formato antes de tentar rede: um host sem porta daria erro
    // obscuro de conexao em vez de dizer o que esta errado.
    const result = await checkProxy(proxy);
    console.log(formatProxyCheck(result, proxy));
    if (!result.ok) return 1;
    if (result.datacenter) {
      console.log('\nEste IP e de datacenter/hosting. No Roblox isso costuma render');
      console.log('captcha mais frequente e mais dificil. Prefira residencial estatico.');
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(code => { process.exitCode = code; });
}
