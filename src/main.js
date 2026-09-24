'use strict';

// Processo principale di Electron: avvia il servizio SonoPrint e apre la finestra.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Notification, dialog, shell, powerSaveBlocker, session, nativeImage } = require('electron');
const { startServer } = require('./server');
const { Updater } = require('./updater');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

let server = null;
let updater = null;
let win = null;
let sleepBlocker = null;
let quitting = false;

// profilo separato (utile per provare una seconda copia senza toccare quella in uso)
if (process.env.SONOPRINT_USER_DATA) app.setPath('userData', process.env.SONOPRINT_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  // SonoPrint è già aperto: porta in primo piano quella finestra
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('SonoPrint non si è avviato', String(err && err.stack || err));
    app.quit();
  });
}

async function start() {
  app.setAppUserModelId('com.sonozero.sonoprint');
  Menu.setApplicationMenu(null);

  migrateFromPolipo();
  updater = new Updater(app);
  server = await startServer({ dataDir: path.join(app.getPath('userData'), 'data'), appInfo: updater });

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
    notif.on('click', () => { if (win) { win.show(); win.focus(); } });
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
    notif.on('click', () => {
      if (!win) return;
      win.show();
      win.focus();
      if (n.printerId) win.webContents.executeJavaScript(`location.hash = '#/printer/${String(n.printerId).replace(/[^\w-]/g, '')}'`);
    });
    notif.show();
  });

  server.events.on('printing-changed', updateSleepBlocker);
  server.manager.on('settings-changed', updateSleepBlocker);

  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0c0e',
    title: 'SonoPrint',
    icon: ICON,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(server.url);

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

  win.on('close', (e) => {
    if (quitting || !server) return;
    const active = server.manager.activeLocalPrints();
    if (!active.length) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Stampe in corso',
      message: `Stampa in corso su: ${active.join(', ')}.`,
      detail: 'Le stampanti USB ricevono la stampa riga per riga da SonoPrint: se lo chiudi, quelle stampe si interrompono. Le stampanti in rete continuano da sole.\nVuoi davvero uscire?',
      buttons: ['Non chiudere', 'Esci e interrompi le stampe'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
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

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
  if (quitting || !server) return;
  quitting = true;
  e.preventDefault();
  if (updater) updater.prepareQuit();
  // una stampante che non risponde non deve bloccare la chiusura (e quindi l'installazione di un aggiornamento)
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  Promise.race([server.close().catch(() => {}), timeout]).finally(() => app.quit());
});
