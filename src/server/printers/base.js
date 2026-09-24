'use strict';

// Parte comune a tutte le stampanti (USB e in rete): stato, temperature,
// registro, fine lavoro e attività lunghe come aggiornamenti o invio file.

const { EventEmitter } = require('events');

const LOG_SIZE = 1500;
const TEMP_HISTORY_MS = 30 * 60 * 1000;
const SECRET_FIELDS = ['accessCode', 'apiKey', 'password'];
const UPDATE_CHECK_DELAY = 5000;

class BasePrinter extends EventEmitter {
  constructor(config, deps = {}) {
    super();
    this.config = config;
    this.files = deps.files || null;

    this.state = 'offline';
    this.error = null;
    this.firmware = null;
    this.temps = emptyTemps(config.extruders || 1);
    this.tempHistory = [];
    this.position = null;
    this.fanSpeed = null;
    this.feedRate = 100;
    this.flowRate = 100;
    this.log = [];
    this.job = null;
    this.lastJob = null;
    this.task = null; // operazione lunga in corso: { kind, status, progress, message }
    this.extra = {}; // informazioni specifiche del tipo di stampante
    this.updates = null; // riepilogo degli aggiornamenti di firmware e software

    this._updateTimer = null;
    this._updatesTimer = null;
  }

  get id() { return this.config.id; }
  get type() { return this.config.type || 'usb'; }

  get isConnected() {
    return !['offline', 'connecting', 'error'].includes(this.state);
  }

  get isPrinting() {
    return ['sending', 'printing', 'pausing', 'paused'].includes(this.state);
  }

  /** Cosa sa fare questa stampante: l'interfaccia mostra solo i controlli disponibili. */
  get capabilities() {
    return {};
  }

  snapshot() {
    return {
      id: this.config.id,
      type: this.type,
      config: publicConfig(this.config),
      state: this.state,
      error: this.error,
      firmware: this.firmware,
      temps: this.temps,
      position: this.position,
      fanSpeed: this.fanSpeed,
      feedRate: this.feedRate,
      flowRate: this.flowRate,
      job: this._jobInfo(),
      lastJob: this.lastJob,
      capabilities: this.capabilities,
      extra: this.extra,
      task: this.task,
      updates: this.updates,
      ...this._snapshotExtra(),
    };
  }

  _snapshotExtra() { return {}; }
  _jobInfo() { return null; }

  getTempHistory() { return this.tempHistory; }
  getLog() { return this.log; }

  updateConfig(config) {
    this.config = config;
    const n = config.extruders || 1;
    for (let i = 0; i < n; i++) {
      if (!this.temps.tools['T' + i]) this.temps.tools['T' + i] = { actual: null, target: null };
    }
    for (const k of Object.keys(this.temps.tools)) {
      if (parseInt(k.slice(1), 10) >= n) delete this.temps.tools[k];
    }
    this._changed();
  }

  // ---------------------------------------------------------------------------
  // Temperature

  _applyTemps(t) {
    for (const [k, v] of Object.entries(t.tools || {})) {
      if (!this.temps.tools[k]) this.temps.tools[k] = { actual: null, target: null };
      this.temps.tools[k].actual = v.actual;
      if (v.target !== null && v.target !== undefined) this.temps.tools[k].target = v.target;
    }
    if (t.bed) {
      const prev = this.temps.bed && this.temps.bed.target;
      this.temps.bed = { actual: t.bed.actual, target: t.bed.target !== null && t.bed.target !== undefined ? t.bed.target : prev };
    }
    if (t.chamber) this.temps.chamber = { actual: t.chamber.actual, target: t.chamber.target ?? null };
    this._recordTemps();
    this._changed();
  }

  _recordTemps() {
    const now = Date.now();
    const last = this.tempHistory[this.tempHistory.length - 1];
    if (last && now - last.t < 1000) return;
    const sample = { t: now };
    for (const [k, v] of Object.entries(this.temps.tools)) sample[k] = [v.actual, v.target];
    if (this.temps.bed) sample.B = [this.temps.bed.actual, this.temps.bed.target];
    if (this.temps.chamber) sample.C = [this.temps.chamber.actual, this.temps.chamber.target];
    this.tempHistory.push(sample);
    while (this.tempHistory.length && now - this.tempHistory[0].t > TEMP_HISTORY_MS) this.tempHistory.shift();
    this.emit('temp', sample);
  }

