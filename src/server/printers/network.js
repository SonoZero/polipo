'use strict';

// Parte comune alle stampanti in rete (Bambu Lab, Klipper, PrusaLink, OctoPrint):
// connessione con riconnessione automatica, lavoro letto dalla stampante,
// invio dei file dall'archivio e avvio della stampa.

const path = require('path');
const { BasePrinter } = require('./base');
const { hostLabel } = require('./http');

const RETRY_STEPS = [3000, 5000, 10000, 20000, 30000];

class NetworkPrinter extends BasePrinter {
  constructor(config, deps = {}) {
    super(config, deps);
    this._session = 0;
    this._wanted = false; // l'utente vuole essere connesso: dopo una caduta si riconnette da solo
    this._retryTimer = null;
    this._retryCount = 0;
    this._startGuard = null;
  }

  get net() { return this.config.net || {}; }
  get address() { return hostLabel(this.net.host, this.net.port); }

  _snapshotExtra() {
    return { host: this.address };
  }

  // ---------------------------------------------------------------------------
  // Connessione

  async connect() {
    if (this.state !== 'offline' && this.state !== 'error') throw new Error('La stampante è già connessa.');
    if (!this.net.host) throw new Error('Inserisci l\'indirizzo IP della stampante nelle impostazioni.');
    this._wanted = true;
    this._retryCount = 0;
    clearTimeout(this._retryTimer);
    const session = ++this._session;
    this.error = null;
    this._setState('connecting');
    this._log('info', `Connessione a ${this.address}...`);
    try {
      await this._open(session);
      if (session !== this._session) return;
      this._log('info', 'Connessa.');
      this.emit('notify', { level: 'info', title: this.config.name, message: 'Stampante connessa', quiet: true });
    } catch (err) {
      if (session !== this._session) return;
      await this._closeQuiet();
      this._wanted = false;
      const msg = this._friendlyError(err);
      this._fail(msg);
      throw new Error(msg);
    }
  }

  async disconnect() {
    this._wanted = false;
    this._session++;
    clearTimeout(this._retryTimer);
    clearTimeout(this._startGuard);
    this._awaitingStart = null;
    await this._closeQuiet();
    this.job = null;
    this.error = null;
    this.position = null;
    this._clearTemps();
    this._setState('offline');
    this._log('info', 'Disconnessa.');
  }

  /** Da chiamare quando la connessione cade da sola: riprova con attese crescenti. */
  _connectionLost(reason) {
    if (!this._wanted) return;
    const session = ++this._session;
    this._closeQuiet();
    const wait = RETRY_STEPS[Math.min(this._retryCount, RETRY_STEPS.length - 1)];
    this._retryCount++;
    if (this.state !== 'connecting') this._log('warn', `${reason} Riprovo tra ${Math.round(wait / 1000)} s.`);
    this.error = reason;
    this._setState('connecting');
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(async () => {
      if (session !== this._session || !this._wanted) return;
      try {
        await this._open(session);
        if (session !== this._session) return;
        this._retryCount = 0;
        this.error = null;
        this._log('info', 'Connessione ristabilita.');
        this._changed(true);
      } catch (err) {
        if (session !== this._session) return;
        this._connectionLost(this._friendlyError(err));
      }
    }, wait);
  }

  async _closeQuiet() {
    try { await this._close(); } catch (_) { /* ignora */ }
  }

  // da implementare nei singoli tipi
  async _open() { throw new Error('non implementato'); }
  async _close() {}
  _friendlyError(err) { return err && err.message ? err.message : String(err); }

  _requireConnected() {
    if (!this.isConnected) throw new Error('La stampante non è connessa.');
  }

  _requireIdle() {
    this._requireConnected();
    if (!['operational', 'paused'].includes(this.state)) throw new Error('Comando non disponibile durante la stampa.');
  }

  // ---------------------------------------------------------------------------
  // Stato del lavoro letto dalla stampante

  /**
   * Aggiorna lo stato dalla stampante.
   * @param {string} state operational | printing | pausing | paused | cancelling | error
   * @param {object|null} job { file, progress, elapsed, remaining, layer, layerCount, startedAt, estimatedTime }
   */
  _applyRemote(state, job) {
    // durante l'invio del file, o subito dopo l'avvio, la stampante può ancora dirsi libera
    if (!job && state === 'operational' && (this.state === 'sending' || this._awaitingStart)) return;
    if (this._awaitingStart) {
      this._awaitingStart = null;
      clearTimeout(this._startGuard);
    }
    const wasActive = !!this.job;
    if (job) {
      const prev = this.job || {};
      const sameFile = prev.file === job.file;
      this.job = {
        file: job.file,
        progress: clamp01(job.progress),
        elapsed: job.elapsed ?? null,
        remaining: job.remaining ?? null,
        layer: job.layer || null,
        layerCount: job.layerCount || null,
        estimatedTime: job.estimatedTime ?? (sameFile ? prev.estimatedTime : null) ?? null,
        startedAt: job.startedAt || (sameFile && prev.startedAt) || Date.now() - (job.elapsed || 0) * 1000,
        thumbnail: job.thumbnail || (sameFile ? prev.thumbnail : null) || null,
        size: job.size ?? null,
      };
      if (!wasActive) this._log('info', `Stampa in corso: ${job.file}`);
    } else if (wasActive) {
      this.job = null;
    }
    this._setState(state);
    this._changed();
  }

