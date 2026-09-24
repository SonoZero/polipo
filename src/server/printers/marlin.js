'use strict';

// Stampante collegata via USB: connessione, protocollo Marlin (numeri di riga +
// checksum, resend, timeout), temperature, controllo manuale e stampa di file G-code.

const { BasePrinter, summarizeFirmware } = require('./base');
const { createTransport, VIRTUAL_PORT } = require('../transport');
const { flashHex, parseIntelHex } = require('../firmware/avr');
const { listRemovableDrives, copyFirmwareToDrive } = require('../firmware/drives');
const { latestRelease, compareVersions } = require('../firmware/releases');
const {
  checksum, stripComment, commandCode, param, normalizeCommand,
  parseTemperatures, parsePosition, parseFirmwareInfo, parseCapability,
  GcodeFileReader,
} = require('../gcode');

const BAUDRATES = [115200, 250000, 230400, 57600, 38400, 19200, 9600];
const LONG_COMMANDS = new Set(['G28', 'G29', 'G32', 'G33', 'G34', 'G35', 'G4', 'M109', 'M190', 'M191', 'M400', 'M303', 'M600', 'M48', 'M0', 'M1', 'M226', 'G76', 'M1002']);
const HISTORY_SIZE = 250;
const COMM_TIMEOUT = 30000;
const LONG_TIMEOUT = 10 * 60 * 1000;
const RESEND_ERRORS = /checksum mismatch|Line Number is not|No Line Number|No Checksum|Missing checksum|Wrong checksum|Format error|expected line|line number/i;
const FATAL_ERRORS = /halted|kill\(\)|thermal runaway|mintemp|maxtemp|heating failed|printer stopped|stopped due to errors|emergency/i;

const DEFAULT_CANCEL_SCRIPT = [
  'M104 S0 ; spegni ugello',
  'M140 S0 ; spegni piatto',
  'M106 S0 ; spegni ventola',
  'G91',
  'G1 Z5 F600 ; alza ugello',
  'G90',
  'M84 ; motori off',
].join('\n');

class MarlinPrinter extends BasePrinter {
  /**
   * @param {object} config configurazione salvata della stampante
   * @param {object} deps { files: FileStore }
   */
  constructor(config, deps = {}) {
    super(config, deps);
    this.virtualOverrides = deps.virtualOptions || {};
    this.openSerial = deps.openSerial || null;
    this.transport = null;
    this.port = null;
    this.baudrate = null;
    this.fwCaps = {};

    this._resetComm();
    this._tickTimer = null;
    this._connectToken = 0;
  }

  // ---------------------------------------------------------------------------
  // Stato pubblico

  get isConnected() {
    return !['offline', 'connecting'].includes(this.state) && !!this.transport;
  }

  get capabilities() {
    const virtual = (this.port || this.config.port) === VIRTUAL_PORT;
    return {
      link: 'serial',
      temps: true, jog: true, home: true, extrude: true, motorsOff: true,
      fan: true, feedRate: true, flowRate: true, emergency: true,
      terminal: 'full', scripts: true, preview: true, webcam: 'custom',
      firmware: virtual ? null : 'marlin',
      files: ['.gcode'],
    };
  }

  _snapshotExtra() {
    return { port: this.port, baudrate: this.baudrate };
  }

  // ---------------------------------------------------------------------------
  // Connessione

  async connect(opts = {}) {
    if (this.state !== 'offline' && this.state !== 'error') {
      throw new Error('La stampante è già connessa.');
    }
    if (this.transport) await this._closeTransport();

    const port = opts.port || this.config.port;
    const baudSetting = opts.baudrate || this.config.baudrate || 'auto';
    if (!port) throw new Error('Seleziona prima la porta a cui è collegata la stampante.');

    let bauds;
    if (port === VIRTUAL_PORT) bauds = [115200];
    else if (baudSetting === 'auto') {
      const last = this.config.lastBaudrate;
      bauds = last ? [last, ...BAUDRATES.filter((b) => b !== last)] : BAUDRATES.slice();
    } else bauds = [Number(baudSetting)];

    const token = ++this._connectToken;
    this.error = null;
    this._setState('connecting');
    this._log('info', `Connessione a ${port === VIRTUAL_PORT ? 'stampante virtuale' : port}…`);

    let lastError = null;
    for (const baud of bauds) {
      if (token !== this._connectToken) return; // annullato
      try {
        await this._tryConnect(port, baud, bauds.length > 1, token);
        if (token !== this._connectToken) return;
        this._onConnected(port, baud);
        return;
      } catch (err) {
        lastError = err;
        await this._closeTransport();
        if (err.fatal) break;
        if (bauds.length > 1) this._log('info', `Nessuna risposta a ${baud} baud.`);
      }
    }
    if (token !== this._connectToken) return;
    const msg = lastError && lastError.fatal
      ? lastError.message
      : (bauds.length > 1
        ? 'La stampante non risponde a nessun baudrate. Controlla il cavo USB, che sia accesa e la porta scelta.'
        : `La stampante non risponde a ${bauds[0]} baud. Prova con "Automatico" o un altro baudrate.`);
    this._fail(msg);
    throw new Error(msg);
  }

