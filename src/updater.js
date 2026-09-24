'use strict';

// Aggiornamenti automatici dalle Release di GitHub (electron-updater).
// - versione installata: scarica in background e installa al riavvio;
// - versione portable: segnala solo la nuova versione e apre la pagina di download.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pkg = require('../package.json');

const CHECK_EVERY = 6 * 60 * 60 * 1000;
// se dopo questo tempo SonoPrint è ancora aperto, l'installer non è partito o non è riuscito a chiuderlo
const INSTALL_STUCK_MS = 25000;
// file scritto prima di installare: al riavvio dice se l'aggiornamento è andato a buon fine
const PENDING_FILE = 'update-pending.json';

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
      notes: [], // novità della nuova versione: [{ type: 'h' | 'li' | 'p', text }]
      releaseDate: null,
      transferred: null,
      total: null,
      bytesPerSecond: null,
      installMode: null, // 'silent' (si chiude e si riapre da solo) o 'visible' (finestra dell'installer)
      installStartedAt: null,
      installStuck: false,
      justUpdated: null, // { from, to }: aggiornamento riuscito, mostrato una volta al riavvio
      installFailed: null, // { from, to, at }: al riavvio la versione non era cambiata
      hasLog: false,
    };
    this.autoUpdater = null;
    this.timer = null;
    this.stuckTimer = null;
    this.log = () => {};
  }

  init() {
    if (!this.app.isPackaged) return; // in sviluppo (npm start) non si aggiorna
    const dir = this.app.getPath('userData');
    this.pendingPath = path.join(dir, PENDING_FILE);
    this.logPath = path.join(dir, 'logs', 'updater.log');
    const logger = fileLogger(this.logPath);
    this.log = (level, ...args) => logger[level](...args);
    this.state.hasLog = true;
    this._checkPendingInstall();

    const { autoUpdater } = require('electron-updater');
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = !this.portable;
    autoUpdater.autoInstallOnAppQuit = !this.portable;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = logger;
    this.log('info', `SonoPrint ${this.state.current} avviato${this.portable ? ' (portable)' : ''}`);

    autoUpdater.on('checking-for-update', () => this._set({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => this._set({
      status: this.portable ? 'available' : 'downloading',
      version: info.version,
      percent: 0,
      notes: notesToBlocks(info.releaseNotes),
      releaseDate: info.releaseDate || null,
      checkedAt: Date.now(),
    }));
    autoUpdater.on('download-progress', (p) => this._set({
      status: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    }));
    autoUpdater.on('update-downloaded', (info) => this._set({
      status: 'downloaded',
      version: info.version,
      percent: 100,
      bytesPerSecond: null,
      notes: this.state.notes.length ? this.state.notes : notesToBlocks(info.releaseNotes),
    }));
    autoUpdater.on('update-not-available', () => this._set({ status: 'latest', version: null, notes: [], checkedAt: Date.now() }));
    autoUpdater.on('error', (err) => {
      this.log('error', 'Errore:', err && err.stack ? err.stack : String(err));
      // installazione non partita: resta pronta per riprovare
      if (this.state.status === 'installing') {
        this._clearPending();
        clearTimeout(this.stuckTimer);
        this._set({ status: 'downloaded', installMode: null, error: 'L\'installazione non è partita: ' + friendlyError(err) });
        return;
      }
      this._set({ status: 'error', error: friendlyError(err), checkedAt: Date.now() });
    });

    setTimeout(() => this.check(), 10000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY);
  }

  getState() {
    return this.state;
  }

  async check() {
    if (!this.autoUpdater) throw new Error('Gli aggiornamenti automatici funzionano solo nella versione installata di SonoPrint.');
    // se c'è già un aggiornamento pronto non serve ricontrollare
    if (['downloading', 'downloaded', 'checking', 'installing'].includes(this.state.status)) return this.state;
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (err) {
      this._set({ status: 'error', error: friendlyError(err), checkedAt: Date.now() });
    }
    return this.state;
  }

  /**
   * Installa l'aggiornamento scaricato.
   * - silent: SonoPrint si chiude, l'installer lavora in background e lo riapre;
   * - visible: si apre la finestra dell'installer, con la sua barra di avanzamento.
   */
  install(mode = 'silent') {
    const ready = this.state.status === 'downloaded' || (this.state.status === 'installing' && this.state.installStuck);
    if (!this.autoUpdater || !ready) {
      throw new Error('Nessun aggiornamento pronto da installare.');
    }
    const visible = mode === 'visible';
    this._writePending(visible ? 'visible' : 'silent');
    this.log('info', `Installazione della versione ${this.state.version} (${visible ? 'con la finestra dell\'installer' : 'silenziosa'})`);
    this.autoUpdater.quitAndInstallCalled = false; // un nuovo tentativo dopo uno non riuscito
    this._set({ status: 'installing', installMode: visible ? 'visible' : 'silent', installStartedAt: Date.now(), installStuck: false, error: null });
    setTimeout(() => this.autoUpdater.quitAndInstall(!visible, true), 300);
    clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => {
      if (this.state.status !== 'installing') return;
      this.log('warn', 'SonoPrint è ancora aperto: l\'installer non è partito o non è riuscito a chiuderlo');
      this._set({ installStuck: true });
    }, INSTALL_STUCK_MS);
    return { ok: true };
  }

  /** Chiusura normale con un aggiornamento pronto: electron-updater lo installa, si segna per controllarlo al riavvio. */
  prepareQuit() {
    if (this.autoUpdater && this.state.status === 'downloaded' && this.autoUpdater.autoInstallOnAppQuit) {
      this._writePending('quit');
      this.log('info', `Chiusura con la versione ${this.state.version} pronta: si installa adesso`);
    }
  }

  /** Nasconde il messaggio di aggiornamento riuscito o non riuscito mostrato al riavvio. */
  dismiss() {
    this._set({ justUpdated: null, installFailed: null });
    return this.state;
  }

  openLog() {
    if (!this.logPath || !fs.existsSync(this.logPath)) throw new Error('Il registro degli aggiornamenti è ancora vuoto.');
    require('electron').shell.showItemInFolder(this.logPath);
    return { ok: true };
  }

  _writePending(mode) {
    if (!this.pendingPath) return;
    try {
      fs.writeFileSync(this.pendingPath, JSON.stringify({ from: this.state.current, to: this.state.version, mode, at: Date.now() }));
    } catch (err) {
      this.log('warn', 'Impossibile salvare lo stato dell\'installazione:', err.message);
    }
  }

  _clearPending() {
    try { if (this.pendingPath) fs.unlinkSync(this.pendingPath); } catch (_) { /* già assente */ }
  }

  /** Al riavvio: la versione è quella nuova? */
  _checkPendingInstall(attempt = 0) {
    let p = null;
    try {
      p = JSON.parse(fs.readFileSync(this.pendingPath, 'utf8'));
    } catch (err) {
      // subito dopo l'installazione il file può essere ancora bloccato: si riprova tra poco
      if (err.code && err.code !== 'ENOENT' && attempt < 5) setTimeout(() => this._checkPendingInstall(attempt + 1), 2000);
      return;
    }
    this._clearPending();
    if (!p || !p.to) return;
    if (p.to === this.state.current) {
      this.log('info', `Aggiornamento riuscito: ${p.from} -> ${p.to}`);
      this._set({ justUpdated: { from: p.from, to: p.to } });
    } else if (p.from === this.state.current && Date.now() - p.at < 7 * 86400000) {
      this.log('warn', `Aggiornamento a ${p.to} non installato (modalità ${p.mode}): la versione è ancora ${p.from}`);
      this._set({ installFailed: { from: p.from, to: p.to, at: p.at, mode: p.mode } });
    }
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }
}