  /** La stampante ha finito il lavoro in corso (result: done | cancelled | failed). */
  _remoteJobEnded(result, reason) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    const duration = job.elapsed ?? Math.round((Date.now() - job.startedAt) / 1000);
    this._recordJobEnd({ file: job.file, result, reason, duration, progress: job.progress, startedAt: job.startedAt });
  }

  _jobInfo() {
    const j = this.job;
    if (!j) return null;
    const elapsed = j.elapsed ?? Math.max(0, Math.round((Date.now() - j.startedAt) / 1000));
    return {
      file: j.file,
      size: j.size,
      progress: j.progress,
      elapsed,
      remaining: j.remaining,
      layer: j.layer,
      layerCount: j.layerCount,
      estimatedTime: j.estimatedTime,
      filamentLength: null,
      startedAt: j.startedAt,
      thumbnail: j.thumbnail,
      remote: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Stampa di un file dell'archivio

  startPrint(file) {
    this._requireConnected();
    if (this.state !== 'operational') throw new Error('La stampante non è pronta per stampare.');
    this._requireNoTask();
    const ext = fileKind(file.name);
    const accepted = this.capabilities.files || ['.gcode'];
    if (!accepted.includes(ext)) {
      throw new Error(ext === '.3mf'
        ? 'I file 3MF si stampano solo sulle stampanti Bambu Lab. Per questa stampante esporta un file G-code dallo slicer.'
        : 'Questa stampante accetta solo file ' + accepted.join(', ') + '.');
    }
    this._sendAndPrint(file).catch(() => { /* errore già notificato */ });
  }

  async _sendAndPrint(file) {
    const session = this._session;
    this._setState('sending');
    this._setTask({ kind: 'upload', status: 'running', progress: 0, message: `Invio di ${file.name} alla stampante...`, file: file.name });
    this._log('info', `Invio di ${file.name} alla stampante...`);
    try {
      let last = 0;
      const remoteName = await this._uploadForPrint(file, (p) => {
        if (p - last < 0.01 && p < 1) return;
        last = p;
        this._setTask({ progress: p });
      });
      if (session !== this._session) return;
      this._setTask({ progress: 1, message: 'Avvio della stampa...' });
      await this._startRemotePrint(remoteName, file);
      if (session !== this._session) return;
      this._log('info', `Stampa avviata: ${file.name}`);
      this._setTask(null);
      this.job = {
        file: remoteName, progress: 0, elapsed: 0, remaining: file.meta && file.meta.estimatedTime ? file.meta.estimatedTime : null,
        layer: null, layerCount: file.meta ? file.meta.layerCount : null, estimatedTime: file.meta ? file.meta.estimatedTime : null,
        startedAt: Date.now(), thumbnail: null, size: file.size || null,
      };
      this._awaitingStart = file.name;
      this._setState('printing');
      this.emit('job-started', { file: file.name });
      if (typeof this._pollNow === 'function') this._pollNow();
      // se la stampante non conferma entro un minuto e mezzo, qualcosa è andato storto
      clearTimeout(this._startGuard);
      this._startGuard = setTimeout(() => this._checkStarted(), this.startTimeout || 90000);
    } catch (err) {
      if (session !== this._session) return;
      const msg = this._friendlyError(err);
      this._setTask({ status: 'error', message: msg });
      this._log('error', `Invio non riuscito: ${msg}`);
      this.emit('notify', { level: 'error', title: this.config.name, message: `Stampa non avviata: ${msg}` });
      if (this.state === 'sending') this._setState(this.isConnected || this._wanted ? 'operational' : 'offline');
    }
  }

  _checkStarted() {
    if (!this._awaitingStart) return;
    const name = this._awaitingStart;
    this._awaitingStart = null;
    this.job = null;
    if (this.state === 'printing') this._setState('operational');
    const msg = this._startFailedMessage();
    this._log('error', msg);
    this.emit('notify', { level: 'error', title: this.config.name, message: `Stampa di ${name} non partita. ${msg}` });
  }

  _startFailedMessage() {
    return 'La stampante non ha avviato la stampa: controlla lo schermo della stampante.';
  }

  // da implementare nei singoli tipi
  async _uploadForPrint() { throw new Error('non implementato'); }
  async _startRemotePrint() {}

  async destroy() {
    this._wanted = false;
    this._session++;
    clearTimeout(this._retryTimer);
    clearTimeout(this._startGuard);
    await this._closeQuiet();
    await super.destroy();
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** ".gcode" oppure ".3mf" (anche per "pezzo.gcode.3mf") */
function fileKind(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return ext === '.3mf' ? '.3mf' : (['.gcode', '.gco', '.g'].includes(ext) ? '.gcode' : ext);
}

/** Nome sicuro per il file sulla stampante (niente caratteri strani, niente percorsi). */
function remoteFileName(name) {
  return path.basename(String(name)).replace(/[^\w.\- ()]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'stampa.gcode';
}

module.exports = { NetworkPrinter, fileKind, remoteFileName, clamp01 };