  async disconnect() {
    this._connectToken++;
    if (this.job) this._endJob('failed', 'Disconnessa durante la stampa');
    await this._closeTransport();
    this._resetComm();
    this.error = null;
    this.firmware = null;
    this.position = null;
    this._clearTemps();
    this._setState('offline');
    this._log('info', 'Disconnessa.');
  }

  /** Libera la porta seriale (per esempio per aggiornare il firmware) e dice se era connessa. */
  async releasePort() {
    if (this.isPrinting) throw new Error('Aspetta la fine della stampa.');
    const wasConnected = this.state !== 'offline' && this.state !== 'error';
    if (wasConnected || this.transport) await this.disconnect();
    return wasConnected;
  }

  _tryConnect(port, baud, probing, token) {
    return new Promise((resolve, reject) => {
      this._resetComm();
      const virtualOptions = {
        speed: this.config.virtualSpeed || 4,
        extruders: this.config.extruders || 1,
        name: this.config.name,
        ...this.virtualOverrides,
      };
      const transport = createTransport(port, baud, virtualOptions);
      this.transport = transport;

      let settled = false;
      let helloTimer = null;
      let attempts = 0;
      const maxAttempts = probing ? 2 : 4;

      const cleanup = () => {
        settled = true;
        clearTimeout(helloTimer);
        this._handshake = null;
      };
      const sendHello = () => {
        if (settled) return;
        if (token !== this._connectToken) { cleanup(); return reject(new Error('annullato')); }
        if (attempts >= maxAttempts) {
          cleanup();
          return reject(new Error('timeout'));
        }
        attempts++;
        this.lineNumber = 0;
        this._writeRaw(this._numbered(0, 'M110 N0'), 'M110 N0');
        this.lineNumber = 1;
        this.clearToSend = false;
        clearTimeout(helloTimer);
        helloTimer = setTimeout(sendHello, probing ? 2500 : 3000);
      };

      this._handshake = {
        ok: () => { if (!settled) { cleanup(); resolve(); } },
        start: () => { // la scheda si è appena riavviata: saluta di nuovo
          if (settled) return;
          clearTimeout(helloTimer);
          helloTimer = setTimeout(sendHello, 300);
        },
      };

      transport.on('line', (line) => this._onLine(line));
      transport.on('close', () => this._onTransportClosed(transport));
      transport.on('error', (err) => this._log('error', 'Errore seriale: ' + err.message));

      transport.open().then(() => {
        this._log('info', port === VIRTUAL_PORT ? 'Stampante virtuale avviata.' : `Porta ${port} aperta a ${baud} baud.`);
        // molte schede si riavviano all'apertura della porta: aspetta "start" o 2 s
        helloTimer = setTimeout(sendHello, port === VIRTUAL_PORT ? 800 : 2000);
      }, (err) => {
        cleanup();
        const e = new Error(err.message);
        e.fatal = true;
        reject(e);
      });
    });
  }

  _onConnected(port, baud) {
    this.port = port;
    this.baudrate = baud;
    this.error = null;
    this.clearToSend = true;
    this.lastReceived = Date.now();
    this._setState('operational');
    this._log('info', `Connessa (${port === VIRTUAL_PORT ? 'virtuale' : baud + ' baud'}).`);
    if (port !== VIRTUAL_PORT && this.config.lastBaudrate !== baud) {
      this.emit('config-patch', { lastBaudrate: baud });
    }
    this._tickTimer = setInterval(() => this._tick(), 1000);
    this._enqueue(['M115', 'M105']);
    const after = scriptLines(this.config.scripts && this.config.scripts.afterConnect);
    if (after.length) this._enqueue(after);
    this._sendNext();
    this.emit('notify', { level: 'info', title: this.config.name, message: 'Stampante connessa', quiet: true });
  }

