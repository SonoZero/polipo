'use strict';

// Gestisce l'elenco delle stampanti, la loro configurazione salvata su disco,
// le impostazioni generali e la cronologia delle stampe.

const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { DEFAULT_CANCEL_SCRIPT } = require('./printers/marlin');
const { createPrinter, TYPE_NAMES } = require('./printers');
const { SECRET_FIELDS } = require('./printers/base');
const { fileKind } = require('./printers/network');
const { parseHost } = require('./printers/http');
const { FileStore, readJsonSafe, writeJson } = require('./files');
const { listPorts, VIRTUAL_PORT } = require('./transport');

const COLORS = ['#ff6a1f', '#3ccf6e', '#4db5ff', '#ffb224', '#b894ff', '#ff4f7b', '#2cc9b4', '#e8e8e8'];

const DEFAULT_SETTINGS = {
  presets: [
    { name: 'PLA', hotend: 200, bed: 60 },
    { name: 'PETG', hotend: 235, bed: 80 },
    { name: 'ABS', hotend: 245, bed: 100 },
    { name: 'TPU', hotend: 225, bed: 50 },
  ],
  notifications: true,
  preventSleep: true,
  port: 5723, // porta dell'interfaccia web / API
  remote: { enabled: false, key: '' }, // accesso dal telefono (rete locale o VPN)
  lan: { enabled: false, hash: '', salt: '' }, // interfaccia dai browser della rete, con password
  developer: false, // modalità sviluppatore: mostra l'accesso dal telefono
};

const DEFAULT_PORT = DEFAULT_SETTINGS.port;

function newRemoteKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function defaultPrinterConfig(index) {
  return {
    id: null,
    type: 'usb', // usb | bambu | klipper | prusalink | octoprint
    name: `Stampante ${index + 1}`,
    model: '',
    color: COLORS[index % COLORS.length],
    port: '',
    baudrate: 'auto',
    autoConnect: false,
    volume: { x: 220, y: 220, z: 250 },
    originCenter: false,
    extruders: 1,
    heatedBed: true,
    heatedChamber: false,
    jog: { xySpeed: 6000, zSpeed: 600 },
    extrudeSpeed: 300,
    pause: { retract: 2, lift: 5, park: false, parkX: 0, parkY: 0 },
    scripts: {
      afterConnect: '',
      beforePrint: '',
      afterPrint: '',
      afterCancel: DEFAULT_CANCEL_SCRIPT,
      pause: '',
      resume: '',
    },
    webcam: { type: 'none', url: '', deviceId: '', flipH: false, flipV: false, rotate: 0 },
    virtualSpeed: 4,
    lastBaudrate: null,
    // stampanti in rete
    net: { host: '', port: null, serial: '', accessCode: '', apiKey: '', username: '', password: '', tlsFingerprint: '' },
    bambu: { useAms: false, bedLeveling: true, timelapse: false, flowCalibration: false, vibrationCalibration: false },
  };
}

