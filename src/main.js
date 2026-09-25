'use strict';

// Processo principale di Electron: avvia il servizio SonoPrint, apre la finestra e (su Windows)
// l'icona accanto all'orologio. Chiudendo la finestra SonoPrint può restare attivo in background.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Tray, Notification, dialog, shell, powerSaveBlocker, powerMonitor, session, nativeImage } = require('electron');
const { startServer } = require('./server');
const { Updater, fileLogger } = require('./updater');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
// su Mac chiudendo la finestra SonoPrint resta nel Dock (e le stampe USB continuano); si esce con Cmd+Q
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// argomento con cui Windows avvia SonoPrint all'accesso: parte nascosto, in background
const BACKGROUND_ARG = '--background';
const LOGIN_NAME = 'SonoPrint';

let server = null;
let updater = null;
let win = null;
let tray = null;
let sleepBlocker = null;
let quitting = false;
// Windows sta chiudendo la sessione (uscita dall'account, spegnimento): niente conferme né background
let sessionEnding = false;
let log = { info() {}, warn() {}, error() {} };

// profilo separato (utile per provare una seconda copia senza toccare quella in uso)
if (process.env.SONOPRINT_USER_DATA) app.setPath('userData', process.env.SONOPRINT_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  // SonoPrint è già aperto: porta in primo piano quella finestra
  app.quit();
} else {
  // registro di avvii, chiusure e problemi: serve a capire perché SonoPrint si è chiuso
  log = fileLogger(path.join(app.getPath('userData'), 'logs', 'sonoprint.log'));
  log.info(`SonoPrint ${app.getVersion()} avviato (pid ${process.pid}${startedAtLogin() ? ', all\'accesso' : ''}${process.env.SESSIONNAME ? ', sessione ' + process.env.SESSIONNAME : ''})`);
  // un errore inatteso non deve chiudere SonoPrint (e fermare le stampe USB): si annota e si va avanti
  process.on('uncaughtException', (err) => log.error('Errore non gestito:', err));
  process.on('unhandledRejection', (err) => log.error('Promessa rifiutata non gestita:', err));
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch((err) => {
    log.error('Avvio non riuscito:', err);
    dialog.showErrorBox('SonoPrint non si è avviato', String(err && err.stack || err));
    app.quit();
  });
}

