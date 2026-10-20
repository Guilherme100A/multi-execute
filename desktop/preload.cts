import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('multiExecute', {
  settings: () => ipcRenderer.invoke('settings:read') as Promise<{ authorizedPlaceIds: string[]; error: string | null }>,
  saveSettings: (authorizedPlaceIds: string[]) => ipcRenderer.invoke('settings:save', { authorizedPlaceIds }) as Promise<{ ok: boolean; error?: string }>,
});

window.addEventListener('DOMContentLoaded', () => {
  const styles = document.createElement('style');
  styles.textContent = `
    :root { --bg: #000; --line: #000; color-scheme: dark; background: #000 !important; }
    *, *::before, *::after { border: 0 !important; }
    html { overflow: hidden; scrollbar-width: none; }
    body { background: #000 !important; padding-top: 38px; height: 100dvh; overflow: hidden; }
    * { scrollbar-width: none !important; }
    *::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .desktop-titlebar { position: fixed; inset: 0 0 auto; height: 38px; display: flex;
      align-items: center; justify-content: space-between; padding: 0 150px 0 18px;
      z-index: 10000; background: #000; border-radius: 28px 28px 0 0; color: #777; font: 11px 'Segoe UI', sans-serif;
      user-select: none; -webkit-app-region: drag; }
    .desktop-titlebar button { -webkit-app-region: no-drag; background: transparent;
      border: 0; border-radius: 6px; color: #999; font: 11px 'Segoe UI', sans-serif;
      padding: 5px 9px; cursor: pointer; }
    .desktop-titlebar button:hover { background: #191919; color: #eee; }
    .desktop-titlebar button:focus-visible { outline: 1px solid #777; outline-offset: 2px; }
    .desktop-titlebar a { -webkit-app-region: no-drag; }
    .shell { padding: 16px 20px 16px; height: calc(100dvh - 38px); display: flex; flex-direction: column; overflow: hidden; }
    .shell > header { padding-bottom: 16px; margin-bottom: 18px; flex-shrink: 0; }
    .brand-logo { width: 38px; height: 38px; }
    .brand-lockup h1 { font-size: 24px; }
    #dashboard { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 18px; flex: 1; min-height: 0; overflow: hidden; }
    #dashboard > .app-nav { display: flex; flex-direction: column; flex-wrap: nowrap;
      align-items: stretch; gap: 7px; margin: 0; padding-right: 16px;
      border-right: 1px solid #222; min-height: 0; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
    .app-nav .nav-button { text-align: left; white-space: normal; line-height: 1.5;
      padding: 10px; font-size: 11px; }
    .app-nav .feed-state { margin: 16px 0 0; padding: 0 8px; font-size: 10px; line-height: 1.6; }
    #dashboard > .view { min-width: 0; min-height: 0; height: 100%; overflow: auto; overscroll-behavior: contain; padding-bottom: 14px; }
    body > main { max-height: calc(100dvh - 66px); overflow: auto; }
    body:has(> header) { display: flex; flex-direction: column; }
    body > header { flex-shrink: 0; }
    body:has(> header) > main { flex: 1; min-height: 0; max-height: none; }
    .launch { grid-template-columns: 1fr; padding: 22px; }
    .accounts-panel { padding: 20px; }
    .account-grid { grid-template-columns: 1fr; gap: 16px; }
    .account-methods button { padding: 16px; }
    .account-grid .account-form { padding: 20px; }
    .terminal-grid { grid-template-columns: 1fr; }
    .card, .account-grid .account-form, .setup-panel, .roblox-settings-panel,
    .session, .launch-fields, .txt-import, body > main { border-radius: 20px; }
    .account-methods button, .setup-summary, .setup-item, .workspace-tabs button { border-radius: 15px; }
    input, textarea, select, .app-nav .nav-button { border-radius: 11px; }
    .card, .account-grid .account-form, .account-methods button, .workspace-tabs button,
    .launch-fields, .worker-terminal-head { box-shadow: none !important; }

    :root { --desktop-ease: cubic-bezier(.22, 1, .36, 1); }
    .shell, body > main { animation: desktop-arrive 550ms var(--desktop-ease) both; }
    .view:not([hidden]) { animation: desktop-panel-enter 380ms var(--desktop-ease) both; }
    .view:not([hidden]) .section-title { animation: desktop-panel-enter 450ms var(--desktop-ease) both; }
    .view:not([hidden]) .account-methods { animation: desktop-panel-enter 480ms 45ms var(--desktop-ease) both; }
    .view:not([hidden]) .account-form { animation: desktop-panel-enter 520ms 80ms var(--desktop-ease) both; }
    .view:not([hidden]) .account-form:nth-child(2) { animation-delay: 135ms; }
    button { position: relative; overflow: hidden;
      transition: background 200ms, border-color 200ms, box-shadow 220ms, transform 240ms var(--desktop-ease); }
    button:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 5px 18px #ffffff0a; }
    button:not(:disabled):active { transform: translateY(0) scale(.97); transition-duration: 90ms; }
    .app-nav .nav-button { position: relative; transition: background 220ms, color 220ms, transform 260ms var(--desktop-ease); }
    .app-nav .nav-button:not(:disabled):hover { transform: translateX(3px); box-shadow: none; }
    .app-nav .nav-button.active { background: linear-gradient(110deg, #252525, #151515); }
    .app-nav .nav-button::before { content: ''; position: absolute; left: 0; top: 24%;
      width: 2px; height: 52%; background: #ccc; border-radius: 3px; opacity: 0;
      transform: scaleY(.25); transition: opacity 220ms, transform 320ms var(--desktop-ease); }
    .app-nav .nav-button.active::before { opacity: 1; transform: scaleY(1); }
    .card, .account-form, .account-methods button, .launch-fields {
      transition: border-color 240ms, box-shadow 240ms, transform 260ms var(--desktop-ease); }
    .card:hover { border-color: #000; }
    .card, .account-form, .account-methods button, .launch-fields, .session,
    .setup-panel, .setup-summary, .setup-item, .setup-item-symbol, .setup-summary-symbol,
    input, textarea, select { border-color: #000 !important; }
    .app-nav, .shell > header, .setup-note { border-color: #000 !important; }
    input, textarea, select { transition: border-color 220ms, box-shadow 220ms, background 220ms; }
    input:focus, textarea:focus, select:focus { box-shadow: 0 0 0 3px #ffffff08; }
    .dot.online, .worker-live.online { animation: desktop-live 2400ms ease-in-out infinite; }
    .workspace-tabs button.active { animation: desktop-tab-select 320ms var(--desktop-ease); }
    .error:not(:empty), .message:not(:empty) { animation: desktop-panel-enter 260ms var(--desktop-ease); }
    .desktop-ripple { position: absolute; pointer-events: none; border-radius: 50%;
      background: currentColor; opacity: .16; transform: scale(0); }
    @keyframes desktop-arrive { from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); } }
    @keyframes desktop-panel-enter { from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); } }
    @keyframes desktop-live { 0%, 100% { box-shadow: 0 0 0 0 #ffffff00; }
      45% { box-shadow: 0 0 0 4px #ffffff0c; } }
    @keyframes desktop-tab-select { from { transform: translateY(3px) scale(.98); }
      to { transform: translateY(0) scale(1); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  `;
  document.head.append(styles);
  const titlebar = document.createElement('div');
  titlebar.className = 'desktop-titlebar';
  const title = document.createElement('span');
  title.textContent = 'Multi Execute';
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.textContent = 'Configurações';
  settings.addEventListener('click', () => ipcRenderer.send('window:settings'));
  titlebar.append(title, settings);
  document.body.prepend(titlebar);

  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled || button.closest('.desktop-titlebar')) return;
    const bounds = button.getBoundingClientRect();
    const size = Math.max(bounds.width, bounds.height) * 2;
    const ripple = document.createElement('span');
    ripple.className = 'desktop-ripple';
    ripple.setAttribute('aria-hidden', 'true');
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - bounds.left - size / 2}px`;
    ripple.style.top = `${event.clientY - bounds.top - size / 2}px`;
    button.append(ripple);
    const animation = ripple.animate([{ transform: 'scale(0)', opacity: .16 },
      { transform: 'scale(1)', opacity: 0 }], { duration: 500, easing: 'cubic-bezier(.2,.6,.3,1)' });
    void animation.finished.catch(() => {}).finally(() => ripple.remove());
  });
});