/**
 * Note di rilascio di GitHub (HTML) come blocchi di solo testo: titoli, punti di elenco e paragrafi.
 * Niente HTML nell'interfaccia, così le note non possono inserire codice.
 */
function notesToBlocks(notes) {
  const raw = Array.isArray(notes) ? notes.map((n) => (n && n.note) || '').join('\n') : String(notes || '');
  const blocks = [];
  const re = /<(h[1-6]|li|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(raw))) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tag = m[1].toLowerCase();
    blocks.push({ type: tag[0] === 'h' ? 'h' : tag === 'li' ? 'li' : 'p', text });
  }
  if (!blocks.length) {
    // testo semplice o Markdown
    for (const line of raw.replace(/<[^>]+>/g, '').split(/\r?\n/)) {
      const t = decodeEntities(line).trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t)) blocks.push({ type: 'h', text: t.replace(/^#+\s*/, '') });
      else if (/^[-*]\s/.test(t)) blocks.push({ type: 'li', text: t.replace(/^[-*]\s*/, '') });
      else blocks.push({ type: 'p', text: t });
    }
  }
  return blocks.map((b) => ({ ...b, text: b.text.replace(/\*\*|`/g, '') })).slice(0, 60);
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', agrave: 'à', egrave: 'è', eacute: 'é', igrave: 'ì', ograve: 'ò', ugrave: 'ù' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return named[e.toLowerCase()] ?? all;
  });
}

/** Registro degli aggiornamenti in un file (anche quello di electron-updater), al massimo circa 1 MB. */
function fileLogger(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old');
  } catch (_) { /* il registro è facoltativo */ }
  const write = (level) => (...args) => {
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    try { fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`); } catch (_) { /* disco pieno o file bloccato */ }
  };
  return { info: write('INFO'), warn: write('WARN'), error: write('ERROR'), debug: write('DEBUG') };
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|net::ERR_/i.test(msg)) return 'Nessuna connessione a Internet: riproverò più tardi.';
  if (/404|Cannot find latest|No published versions|HttpError: 404/i.test(msg)) return 'Nessuna versione pubblicata su GitHub per ora.';
  if (/rate limit|403/i.test(msg)) return 'GitHub ha limitato le richieste: riproverò più tardi.';
  return msg.split('\n')[0].slice(0, 200);
}

module.exports = { Updater, notesToBlocks };