  _clearTemps() {
    for (const t of Object.values(this.temps.tools)) { t.actual = null; t.target = null; }
    this.temps.bed = { actual: null, target: null };
    this.temps.chamber = null;
  }

  // ---------------------------------------------------------------------------
  // Fine di un lavoro

  /** Registra la fine di una stampa: ultimo lavoro, notifica e cronologia. */
  _recordJobEnd({ file, result, reason, duration, progress, startedAt }) {
    this.lastJob = {
      file,
      result,
      reason: reason || null,
      finishedAt: Date.now(),
      duration: duration ?? null,
      progress: result === 'done' ? 1 : (progress ?? null),
    };
    if (result === 'done') {
      this._log('info', `Stampa completata: ${file}`);
      this.emit('notify', { level: 'success', title: this.config.name, message: `Stampa completata: ${file}` });
    } else if (result === 'cancelled') {
      this._log('info', `Stampa annullata: ${file}`);
      this.emit('notify', { level: 'info', title: this.config.name, message: `Stampa annullata: ${file}` });
    } else {
      this._log('error', `Stampa fallita: ${file}${reason ? ' (' + reason + ')' : ''}`);
      this.emit('notify', { level: 'error', title: this.config.name, message: `Stampa interrotta: ${file}${reason ? ' (' + reason + ')' : ''}` });
    }
    this.emit('job-ended', { ...this.lastJob, printerId: this.id, printerName: this.config.name, startedAt: startedAt || null });
    this._changed();
  }

  // ---------------------------------------------------------------------------
  // Operazioni lunghe (aggiornamenti firmware, invio di file)

  _setTask(task) {
    const wasRunning = this.task && this.task.status === 'running';
    this.task = task ? { ...(this.task || {}), ...task, at: Date.now() } : null;
    this._changed(true);
    // aggiornamento finito: si ricontrolla cosa resta da aggiornare
    if (wasRunning && this.task && this.task.kind === 'firmware' && this.task.status !== 'running') this._scheduleUpdateCheck(true);
  }

  // ---------------------------------------------------------------------------
  // Aggiornamenti di firmware e software

  /** Controlla gli aggiornamenti e aggiorna il riepilogo visibile nell'interfaccia. */
  async checkUpdates(refresh) {
    if (typeof this.firmwareInfo !== 'function' || !this.isConnected) return this.updates;
    try {
      const summary = await this._updateSummary(refresh);
      if (summary) this.setUpdateSummary(summary);
    } catch (err) {
      this.setUpdateSummary({ kind: this.type, available: 0, error: err.message, checkedAt: Date.now() });
    }
    return this.updates;
  }

  async _updateSummary(refresh) {
    return summarizeFirmware(await this.firmwareInfo(refresh));
  }

  setUpdateSummary(summary) {
    this.updates = summary;
    this._changed();
  }

  _scheduleUpdateCheck(refresh) {
    clearTimeout(this._updatesTimer);
    this._updatesTimer = setTimeout(() => { this._updatesTimer = null; this.checkUpdates(refresh).catch(() => {}); }, UPDATE_CHECK_DELAY);
    if (this._updatesTimer.unref) this._updatesTimer.unref();
  }

  _requireNoTask() {
    if (this.task && this.task.status === 'running') {
      throw new Error('È già in corso un\'altra operazione su questa stampante: aspetta che finisca.');
    }
  }

  // ---------------------------------------------------------------------------
  // Helper

  _setState(state) {
    if (this.state === state) return;
    const was = this.isConnected;
    this.state = state;
    this._changed(true);
    if (!was && this.isConnected) this._scheduleUpdateCheck(false);
  }

  _fail(message) {
    this.error = message;
    this._setState('error');
    this._log('error', message);
    this.emit('notify', { level: 'error', title: this.config.name, message });
  }

