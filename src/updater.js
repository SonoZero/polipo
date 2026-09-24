'use strict';

// Aggiornamenti automatici dalle Release di GitHub (electron-updater).
// - versione installata: scarica in background e installa al riavvio;
// - versione portable: segnala solo la nuova versione e apre la pagina di download.

const { EventEmitter } = require('events');
const pkg = require('../package.json');

const CHECK_EVERY = 6 * 60 * 60 * 1000;

// electron-builder toglie "build" dal package.json impacchettato: il repository invece resta
function releasesUrl() {
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(String(url));
  return m ? `https://github.com/${m[1]}/${m[2]}/releases/latest` : null;
}

class Updater extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    this.state = {
      current: app.getVersion(),
      status: app.isPackaged ? 'idle' : 'unsupported',
      version: null,
      percent: null,
      error: null,
      checkedAt: null,
      portable: this.portable,
      releaseUrl: releasesUrl(),
    };
    this.autoUpdater = null;
    this.timer = null;
  }

  init() {
    if (!this.app.isPackaged) return; // in sviluppo (npm start) non si aggiorna
    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = !this.portable;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this._set({
      status: this.portable ? 'available' : 'downloading',
      version: info.version,
      percent: 0,
    }));
    autoUpdater.on('download-progress', (p) => this._set({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this._set({ status: 'downloaded', version: info.version, percent: 100 }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'latest', version: null, checkedAt: Date.now() }));
    autoUpdater.on('error', (err) => this._set({ status: 'error', error: friendlyError(err), checkedAt: Date.now() }));

    setTimeout(() => this.check(), 10000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY);
  }

  getState() {
    return this.state;
  }

  async check() {
    if (!this.autoUpdater) throw new Error('Gli aggiornamenti automatici funzionano solo nella versione installata di SonoPrint.');
    // se c'è già un aggiornamento pronto non serve ricontrollare
    if (['downloading', 'downloaded', 'checking'].includes(this.state.status)) return this.state;
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (err) {
      this._set({ status: 'error', error: friendlyError(err), checkedAt: Date.now() });
    }
    return this.state;
  }

  install() {
    if (!this.autoUpdater || this.state.status !== 'downloaded') {
      throw new Error('Nessun aggiornamento pronto da installare.');
    }
    // installazione silenziosa e riavvio automatico di SonoPrint
    setTimeout(() => this.autoUpdater.quitAndInstall(true, true), 300);
    return { ok: true };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::ERR_/i.test(msg)) return 'Nessuna connessione a Internet: riproverò più tardi.';
  if (/404|Cannot find latest|No published versions|HttpError: 404/i.test(msg)) return 'Nessuna versione pubblicata su GitHub per ora.';
  if (/rate limit|403/i.test(msg)) return 'GitHub ha limitato le richieste: riproverò più tardi.';
  return msg.split('\n')[0].slice(0, 200);
}

module.exports = { Updater };
