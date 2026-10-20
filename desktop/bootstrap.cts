import { app, dialog } from 'electron';
import { desktopLogFile, logDesktop } from './diagnostics.cjs';

process.on('uncaughtExceptionMonitor', error => logDesktop('uncaught_exception', error));

void import('./main.js').catch(error => {
  logDesktop('startup_failed', error);
  dialog.showErrorBox('Multi Execute', `Não foi possível abrir o aplicativo.\n\n${error instanceof Error ? error.message : String(error)}\n\nDiagnóstico: ${desktopLogFile()}`);
  app.quit();
});