  _changed(immediate) {
    if (immediate) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
      this.emit('update');
      return;
    }
    if (this._updateTimer) return;
    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      this.emit('update');
    }, 250);
  }

  _log(type, text, quiet = false) {
    const entry = { t: Date.now(), type, text, q: quiet ? 1 : 0 };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.splice(0, this.log.length - LOG_SIZE);
    this.emit('log', entry);
  }

  _unsupported(what) {
    const e = new Error(`${what}: non disponibile per questo tipo di stampante.`);
    e.status = 400;
    return e;
  }

  // Comandi: ogni tipo di stampante implementa quelli che supporta.
  sendCommands() { throw this._unsupported('Invio di comandi G-code'); }
  setTemperature() { throw this._unsupported('Impostazione delle temperature'); }
  jog() { throw this._unsupported('Movimento manuale'); }
  home() { throw this._unsupported('Home degli assi'); }
  extrude() { throw this._unsupported('Estrusione manuale'); }
  setFan() { throw this._unsupported('Controllo della ventola'); }
  setFeedRate() { throw this._unsupported('Velocità di stampa'); }
  setFlowRate() { throw this._unsupported('Flusso'); }
  motorsOff() { throw this._unsupported('Spegnimento dei motori'); }
  emergencyStop() { throw this._unsupported('Arresto di emergenza'); }
  setLight() { throw this._unsupported('Luce'); }
  setSpeedLevel() { throw this._unsupported('Modalità di velocità'); }

  async destroy() {
    clearTimeout(this._updateTimer);
    clearTimeout(this._updatesTimer);
    this.removeAllListeners();
  }
}

/**
 * Riepilogo per il centro aggiornamenti: quanti aggiornamenti ci sono, se SonoPrint
 * li può installare da solo e cosa c'è di nuovo.
 */
function summarizeFirmware(info) {
  const base = { kind: info.kind, checkedAt: Date.now(), error: info.error || null };
  const version = (fw) => (fw && (fw.version || fw.name)) || null;
  if (info.kind === 'klipper' || info.kind === 'octoprint') {
    const avail = (info.components || []).filter((c) => c.available);
    return {
      ...base,
      current: version(info.current),
      available: avail.length,
      items: avail.map((c) => (c.remote ? `${c.label} ${c.remote}` : c.label)),
      automatic: avail.some((c) => c.possible !== false),
    };
  }
  if (info.kind === 'prusalink') {
    return { ...base, current: version(info.current), latest: info.latest ? info.latest.version : null, available: info.updateAvailable ? 1 : 0, automatic: false };
  }
  if (info.kind === 'marlin') {
    // Marlin generico: solo un'informazione, il firmware giusto lo prepara il produttore
    return { ...base, current: version(info.current), latest: info.latest ? info.latest.version : null, available: 0, advisory: !!info.updateAvailable, automatic: false };
  }
  return { ...base, current: version(info.current), available: 0, automatic: false };
}

/** Configurazione senza segreti (codici di accesso, chiavi, password): quella che vedono le interfacce. */
function publicConfig(config) {
  if (!config.net) return config;
  const net = { ...config.net };
  const secrets = {};
  for (const k of SECRET_FIELDS) {
    secrets[k] = !!net[k];
    delete net[k];
  }
  delete net.tlsFingerprint;
  return { ...config, net: { ...net, secrets } };
}

function emptyTemps(extruders) {
  const tools = {};
  for (let i = 0; i < extruders; i++) tools['T' + i] = { actual: null, target: null };
  return { tools, bed: { actual: null, target: null }, chamber: null };
}

/**
 * Tempo rimanente: mescola la stima dello slicer con l'andamento reale
 * (all'inizio conta di più lo slicer, verso la fine l'avanzamento).
 */
function blendRemaining(estimatedTime, elapsed, progress) {
  if (progress >= 1) return 0;
  const linear = progress > 0.005 ? elapsed * (1 - progress) / progress : null;
  if (estimatedTime) {
    const slicer = Math.max(0, estimatedTime - elapsed);
    if (linear === null) return Math.round(slicer);
    const w = Math.min(1, Math.max(0, (progress - 0.05) / 0.6));
    return Math.round(slicer * (1 - w) + linear * w);
  }
  return linear === null ? null : Math.round(linear);
}

module.exports = { BasePrinter, publicConfig, emptyTemps, blendRemaining, SECRET_FIELDS, summarizeFirmware };