async function start() {
  app.setAppUserModelId('com.sonozero.sonoprint');
  Menu.setApplicationMenu(IS_MAC ? macMenu() : null);
  if (IS_MAC) app.setAboutPanelOptions({ applicationName: 'SonoPrint', applicationVersion: app.getVersion(), copyright: 'made by sonozero' });

  migrateFromPolipo();
  updater = new Updater(app);
  server = await startServer({
    dataDir: path.join(app.getPath('userData'), 'data'),
    appInfo: updater,
    // eseguibile installato, per la regola del firewall di Windows (non per npm start)
    appExe: app.isPackaged ? process.execPath : null,
    desktop: {
      info: desktopInfo,
      apply: applyLoginItem,
      openLogs: () => {
        shell.openPath(path.join(app.getPath('userData'), 'logs'));
        return { ok: true };
      },
    },
  });

  // porta cambiata dalle impostazioni: ricarica l'interfaccia al nuovo indirizzo
  server.events.on('url-changed', (url) => {
    setTimeout(() => { if (win) win.loadURL(url + '#/settings'); }, 900);
  });

  let notifiedVersion = null;
  updater.on('change', (s) => {
    if (s.status !== 'downloaded' || notifiedVersion === s.version || !Notification.isSupported()) return;
    notifiedVersion = s.version;
    const notif = new Notification({
      title: 'Aggiornamento di SonoPrint pronto',
      body: `La versione ${s.version} verrà installata al prossimo riavvio.`,
      icon: nativeImage.createFromPath(ICON),
    });
    notif.on('click', () => showWindow('#/updates'));
    notif.show();
  });
  updater.init();

  // webcam e notifiche consentite solo all'interfaccia di SonoPrint
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromUs = (details.requestingUrl || '').startsWith(origin());
    callback(fromUs && ['media', 'notifications', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return requestingOrigin === origin() && ['media', 'notifications', 'fullscreen'].includes(permission);
  });

  server.events.on('notify', (n) => {
    if (n.quiet || !server.manager.settings.notifications || !Notification.isSupported()) return;
    const notif = new Notification({ title: n.title || 'SonoPrint', body: n.message || '', icon: nativeImage.createFromPath(ICON) });
    notif.on('click', () => showWindow(n.printerId ? `#/printer/${String(n.printerId).replace(/[^\w-]/g, '')}` : null));
    notif.show();
  });

  server.events.on('printing-changed', onPrintingChanged);
  server.manager.on('settings-changed', updateSleepBlocker);
  let trayTimer = null;
  server.manager.on('printer-update', () => {
    if (trayTimer) return;
    trayTimer = setTimeout(() => { trayTimer = null; updateTray(); }, 10000);
  });

  applyLoginItem(server.manager.settings);
  watchProcesses();
  if (IS_WIN) createTray();

  // avviato con il computer: resta nascosto (su Windows accanto all'orologio, su Mac nel Dock)
  if (startedAtLogin() && IS_MAC) return;
  createWindow({ show: !startedAtLogin() });
}

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0c0e',
    title: windowTitle(),
    icon: ICON,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.loadURL(server.url);
  // il titolo lo decide SonoPrint: durante una stampa lo vede anche Windows se si prova a uscire
  win.on('page-title-updated', (e) => e.preventDefault());

  // i link esterni si aprono nel browser, la finestra resta su SonoPrint
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin())) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin())) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  // su Windows chiudere la finestra la nasconde (SonoPrint resta in background) oppure chiude SonoPrint,
  // con la conferma se una stampa USB è in corso
  win.on('close', (e) => {
    if (IS_MAC || quitting || sessionEnding || !server) return;
    e.preventDefault();
    if (server.manager.settings.runInBackground) {
      win.hide();
      backgroundHint();
    } else {
      app.quit();
    }
  });
  win.on('closed', () => { win = null; });

  // Windows chiede di chiudere la sessione: con una stampa USB in corso si blocca, così
  // Windows mostra che SonoPrint sta stampando e chi esce dall'account può ripensarci
  win.on('query-session-end', (e) => {
    const active = server ? server.manager.activeLocalPrints() : [];
    const block = active.length > 0 && !e.reasons.includes('critical');
    log.warn(`Windows vuole chiudere la sessione (${e.reasons.join(', ') || 'spegnimento'})${block ? `: bloccato, stampa in corso su ${active.join(', ')}` : ''}`);
    if (block) e.preventDefault();
  });
  win.on('session-end', (e) => {
    sessionEnding = true;
    log.warn(`Windows chiude la sessione (${e.reasons.join(', ') || 'spegnimento'})`);
    if (server) server.manager.noteSessionEnd(e.reasons.includes('logoff') ? 'logoff' : 'shutdown');
  });

  // l'interfaccia si è chiusa da sola (memoria, scheda video): si ricarica, le stampe non ne risentono
  win.webContents.on('render-process-gone', (e, d) => {
    log.error(`Interfaccia chiusa: ${d.reason} (codice ${d.exitCode})`);
    if (d.reason !== 'clean-exit' && !quitting) setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
  win.on('unresponsive', () => log.warn('La finestra non risponde'));
  win.on('responsive', () => log.info('La finestra risponde di nuovo'));
}

/** Mostra la finestra (ricreandola se era stata chiusa), eventualmente su una pagina. */
function showWindow(hash) {
  if (!server) return;
  const go = () => { if (hash && win) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`); };
  if (!win) {
    createWindow();
    win.webContents.once('did-finish-load', go);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  go();
}

/** Vero se si può uscire: nessuna stampa USB in corso, oppure l'utente conferma di interromperle. */
function confirmStopPrints() {
  const active = server ? server.manager.activeLocalPrints() : [];
  if (!active.length) return true;
  const options = {
    type: 'warning',
    title: 'Stampe in corso',
    message: `Stampa in corso su: ${active.join(', ')}.`,
    detail: 'Le stampanti USB ricevono la stampa riga per riga da SonoPrint: se lo chiudi, quelle stampe si interrompono. Le stampanti in rete continuano da sole.\nVuoi davvero uscire?',
    buttons: ['Non chiudere', 'Esci e interrompi le stampe'],
    defaultId: 0,
    cancelId: 0,
  };
  // con la finestra nascosta la domanda compare da sola, non dentro una finestra invisibile
  const parent = win && win.isVisible() ? win : null;
  return (parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options)) === 1;
}

// --- background e avvio con il computer ----------------------------------------------

/** Vero se SonoPrint è stato avviato dal sistema all'accesso (non aperto a mano). */
function startedAtLogin() {
  if (IS_MAC) {
    try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch (_) { return false; }
  }
  return process.argv.includes(BACKGROUND_ARG);
}

function loginOptions() {
  // la versione portable si avvia dal suo file .exe, non dalla cartella temporanea in cui si estrae
  return IS_WIN ? { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [BACKGROUND_ARG] } : {};
}

const loginSupported = () => app.isPackaged && (IS_WIN || IS_MAC);
let loginWanted = null;

/** Allinea l'avvio con il computer all'impostazione di SonoPrint. */
function applyLoginItem(settings) {
  if (!loginSupported()) return;
  const want = !!settings.startAtLogin;
  // acceso adesso dall'utente: vale anche se in passato era stato disattivato da Gestione attività
  const switchedOn = want && loginWanted === false;
  loginWanted = want;
  const now = app.getLoginItemSettings(loginOptions());
  // su Windows si riscrive anche se c'è già: il percorso dell'app può essere cambiato
  if (!want && !now.openAtLogin) return;
  app.setLoginItemSettings({
    ...loginOptions(),
    ...(IS_WIN ? { name: LOGIN_NAME } : {}),
    ...(IS_WIN && switchedOn ? { enabled: true } : {}),
    openAtLogin: want,
  });
  if (want !== now.openAtLogin) log.info(want ? 'Avvio con il computer attivato' : 'Avvio con il computer disattivato');
}

/** Cosa sa fare l'app desktop, per le impostazioni dell'interfaccia. */
function desktopInfo() {
  let loginBlocked = false;
  if (loginSupported()) {
    try {
      const s = app.getLoginItemSettings(loginOptions());
      // Windows: disattivato da Gestione attività; Mac: da approvare nelle Impostazioni di sistema
      loginBlocked = IS_WIN ? (s.openAtLogin && s.executableWillLaunchAtLogin === false) : s.status === 'requires-approval';
    } catch (_) { /* ignora */ }
  }
  return { tray: IS_WIN, loginItem: loginSupported(), loginBlocked, logs: true };
}

/** La prima volta che la finestra si chiude restando in background, lo spiega con una notifica. */
function backgroundHint() {
  const marker = path.join(app.getPath('userData'), 'background-hint-shown');
  if (!missing(marker) || !Notification.isSupported()) return;
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch (_) { /* ignora */ }
  const notif = new Notification({
    title: 'SonoPrint è ancora attivo',
    body: 'Continua in background: lo trovi fra le icone accanto all\'orologio. Per chiuderlo del tutto, clic destro sull\'icona e Esci.',
    icon: nativeImage.createFromPath(ICON),
  });
  notif.on('click', () => showWindow());
  notif.show();
}

function trayImage() {
  const base = nativeImage.createFromPath(ICON);
  const img = base.resize({ width: 16, height: 16, quality: 'best' });
  for (const scaleFactor of [1.25, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: base.resize({ width: size, height: size, quality: 'best' }).toPNG() });
  }
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.on('click', () => showWindow());
  updateTray();
}

/** Icona accanto all'orologio: stampe in corso nel suggerimento e nel menu. */
function updateTray() {
  if (!tray || !server) return;
  const lines = server.manager.list().filter((p) => p.isPrinting).map((p) => {
    const job = p._jobInfo ? p._jobInfo() : null;
    const pct = job && typeof job.progress === 'number' ? ` ${Math.floor(job.progress * 100)}%` : '';
    return `${p.config.name}: in stampa${pct}`;
  });
  // Windows taglia il suggerimento a 127 caratteri
  tray.setToolTip(['SonoPrint', ...lines].join('\n').slice(0, 127));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Apri SonoPrint', click: () => showWindow() },
    ...(lines.length ? [{ type: 'separator' }, ...lines.map((label) => ({ label, enabled: false }))] : []),
    { type: 'separator' },
    { label: 'Esci da SonoPrint', click: () => app.quit() },
  ]));
}

function windowTitle() {
  const active = server ? server.manager.activeLocalPrints() : [];
  return active.length ? 'SonoPrint: stampa in corso' : 'SonoPrint';
}

let lastPrintsLogged = '';
function onPrintingChanged() {
  updateSleepBlocker();
  updateTray();
  if (win && !win.isDestroyed()) win.setTitle(windowTitle());
  const active = server.manager.activeLocalPrints().join(', ');
  if (active !== lastPrintsLogged) {
    log.info(active ? `Stampe USB in corso: ${active}` : 'Nessuna stampa USB in corso');
    lastPrintsLogged = active;
  }
}

/** Annota nel registro i processi dell'app che si chiudono da soli e gli eventi del sistema. */
function watchProcesses() {
  app.on('child-process-gone', (e, d) => {
    log.warn(`Processo ${d.type}${d.name ? ' (' + d.name + ')' : ''} chiuso: ${d.reason}, codice ${d.exitCode}`);
  });
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
    powerMonitor.on(ev, () => log.info(`Sistema: ${ev}`));
  }
}

/** Menu dell'app su Mac: senza, non funzionerebbero nemmeno Cmd+C, Cmd+V e Cmd+Q. */
function macMenu() {
  return Menu.buildFromTemplate([
    { label: 'SonoPrint', submenu: [
      { role: 'about', label: 'Informazioni su SonoPrint' },
      { type: 'separator' },
      { label: 'Impostazioni...', accelerator: 'Cmd+,', click: () => showWindow('#/settings') },
      { label: 'Aggiornamenti', click: () => showWindow('#/updates') },
      { type: 'separator' },
      { role: 'hide', label: 'Nascondi SonoPrint' },
      { role: 'hideOthers', label: 'Nascondi altre' },
      { role: 'unhide', label: 'Mostra tutte' },
      { type: 'separator' },
      { role: 'quit', label: 'Esci da SonoPrint' },
    ] },
    { label: 'Modifica', submenu: [
      { role: 'undo', label: 'Annulla' },
      { role: 'redo', label: 'Ripeti' },
      { type: 'separator' },
      { role: 'cut', label: 'Taglia' },
      { role: 'copy', label: 'Copia' },
      { role: 'paste', label: 'Incolla' },
      { role: 'selectAll', label: 'Seleziona tutto' },
    ] },
    { label: 'Vista', submenu: [
      { role: 'reload', label: 'Ricarica' },
      { role: 'togglefullscreen', label: 'Schermo intero' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Dimensioni reali' },
      { role: 'zoomIn', label: 'Ingrandisci' },
      { role: 'zoomOut', label: 'Riduci' },
    ] },
    { label: 'Finestra', role: 'window', submenu: [
      { role: 'minimize', label: 'Contrai' },
      { role: 'zoom', label: 'Ridimensiona' },
      { label: 'Mostra SonoPrint', accelerator: 'Cmd+0', click: () => showWindow() },
      { type: 'separator' },
      { role: 'front', label: 'Porta tutto in primo piano' },
    ] },
  ]);
}

/**
 * Alla prima apertura copia stampanti, file e cronologia di Polipo, il nome precedente dell'app.
 * Una volta sola, solo per SonoPrint (mai per copie di prova con un altro nome) e solo se la
 * cartella dei dati manca davvero: un errore diverso (file bloccato, permessi) non basta.
 */
function migrateFromPolipo() {
  if (process.env.SONOPRINT_USER_DATA || app.getName() !== 'SonoPrint') return;
  const userData = app.getPath('userData');
  const target = path.join(userData, 'data');
  const marker = path.join(userData, 'migrated-from-polipo');
  const old = path.join(app.getPath('appData'), 'Polipo', 'data');
  if (!missing(target) || !missing(marker) || missing(old)) return;
  const temp = target + '.migrating';
  try {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.cpSync(old, temp, { recursive: true });
    fs.renameSync(temp, target);
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (_) {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Vero solo se il percorso non esiste: un file che c'è ma non si riesce a leggere non conta come mancante. */
function missing(p) {
  try {
    fs.statSync(p);
    return false;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

/** Origine attuale dell'interfaccia (cambia se si cambia la porta). */
function origin() {
  return new URL(server.url).origin;
}

function updateSleepBlocker() {
  const need = server && server.manager.settings.preventSleep && server.manager.activeLocalPrints().length > 0;
  if (need && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!need && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
}

app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
// clic sull'icona nel Dock con la finestra chiusa
app.on('activate', () => showWindow());

app.on('before-quit', (e) => {
  if (quitting || !server) return;
  // si esce da Esci (icona accanto all'orologio, Cmd+Q) o chiudendo la finestra senza background:
  // con stampe USB in corso si chiede conferma, tranne per installare un aggiornamento o se Windows chiude la sessione
  const installing = updater && updater.state.status === 'installing';
  if (!installing && !sessionEnding && !confirmStopPrints()) {
    e.preventDefault();
    return;
  }
  quitting = true;
  log.info(installing ? 'Chiusura per installare un aggiornamento' : sessionEnding ? 'Chiusura: Windows chiude la sessione' : 'Chiusura di SonoPrint');
  e.preventDefault();
  if (updater) updater.prepareQuit();
  // una stampante che non risponde non deve bloccare la chiusura (e quindi l'installazione di un aggiornamento)
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  Promise.race([server.close().catch(() => {}), timeout]).finally(() => {
    if (tray) tray.destroy();
    app.quit();
  });
});