class PrinterManager extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.historyPath = path.join(dataDir, 'history.json');
    const saved = readJsonSafe(this.configPath, {});
    this.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    this.settings.port = validPort(this.settings.port) || DEFAULT_PORT;
    this.settings.remote = { ...DEFAULT_SETTINGS.remote, ...(this.settings.remote || {}) };
    this.settings.lan = { ...DEFAULT_SETTINGS.lan, ...(this.settings.lan || {}) };
    // chi aveva già attivato l'accesso dal telefono (versioni precedenti) lo ritrova
    if (this.settings.remote.enabled && !this.settings.developer) this.settings.developer = true;
    const needsKey = !this.settings.remote.key;
    if (needsKey) this.settings.remote.key = newRemoteKey();
    this.history = readJsonSafe(this.historyPath, []);
    this.printers = new Map();
    this.order = [];

    this.files = new FileStore(dataDir);
    // in uso: in stampa da una stampante USB oppure in invio a una stampante in rete
    this.files.isInUse = (name) => [...this.printers.values()].some((p) => (p.job && p.job.name === name)
      || (p.task && p.task.kind === 'upload' && p.task.status === 'running' && p.task.file === name));
    this.files.on('changed', () => this.emit('files-changed'));

    (saved.printers || []).forEach((cfg, i) => this._createPrinter(sanitizeConfig(cfg, i)));
    if (needsKey) this._saveConfig();
  }

  async init() {
    this.files.init();
    for (const p of this.printers.values()) {
      const target = p.type === 'usb' ? p.config.port : p.config.net.host;
      if (p.config.autoConnect && target) {
        p.connect().catch(() => { /* errore già mostrato nello stato */ });
      }
    }
  }

  // --- stampanti -----------------------------------------------------------------

  list() {
    return this.order.map((id) => this.printers.get(id));
  }

  get(id) {
    const p = this.printers.get(id);
    if (!p) {
      const err = new Error('Stampante non trovata.');
      err.status = 404;
      throw err;
    }
    return p;
  }

  snapshots() {
    return this.list().map((p) => p.snapshot());
  }

  add(input) {
    const cfg = sanitizeConfig({ ...input, id: null }, this.order.length);
    const p = this._createPrinter(cfg);
    this._saveConfig();
    this.emit('printers-changed');
    return p;
  }

  async update(id, patch) {
    let p = this.get(id);
    patch = { ...(patch || {}) };
    if (patch.net) {
      // i segreti arrivano solo quando l'utente li cambia: vuoto = lascia quello salvato
      patch.net = { ...patch.net };
      for (const k of SECRET_FIELDS) if (patch.net[k] === '' || patch.net[k] === undefined || patch.net[k] === null) delete patch.net[k];
      const hostChanged = patch.net.host !== undefined && parseHost(patch.net.host).host !== p.config.net.host;
      const serialChanged = patch.net.serial !== undefined && String(patch.net.serial).trim().toUpperCase() !== p.config.net.serial;
      if (hostChanged || serialChanged) patch.net.tlsFingerprint = '';
    }
    const cfg = sanitizeConfig(deepMerge(p.config, patch), this.order.indexOf(id));
    cfg.id = id;
    const relink = p.type !== cfg.type || JSON.stringify(p.config.net) !== JSON.stringify(cfg.net);
    if (relink && p.isPrinting) throw new Error('Non puoi cambiare il collegamento della stampante mentre stampa.');
    if (p.type !== cfg.type) {
      await p.destroy();
      const fresh = this._makePrinter(cfg);
      this.printers.set(id, fresh);
      p = fresh;
    } else {
      const reconnect = relink && p.type !== 'usb' && p.state !== 'offline';
      if (reconnect) await p.disconnect().catch(() => {});
      p.updateConfig(cfg);
      if (reconnect) p.connect().catch(() => {});
    }
    this._saveConfig();
    this.emit('printers-changed');
    return p;
  }

  async remove(id) {
    const p = this.get(id);
    if (p.isPrinting) throw new Error('Non puoi rimuovere una stampante mentre stampa.');
    await p.destroy();
    this.printers.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this._saveConfig();
    this.emit('printers-changed');
  }

  reorder(ids) {
    const known = ids.filter((id) => this.printers.has(id));
    const rest = this.order.filter((id) => !known.includes(id));
    this.order = [...known, ...rest];
    this._saveConfig();
    this.emit('printers-changed');
  }

  async connect(id, opts = {}) {
    const p = this.get(id);
    if (p.type !== 'usb') return p.connect();
    const port = opts.port || p.config.port;
    if (port && port !== VIRTUAL_PORT) {
      for (const other of this.printers.values()) {
        if (other !== p && other.type === 'usb' && other.port === port && other.state !== 'offline') {
          throw new Error(`La porta ${port} è già usata da "${other.config.name}".`);
        }
      }
    }
    // ricorda porta e baudrate scelti
    const patch = {};
    if (opts.port && opts.port !== p.config.port) patch.port = opts.port;
    if (opts.baudrate && opts.baudrate !== p.config.baudrate) patch.baudrate = opts.baudrate;
    if (Object.keys(patch).length) await this.update(id, patch);
    await p.connect(opts);
  }

  anyPrinting() {
    return [...this.printers.values()].some((p) => p.isPrinting);
  }

  activePrints() {
    return [...this.printers.values()].filter((p) => p.isPrinting).map((p) => p.config.name);
  }

  /** Stampe che dipendono da SonoPrint (USB): si fermano se l'app si chiude. */
  activeLocalPrints() {
    return [...this.printers.values()].filter((p) => p.type === 'usb' && p.isPrinting).map((p) => p.config.name);
  }

  async ports() {
    const ports = await listPorts();
    return ports.map((port) => {
      const user = [...this.printers.values()].find((p) => p.type === 'usb' && p.port === port.path && p.state !== 'offline' && port.path !== VIRTUAL_PORT);
      return { ...port, usedBy: user ? user.config.name : null };
    });
  }

  startPrint(id, fileName) {
    const p = this.get(id);
    const file = this.files.get(fileName);
    if (!file) throw new Error('File non trovato.');
    if (file.meta && file.meta.error) throw new Error('Questo file non si può stampare: ' + file.meta.error);
    const kind = fileKind(file.name);
    const accepted = p.capabilities.files || ['.gcode'];
    if (!accepted.includes(kind)) {
      throw new Error(kind === '.3mf'
        ? 'I progetti .gcode.3mf si stampano solo sulle stampanti Bambu Lab. Per questa stampante esporta un file G-code.'
        : `Questa stampante accetta solo file ${accepted.join(', ')}.`);
    }
    if (p.type === 'usb' && file.meta && file.meta.bounds) {
      const b = file.meta.bounds;
      const v = p.config.volume;
      const div = p.config.originCenter ? 2 : 1;
      const tol = 5;
      if (b.maxX > v.x / div + tol || b.maxY > v.y / div + tol || b.maxZ > v.z + tol) {
        // solo un avviso: alcune stampanti hanno coordinate fuori dal volume nominale
        p._log('warn', `Attenzione: il modello (${Math.round(b.maxX)}×${Math.round(b.maxY)}×${Math.round(b.maxZ)} mm) sembra più grande del volume impostato.`);
      }
    }
    p.startPrint(file);
  }

  // --- impostazioni ----------------------------------------------------------------

  /** Impostazioni senza la chiave di accesso remoto (quella si legge solo dall'abbinamento locale). */
  publicSettings() {
    const { enabled, hash } = this.settings.lan;
    return { ...this.settings, remote: { enabled: this.settings.remote.enabled }, lan: { enabled, hasPassword: !!hash } };
  }

  /** Vero se la password dell'accesso dalla rete è giusta (confronto a tempo costante). */
  checkLanPassword(password) {
    const { hash, salt } = this.settings.lan;
    if (!hash || !salt || typeof password !== 'string' || !password) return false;
    const got = crypto.scryptSync(password, salt, 64);
    const want = Buffer.from(hash, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  regenerateRemoteKey() {
    this.settings.remote = { ...this.settings.remote, key: newRemoteKey() };
    this._saveConfig();
    this.emit('remote-key-changed');
    return this.settings.remote.key;
  }

  updateSettings(patch) {
    patch = { ...(patch || {}) };
    if ('port' in patch) {
      const port = validPort(patch.port);
      if (!port) throw new Error('La porta deve essere un numero tra 1024 e 65535.');
      patch.port = port;
    }
    // accesso dalla rete: attivazione e password (mai restituita, solo salvata come hash)
    let lanPasswordChanged = false;
    if ('lan' in patch) {
      const p = patch.lan || {};
      const lan = { ...this.settings.lan };
      if (typeof p.password === 'string' && p.password !== '') {
        if (p.password.length < 6) throw new Error('La password deve avere almeno 6 caratteri.');
        if (p.password.length > 200) throw new Error('La password è troppo lunga.');
        lan.salt = crypto.randomBytes(16).toString('hex');
        lan.hash = crypto.scryptSync(p.password, lan.salt, 64).toString('hex');
        lanPasswordChanged = true;
      }
      if ('enabled' in p) lan.enabled = !!p.enabled;
      if (lan.enabled && !lan.hash) throw new Error('Scegli una password prima di aprire SonoPrint alla rete.');
      patch.lan = lan;
    } else {
      patch.lan = this.settings.lan;
    }
    // della sezione "remote" si può cambiare solo l'attivazione, mai la chiave
    patch.remote = 'remote' in patch
      ? { ...this.settings.remote, enabled: !!(patch.remote && patch.remote.enabled) }
      : this.settings.remote;
    const next = { ...this.settings, ...patch };
    if (Array.isArray(next.presets)) {
      next.presets = next.presets
        .map((pr) => ({
          name: String(pr.name || '').slice(0, 30),
          hotend: clampNum(pr.hotend, 0, 450, 0),
          bed: clampNum(pr.bed, 0, 150, 0),
        }))
        .filter((pr) => pr.name);
    }
    next.notifications = !!next.notifications;
    next.preventSleep = !!next.preventSleep;
    next.developer = !!next.developer;
    // senza modalità sviluppatore l'accesso dal telefono resta spento
    if (!next.developer) next.remote = { ...next.remote, enabled: false };
    this.settings = next;
    this._saveConfig();
    if (lanPasswordChanged) this.emit('lan-password-changed');
    this.emit('settings-changed');
    return this.publicSettings();
  }

  // --- interni ---------------------------------------------------------------------

  _createPrinter(cfg) {
    if (!cfg.id || this.printers.has(cfg.id)) cfg.id = crypto.randomBytes(5).toString('hex');
    const p = this._makePrinter(cfg);
    this.printers.set(cfg.id, p);
    this.order.push(cfg.id);
    return p;
  }

  _makePrinter(cfg) {
    const p = createPrinter(cfg, { files: this.files, ...(this.printerDeps || {}) });
    p.on('update', () => this.emit('printer-update', p));
    p.on('temp', (sample) => this.emit('temp', p.id, sample));
    p.on('log', (entry) => this.emit('log', p.id, entry));
    p.on('notify', (n) => this.emit('notify', { ...n, printerId: p.id }));
    p.on('config-patch', (patch) => {
      Object.assign(p.config, patch);
      this._saveConfig();
      this.emit('printer-update', p);
    });
    p.on('job-started', () => this.emit('printing-changed'));
    p.on('job-ended', (info) => {
      this.files.recordPrint(info.file, info.result, info.printerName);
      this.history.unshift({
        printerId: info.printerId,
        printer: info.printerName,
        file: info.file,
        result: info.result,
        reason: info.reason,
        startedAt: info.startedAt,
        finishedAt: info.finishedAt,
        duration: info.duration,
      });
      this.history = this.history.slice(0, 500);
      writeJson(this.historyPath, this.history);
      this.emit('history-changed');
      this.emit('printing-changed');
    });
    return p;
  }

  _saveConfig() {
    writeJson(this.configPath, {
      version: 1,
      settings: this.settings,
      printers: this.order.map((id) => this.printers.get(id).config),
    });
  }

  async shutdown() {
    this.files.flush();
    await Promise.all(this.list().map((p) => p.disconnect().catch(() => {})));
  }
}

function sanitizeConfig(input, index) {
  const d = defaultPrinterConfig(Math.max(0, index));
  const c = deepMerge(d, input || {});
  c.type = TYPE_NAMES.includes(c.type) ? c.type : 'usb';
  c.name = String(c.name || d.name).trim().slice(0, 60) || d.name;
  c.model = String(c.model || '').slice(0, 60);
  c.color = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : d.color;
  c.port = String(c.port || '');
  c.baudrate = c.baudrate === 'auto' ? 'auto' : (parseInt(c.baudrate, 10) || 'auto');
  c.autoConnect = !!c.autoConnect;
  c.volume = {
    x: clampNum(c.volume.x, 10, 2000, 220),
    y: clampNum(c.volume.y, 10, 2000, 220),
    z: clampNum(c.volume.z, 10, 2000, 250),
  };
  c.originCenter = !!c.originCenter;
  c.extruders = clampNum(c.extruders, 1, 8, 1);
  c.heatedBed = !!c.heatedBed;
  c.heatedChamber = !!c.heatedChamber;
  c.jog = { xySpeed: clampNum(c.jog.xySpeed, 60, 30000, 6000), zSpeed: clampNum(c.jog.zSpeed, 30, 6000, 600) };
  c.extrudeSpeed = clampNum(c.extrudeSpeed, 10, 6000, 300);
  c.pause = {
    retract: clampNum(c.pause.retract, 0, 20, 2),
    lift: clampNum(c.pause.lift, 0, 100, 5),
    park: !!c.pause.park,
    parkX: clampNum(c.pause.parkX, -1000, 2000, 0),
    parkY: clampNum(c.pause.parkY, -1000, 2000, 0),
  };
  for (const k of Object.keys(d.scripts)) c.scripts[k] = String(c.scripts[k] ?? d.scripts[k]).slice(0, 20000);
  for (const k of Object.keys(c.scripts)) if (!(k in d.scripts)) delete c.scripts[k];
  c.webcam = {
    type: ['none', 'local', 'url'].includes(c.webcam.type) ? c.webcam.type : 'none',
    url: String(c.webcam.url || '').slice(0, 500),
    deviceId: String(c.webcam.deviceId || '').slice(0, 300),
    flipH: !!c.webcam.flipH,
    flipV: !!c.webcam.flipV,
    rotate: [0, 90, 180, 270].includes(Number(c.webcam.rotate)) ? Number(c.webcam.rotate) : 0,
  };
  c.virtualSpeed = clampNum(c.virtualSpeed, 1, 50, 4);
  c.lastBaudrate = parseInt(c.lastBaudrate, 10) || null;
  const hp = parseHost(c.net.host);
  const port = parseInt(c.net.port, 10) || hp.port || null;
  c.net = {
    host: hp.host.slice(0, 120),
    port: port && port > 0 && port < 65536 ? port : null,
    serial: String(c.net.serial || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32),
    accessCode: String(c.net.accessCode || '').trim().slice(0, 64),
    apiKey: String(c.net.apiKey || '').trim().slice(0, 200),
    username: String(c.net.username || '').trim().slice(0, 64),
    password: String(c.net.password || '').slice(0, 200),
    tlsFingerprint: String(c.net.tlsFingerprint || '').slice(0, 200),
  };
  c.bambu = {
    useAms: !!c.bambu.useAms,
    bedLeveling: c.bambu.bedLeveling !== false,
    timelapse: !!c.bambu.timelapse,
    flowCalibration: !!c.bambu.flowCalibration,
    vibrationCalibration: !!c.bambu.vibrationCalibration,
  };
  for (const k of Object.keys(c)) if (!(k in d)) delete c[k];
  return c;
}

function validPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { PrinterManager, sanitizeConfig, defaultPrinterConfig };
