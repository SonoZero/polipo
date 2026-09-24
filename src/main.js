'use strict';

// Processo principale di Electron: avvia il servizio Polipo e apre la finestra.

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
if (process.env.POLIPO_USER_DATA) app.setPath('userData', process.env.POLIPO_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  // Polipo è già aperto: porta in primo piano quella finestra
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('Polipo non si è avviato', String(err && err.stack || err));
    app.quit();
  });
}

async function start() {
  app.setAppUserModelId('it.edoardo.polipo');
  Menu.setApplicationMenu(null);

  updater = new Updater(app);
  server = await startServer({ dataDir: path.join(app.getPath('userData'), 'data'), appInfo: updater });
  const origin = new URL(server.url).origin;

  let notifiedVersion = null;
  updater.on('change', (s) => {
    if (s.status !== 'downloaded' || notifiedVersion === s.version || !Notification.isSupported()) return;
    notifiedVersion = s.version;
    const notif = new Notification({
      title: 'Aggiornamento di Polipo pronto',
      body: `La versione ${s.version} verrà installata al prossimo riavvio.`,
      icon: nativeImage.createFromPath(ICON),
    });
    notif.on('click', () => { if (win) { win.show(); win.focus(); } });
    notif.show();
  });
  updater.init();

  // webcam e notifiche consentite solo all'interfaccia di Polipo
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromUs = (details.requestingUrl || '').startsWith(origin);
    callback(fromUs && ['media', 'notifications', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return requestingOrigin === origin && ['media', 'notifications', 'fullscreen'].includes(permission);
  });

  server.events.on('notify', (n) => {
    if (n.quiet || !server.manager.settings.notifications || !Notification.isSupported()) return;
    const notif = new Notification({ title: n.title || 'Polipo', body: n.message || '', icon: nativeImage.createFromPath(ICON) });
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
    backgroundColor: '#0e1014',
    title: 'Polipo',
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

  // i link esterni si aprono nel browser, la finestra resta su Polipo
  const origin = new URL(server.url).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.on('close', (e) => {
    if (quitting || !server) return;
    const active = server.manager.activePrints();
    if (!active.length) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Stampe in corso',
      message: `Stampa in corso su: ${active.join(', ')}.`,
      detail: 'Polipo invia le stampe riga per riga: se lo chiudi, le stampe si interrompono.\nVuoi davvero uscire?',
      buttons: ['Non chiudere', 'Esci e interrompi le stampe'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

function updateSleepBlocker() {
  const need = server && server.manager.settings.preventSleep && server.manager.anyPrinting();
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
  server.close().catch(() => {}).finally(() => app.quit());
});