  async _closeTransport() {
    clearInterval(this._tickTimer);
    this._tickTimer = null;
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.removeAllListeners();
      t.on('error', () => {});
      try { await t.close(); } catch (_) { /* ignora */ }
    }
  }

  _onTransportClosed(transport) {
    if (transport !== this.transport) return;
    this._log('error', 'Connessione con la stampante persa (cavo USB scollegato?).');
    if (this.job) this._endJob('failed', 'Connessione persa');
    this._closeTransport();
    this._resetComm();
    this._fail('Connessione persa: la stampante è stata scollegata o spenta.');
  }

  _resetComm() {
    this.lineNumber = 0;
    this.history = new Map();
    this.resendFrom = null;
    this.clearToSend = false;
    this.queue = [];
    this.lastSentCode = null;
    this.lastSentAt = 0;
    this.lastReceived = Date.now();
    this.longCommand = false;
    this.kicks = 0;
    this.lastTempPoll = 0;
    this.autoreport = false;
    this.fwCaps = {};
    this._handshake = null;
  }

  // ---------------------------------------------------------------------------
  // Ricezione

  _onLine(raw) {
    const line = raw.replace(/\0/g, '').trim();
    if (!line) return;
    this.lastReceived = Date.now();
    this.kicks = 0;

    if (line.startsWith('ok')) {
      const temps = parseTemperatures(line);
      if (temps) this._applyTemps(temps);
      this._log('recv', line, true);
      return this._onOk();
    }

    let m;
    if ((m = /^(?:Resend|rs)[:\s]\s*N?(\d+)/i.exec(line))) {
      this._log('recv', line);
      return this._onResend(parseInt(m[1], 10));
    }

    if (line === 'start') {
      this._log('recv', line);
      if (this._handshake) return this._handshake.start();
      if (this.transport) {
        if (this.job) {
          this._endJob('failed', 'La stampante si è riavviata');
          this._fail('La stampante si è riavviata durante la stampa (alimentazione o firmware).');
          return;
        }
        this._log('warn', 'La stampante si è riavviata, reinizializzo la comunicazione.');
        this.queue = [];
        this.lineNumber = 0;
        this.history.clear();
        this.resendFrom = null;
        this.clearToSend = true;
        this._enqueue(['M110 N0', 'M115', 'M105']);
        this._sendNext();
      }
      return;
    }

    if (/^(Error:|!!)/.test(line)) {
      this._log('error', line);
      return this._onFirmwareError(line.replace(/^(Error:|!!)\s*/, ''));
    }

    const temps = parseTemperatures(line);
    if (temps) {
      this._applyTemps(temps);
      this._log('recv', line, true);
      return;
    }

    if ((m = /^\/\/\s*action:(\w+)/.exec(line))) {
      this._log('recv', line);
      return this._onAction(m[1].toLowerCase());
    }

    if (/busy:/.test(line) || line === 'wait') {
      this._log('recv', line, true);
      return;
    }

    const pos = parsePosition(line);
    if (pos) {
      this.position = pos;
      this._log('recv', line);
      this._changed();
      return;
    }

    const fw = parseFirmwareInfo(line);
    if (fw) {
      this.firmware = {
        name: fw.FIRMWARE_NAME || null,
        version: firmwareVersion(fw.FIRMWARE_NAME),
        machine: fw.MACHINE_TYPE || null,
        extruders: fw.EXTRUDER_COUNT ? parseInt(fw.EXTRUDER_COUNT, 10) : null,
        sourceUrl: fw.SOURCE_CODE_URL || null,
      };
      this._log('recv', line);
      this._changed();
      return;
    }

    const cap = parseCapability(line);
    if (cap) {
      this.fwCaps[cap.name] = cap.enabled;
      this._log('recv', line, true);
      return;
    }

    this._log('recv', line);
  }

  _onOk() {
    if (this._handshake) return this._handshake.ok();
    this.clearToSend = true;
    this.longCommand = false;
    if (this.lastSentCode === 'M115') this._afterFirmwareInfo();
    this._sendNext();
  }

  _onResend(n) {
    if (n >= this.lineNumber) return; // riga mai inviata: ignora
    if (!this.history.has(n)) {
      this._log('error', `La stampante ha chiesto di reinviare la riga ${n}, non più disponibile.`);
      if (this.job) this._endJob('failed', 'Errore di comunicazione');
      this.queue = [];
      this._fail('Errore di comunicazione con la stampante (resend impossibile).');
      return;
    }
    this.resendFrom = n;
    this._log('warn', `Reinvio dalla riga ${n}.`, true);
  }

  _onFirmwareError(msg) {
    if (RESEND_ERRORS.test(msg)) return; // seguirà una richiesta di Resend
    if (FATAL_ERRORS.test(msg)) {
      if (this.job) this._endJob('failed', msg);
      this.queue = [];
      this._fail('Errore del firmware: ' + msg);
      return;
    }
    this.emit('notify', { level: 'warn', title: this.config.name, message: msg, quiet: true });
  }

  _onAction(action) {
    switch (action) {
      case 'pause':
      case 'paused':
        if (this.state === 'printing') this.pause({ fromPrinter: true });
        break;
      case 'resume':
      case 'resumed':
        if (this.state === 'paused') this.resume({ fromPrinter: true });
        break;
      case 'cancel':
        if (this.job) this.cancel();
        break;
      case 'disconnect':
        this.disconnect();
        break;
      default:
        break;
    }
  }

  _afterFirmwareInfo() {
    if (this.autoreport) return;
    if (this.fwCaps.AUTOREPORT_TEMP) {
      this.autoreport = true;
      this._enqueue(['M155 S2']);
    }
  }

  // ---------------------------------------------------------------------------
  // Invio

  _numbered(n, cmd) {
    const body = `N${n} ${cmd}`;
    return `${body}*${checksum(body)}`;
  }

  _writeRaw(line, display, quiet = false) {
    if (!this.transport) return;
    this.transport.write(line);
    this.lastSentAt = Date.now();
    this._log('send', display || line, quiet);
  }

  _enqueue(cmds, front = false) {
    const list = cmds.map(normalizeCommand).filter(Boolean);
    if (front) this.queue.unshift(...list);
    else this.queue.push(...list);
  }

  _sendNext() {
    if (!this.clearToSend || !this.transport || this._handshake) return;

    if (this.resendFrom !== null) {
      const n = this.resendFrom;
      this.resendFrom = n + 1 < this.lineNumber ? n + 1 : null;
      const cmd = this.history.get(n);
      if (cmd !== undefined) {
        this.clearToSend = false;
        this._writeRaw(this._numbered(n, cmd), cmd);
        return;
      }
    }

    if (this.queue.length) {
      this._sendCommand(this.queue.shift(), false);
      return;
    }

    if (this.state === 'printing' && this.job) {
      const cmd = this._nextJobLine();
      if (cmd !== null) {
        this._sendCommand(cmd, true);
        this._changed();
        return;
      }
      this._endJob('done');
      const after = scriptLines(this.config.scripts && this.config.scripts.afterPrint);
      if (after.length) { this._enqueue(after); this._sendNext(); }
      return;
    }

    if (this.state === 'pausing') {
      this._setState('paused');
      if (this.job) this.job.pausedAt = this.job.pausedAt || Date.now();
      return;
    }
    if (this.state === 'cancelling') {
      this._setState('operational');
    }
  }

  _sendCommand(cmd, fromJob) {
    const code = commandCode(cmd);

    if (code === 'M112') return this.emergencyStop();

    if (code === 'M110') {
      const n = param(cmd, 'N') ?? 0;
      this.history.clear();
      this.resendFrom = null;
      this.clearToSend = false;
      this.lastSentCode = code;
      this._writeRaw(this._numbered(n, `M110 N${n}`), cmd);
      this.lineNumber = n + 1;
      return;
    }

    this._trackCommand(code, cmd, fromJob);

    const n = this.lineNumber++;
    this.history.set(n, cmd);
    this.history.delete(n - HISTORY_SIZE);
    this.clearToSend = false;
    this.lastSentCode = code;
    this.longCommand = LONG_COMMANDS.has(code);
    this._writeRaw(this._numbered(n, cmd), cmd, fromJob);
  }

  /** Aggiorna lo stato noto (target, ventola, modalità di posizionamento) dai comandi inviati. */
  _trackCommand(code, cmd, fromJob) {
    const g = this.job && this.job.gstate;
    switch (code) {
      case 'M104':
      case 'M109': {
        const s = param(cmd, 'S') ?? param(cmd, 'R');
        const t = param(cmd, 'T');
        const key = 'T' + (t !== null ? t : 0);
        if (s !== null && this.temps.tools[key]) this.temps.tools[key].target = s;
        break;
      }
      case 'M140':
      case 'M190': {
        const s = param(cmd, 'S') ?? param(cmd, 'R');
        if (s !== null) this.temps.bed = { actual: this.temps.bed ? this.temps.bed.actual : null, target: s };
        break;
      }
      case 'M106': this.fanSpeed = Math.round(((param(cmd, 'S') ?? 255) / 255) * 100); break;
      case 'M107': this.fanSpeed = 0; break;
      case 'M220': { const s = param(cmd, 'S'); if (s !== null) this.feedRate = s; break; }
      case 'M221': { const s = param(cmd, 'S'); if (s !== null) this.flowRate = s; break; }
      default: break;
    }
    if (!fromJob || !g) return;
    switch (code) {
      case 'G90': g.relative = false; g.relativeE = false; break;
      case 'G91': g.relative = true; g.relativeE = true; break;
      case 'M82': g.relativeE = false; break;
      case 'M83': g.relativeE = true; break;
      case 'G0':
      case 'G1': {
        const f = param(cmd, 'F');
        if (f) g.feedrate = f;
        const x = param(cmd, 'X'); const y = param(cmd, 'Y'); const z = param(cmd, 'Z');
        if (x !== null) g.x = g.relative ? (g.x ?? 0) + x : x;
        if (y !== null) g.y = g.relative ? (g.y ?? 0) + y : y;
        if (z !== null) g.z = g.relative ? (g.z ?? 0) + z : z;
        break;
      }
      case 'G92': {
        const x = param(cmd, 'X'); const y = param(cmd, 'Y'); const z = param(cmd, 'Z');
        if (x !== null) g.x = x; if (y !== null) g.y = y; if (z !== null) g.z = z;
        break;
      }
      case 'G28': g.x = null; g.y = null; g.z = null; break;
      case 'M73': {
        const p = param(cmd, 'P'); const r = param(cmd, 'R');
        if (p !== null || r !== null) this.job.m73 = { p, r, at: Date.now() };
        break;
      }
      default: break;
    }
  }

  _tick() {
    if (!this.transport || this._handshake) return;
    const now = Date.now();

    // timeout di comunicazione: prova a sbloccare con un M105 (come OctoPrint)
    if (!this.clearToSend && this.state !== 'error') {
      const limit = this.longCommand ? LONG_TIMEOUT : COMM_TIMEOUT;
      if (now - this.lastReceived > limit && now - this.lastSentAt > limit) {
        this.kicks++;
        if (this.kicks > 5) {
          if (this.job) this._endJob('failed', 'La stampante non risponde');
          this.queue = [];
          this._fail('La stampante non risponde più.');
          return;
        }
        this._log('warn', `Nessuna risposta da ${Math.round(limit / 1000)} s, invio M105 per sbloccare la comunicazione.`);
        this.lastReceived = now;
        this._writeRaw('M105', 'M105');
      }
    }

    // lettura periodica delle temperature se il firmware non le invia da solo
    if (!this.autoreport && this.state !== 'error' && !this.longCommand) {
      const interval = this.state === 'printing' ? 5000 : 2000;
      if (now - this.lastTempPoll >= interval && !this.queue.includes('M105')) {
        this.lastTempPoll = now;
        this._enqueue(['M105']);
        this._sendNext();
      }
    }

    if (this.job) this._changed();
  }

  // ---------------------------------------------------------------------------
  // Comandi

  sendCommands(commands) {
    this._requireConnected();
    const list = (Array.isArray(commands) ? commands : String(commands).split('\n'))
      .map((c) => normalizeCommand(String(c))).filter(Boolean);
    if (list.some((c) => commandCode(c) === 'M112')) return this.emergencyStop();
    this._enqueue(list);
    this._sendNext();
  }

  setTemperature(heater, target) {
    const t = Math.max(0, Math.round(Number(target) || 0));
    if (heater === 'bed') return this.sendCommands([`M140 S${t}`]);
    if (heater === 'chamber') return this.sendCommands([`M141 S${t}`]);
    const m = /^T(\d+)$/.exec(heater);
    if (!m) throw new Error('Riscaldatore sconosciuto: ' + heater);
    return this.sendCommands([`M104 T${m[1]} S${t}`]);
  }

  jog(axes, speed) {
    this._requireIdleOrPaused();
    const parts = [];
    for (const a of ['x', 'y', 'z']) {
      const v = Number(axes[a]);
      if (v) parts.push(a.toUpperCase() + round3(v));
    }
    if (!parts.length) return;
    const onlyZ = parts.length === 1 && parts[0][0] === 'Z';
    const jogCfg = this.config.jog || {};
    const f = speed || (onlyZ ? (jogCfg.zSpeed || 600) : (jogCfg.xySpeed || 6000));
    this.sendCommands(['G91', `G1 ${parts.join(' ')} F${f}`, 'G90']);
  }

  home(axes) {
    this._requireIdleOrPaused();
    const list = (axes && axes.length ? axes : []).map((a) => String(a).toUpperCase()).filter((a) => /^[XYZ]$/.test(a));
    this.sendCommands([list.length ? `G28 ${list.join(' ')}` : 'G28']);
  }

  extrude(amount, speed, tool) {
    this._requireIdleOrPaused();
    const cmds = [];
    if (tool !== undefined && tool !== null) cmds.push(`T${tool}`);
    cmds.push('M83', `G1 E${round3(Number(amount))} F${speed || this.config.extrudeSpeed || 300}`, 'M82');
    this.sendCommands(cmds);
  }

  setFan(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    this.sendCommands([p > 0 ? `M106 S${Math.round(p * 2.55)}` : 'M107']);
  }

  motorsOff() {
    this._requireIdleOrPaused();
    this.sendCommands(['M84']);
  }

  setFeedRate(p) { this.sendCommands([`M220 S${Math.round(Number(p))}`]); }
  setFlowRate(p) { this.sendCommands([`M221 S${Math.round(Number(p))}`]); }

  emergencyStop() {
    if (!this.transport) return;
    this.transport.write('M112');
    this._log('send', 'M112');
    this.queue = [];
    if (this.job) this._endJob('failed', 'Arresto di emergenza');
    this._fail('Arresto di emergenza (M112). Riconnetti o riavvia la stampante per continuare.');
  }

  _requireConnected() {
    if (!this.transport || this.state === 'offline' || this.state === 'connecting') {
      throw new Error('La stampante non è connessa.');
    }
  }

  _requireIdleOrPaused() {
    this._requireConnected();
    if (!['operational', 'paused'].includes(this.state)) {
      throw new Error('Comando non disponibile durante la stampa.');
    }
  }

  // ---------------------------------------------------------------------------
  // Stampa

  startPrint(file) {
    this._requireConnected();
    if (this.state !== 'operational') throw new Error('La stampante non è pronta per stampare.');
    const reader = new GcodeFileReader(file.path);
    const meta = file.meta || {};
    this.job = {
      name: file.name,
      path: file.path,
      size: reader.size,
      reader,
      startedAt: Date.now(),
      pausedAt: null,
      pausedTotal: 0,
      layer: 0,
      layerCount: meta.layerCount || null,
      estimatedTime: meta.estimatedTime || null,
      filamentLength: meta.filamentLength || null,
      m73: null,
      slicerElapsed: null,
      done: false,
      gstate: { relative: false, relativeE: false, feedrate: 1500, x: null, y: null, z: null },
    };
    this.lastJob = null;
    const before = scriptLines(this.config.scripts && this.config.scripts.beforePrint);
    if (before.length) this._enqueue(before);
    this._setState('printing');
    this._log('info', `Stampa avviata: ${file.name}`);
    this.emit('job-started', { file: file.name });
    this._sendNext();
  }

  pause(opts = {}) {
    if (this.state !== 'printing' || !this.job) throw new Error('Nessuna stampa in corso da mettere in pausa.');
    this.job.pausedAt = Date.now();
    if (!opts.fromPrinter) this._enqueue(this._pauseCommands());
    this._setState('pausing');
    this._log('info', 'Stampa in pausa.');
    this._sendNext();
  }

  resume(opts = {}) {
    if (this.state !== 'paused' || !this.job) throw new Error('La stampa non è in pausa.');
    if (this.job.pausedAt) {
      this.job.pausedTotal += Date.now() - this.job.pausedAt;
      this.job.pausedAt = null;
    }
    if (!opts.fromPrinter) this._enqueue(this._resumeCommands());
    this._setState('printing');
    this._log('info', 'Stampa ripresa.');
    this._sendNext();
  }

  cancel() {
    if (!this.job) throw new Error('Nessuna stampa da annullare.');
    this._endJob('cancelled');
    this.queue = [];
    const script = this.config.scripts && typeof this.config.scripts.afterCancel === 'string'
      ? this.config.scripts.afterCancel : DEFAULT_CANCEL_SCRIPT;
    const lines = scriptLines(script);
    if (lines.length && this.transport) {
      this._enqueue(lines);
      this._setState('cancelling');
      this._sendNext();
    } else {
      this._setState(this.transport ? 'operational' : 'offline');
    }
  }

  _pauseCommands() {
    const p = this.config.pause || {};
    const retract = num(p.retract, 2);
    const lift = num(p.lift, 5);
    const g = this.job.gstate;
    const cmds = [];
    if (retract > 0) cmds.push('M83', `G1 E-${retract} F2400`);
    if (lift > 0) cmds.push('G91', `G1 Z${lift} F600`, 'G90');
    if (p.park && g.x !== null && g.y !== null && isFinite(p.parkX) && isFinite(p.parkY)) {
      cmds.push('G90', `G1 X${p.parkX} Y${p.parkY} F6000`);
      this.job.parked = { x: g.x, y: g.y };
    } else {
      this.job.parked = null;
    }
    cmds.push(...scriptLines(this.config.scripts && this.config.scripts.pause));
    cmds.push(...this._restoreModes());
    return cmds;
  }

  _resumeCommands() {
    const p = this.config.pause || {};
    const retract = num(p.retract, 2);
    const lift = num(p.lift, 5);
    const cmds = [...scriptLines(this.config.scripts && this.config.scripts.resume)];
    if (this.job.parked) cmds.push('G90', `G1 X${this.job.parked.x} Y${this.job.parked.y} F6000`);
    if (lift > 0) cmds.push('G91', `G1 Z-${lift} F600`, 'G90');
    if (retract > 0) cmds.push('M83', `G1 E${retract} F2400`);
    cmds.push(...this._restoreModes(), `G1 F${this.job.gstate.feedrate}`);
    return cmds;
  }

  _restoreModes() {
    const g = this.job.gstate;
    return [g.relative ? 'G91' : 'G90', g.relativeE ? 'M83' : 'M82'];
  }

  _nextJobLine() {
    const job = this.job;
    for (;;) {
      const raw = job.reader.nextRaw();
      if (raw === null) return null;
      const line = raw.trim();
      if (!line) continue;
      if (line[0] === ';') {
        this._jobComment(line.slice(1).trim());
        continue;
      }
      const cmd = stripComment(line);
      if (cmd) return cmd;
    }
  }

  _jobComment(c) {
    const job = this.job;
    let m;
    if (c === 'LAYER_CHANGE') job.layer++;
    else if ((m = /^LAYER:(-?\d+)/.exec(c))) job.layer = Math.max(job.layer, parseInt(m[1], 10) + 1);
    else if ((m = /^TIME_ELAPSED:([\d.]+)/.exec(c))) job.slicerElapsed = parseFloat(m[1]);
    else if ((m = /^LAYER_COUNT:(\d+)/.exec(c))) job.layerCount = parseInt(m[1], 10);
  }

  _jobInfo() {
    const job = this.job;
    if (!job) return null;
    const now = Date.now();
    const pausedNow = job.pausedAt ? now - job.pausedAt : 0;
    const elapsed = Math.max(0, (now - job.startedAt - job.pausedTotal - pausedNow) / 1000);
    const progress = job.reader ? job.reader.progress : 1;
    return {
      file: job.name,
      size: job.size,
      progress,
      elapsed: Math.round(elapsed),
      remaining: estimateRemaining(job, elapsed, progress),
      layer: job.layer || null,
      layerCount: job.layerCount,
      estimatedTime: job.estimatedTime,
      filamentLength: job.filamentLength,
      startedAt: job.startedAt,
      filePos: job.reader ? job.reader.pos : job.size,
    };
  }

  _endJob(result, reason) {
    const job = this.job;
    if (!job) return;
    const info = this._jobInfo();
    job.reader.close();
    this.job = null;
    if (result === 'done') this._setState('operational');
    this._recordJobEnd({ file: job.name, result, reason, duration: info.elapsed, progress: info.progress, startedAt: job.startedAt });
  }

  // ---------------------------------------------------------------------------
  // Helper

  // ---------------------------------------------------------------------------
  // Firmware

  /** Riepilogo per il centro aggiornamenti: senza cercare le schede SD, e niente per la stampante virtuale. */
  async _updateSummary(refresh) {
    if ((this.port || this.config.port) === VIRTUAL_PORT) return null;
    const fw = this.firmware;
    const isMarlin = !!(fw && /marlin/i.test(fw.name || ''));
    const latest = isMarlin ? await latestRelease('MarlinFirmware/Marlin', refresh) : null;
    return summarizeFirmware({ kind: 'marlin', current: fw, latest, updateAvailable: !!(latest && fw && fw.version && compareVersions(latest.version, fw.version) > 0) });
  }

  async firmwareInfo(refresh) {
    const fw = this.firmware;
    const isMarlin = !!(fw && /marlin/i.test(fw.name || ''));
    const latest = isMarlin ? await latestRelease('MarlinFirmware/Marlin', refresh) : null;
    const port = this.port || this.config.port || null;
    return {
      kind: 'marlin',
      current: fw,
      latest,
      updateAvailable: !!(latest && fw && fw.version && compareVersions(latest.version, fw.version) > 0),
      port,
      canInstall: !this.isPrinting && !!port && port !== VIRTUAL_PORT,
      drives: await listRemovableDrives(),
    };
  }

  /** Scrive un firmware .hex sulla scheda (schede a 8 bit con bootloader) e la verifica. */
  async flashHex(hexText) {
    const port = this.port || this.config.port;
    if (!port || port === VIRTUAL_PORT) throw new Error('Imposta prima la porta USB della stampante.');
    this._requireNoTask();
    parseIntelHex(hexText);
    const wasConnected = await this.releasePort();
    this._setTask({ kind: 'firmware', status: 'running', progress: 0, message: 'Preparazione...' });
    this._log('info', `Aggiornamento del firmware sulla porta ${port}...`);
    try {
      const result = await flashHex({
        path: port,
        hex: hexText,
        openPort: this.openSerial || openSerial,
        onProgress: (p) => this._setTask({ progress: p.progress, message: p.message }),
      });
      const msg = `Firmware scritto e verificato su ${result.device}.`;
      this._setTask({ status: 'done', progress: 1, message: msg });
      this._log('info', msg);
      if (wasConnected) setTimeout(() => { if (this.state === 'offline') this.connect().catch(() => {}); }, 4000);
      return result;
    } catch (err) {
      this._setTask({ status: 'error', message: err.message });
      this._log('error', 'Aggiornamento del firmware non riuscito: ' + err.message);
      throw err;
    }
  }

  async copyFirmwareToDrive(drive, srcPath, naming) {
    this._requireNoTask();
    const r = await copyFirmwareToDrive(drive, srcPath, naming);
    const msg = `Firmware copiato su ${r.drive} come ${r.name}. Espelli la scheda, inseriscila nella stampante spenta e accendila: l'aggiornamento parte da solo e dura circa un minuto.`;
    this._setTask({ kind: 'firmware', status: 'done', progress: 1, message: msg });
    this._log('info', msg);
    return r;
  }

  async destroy() {
    this._connectToken++;
    if (this.job) this._endJob('failed', 'Stampante rimossa');
    await this._closeTransport();
    await super.destroy();
  }
}

function estimateRemaining(job, elapsed, progress) {
  if (progress >= 1) return 0;
  // 1) M73 R dello slicer (PrusaSlicer / Orca / Bambu): il più preciso
  if (job.m73 && job.m73.r !== null) {
    const sinceM73 = (Date.now() - job.m73.at) / 1000;
    return Math.max(0, Math.round(job.m73.r * 60 - (job.pausedAt ? 0 : Math.min(sinceM73, 60))));
  }
  const est = job.estimatedTime;
  // 2) Cura: ;TIME_ELAPSED a ogni layer
  if (est && job.slicerElapsed !== null) {
    return Math.max(0, Math.round(est - job.slicerElapsed));
  }
  const linear = progress > 0.005 ? elapsed * (1 - progress) / progress : null;
  // 3) stima dello slicer mescolata con l'andamento reale
  if (est) {
    const slicer = Math.max(0, est - elapsed);
    if (linear === null) return Math.round(slicer);
    const w = Math.min(1, Math.max(0, (progress - 0.05) / 0.6));
    return Math.round(slicer * (1 - w) + linear * w);
  }
  return linear === null ? null : Math.round(linear);
}

function openSerial(path, baudRate) {
  const { SerialPort } = require('serialport');
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    port.open((err) => {
      if (err) return reject(new Error(`Impossibile aprire ${path}: ${err.message}. Chiudi gli altri programmi che usano la stampante.`));
      resolve(port);
    });
  });
}

/** "Marlin 2.1.2.1 (Jul 18 2023)" -> "2.1.2.1" */
function firmwareVersion(name) {
  const m = /(\d+\.\d+(?:\.\d+){0,2})/.exec(String(name || ''));
  return m ? m[1] : null;
}

function scriptLines(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/).map((l) => stripComment(l)).filter(Boolean);
}

function num(v, def) {
  const n = Number(v);
  return v === undefined || v === null || v === '' || isNaN(n) ? def : n;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = { MarlinPrinter, DEFAULT_CANCEL_SCRIPT, BAUDRATES, estimateRemaining, firmwareVersion };
