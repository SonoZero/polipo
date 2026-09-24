'use strict';

// Stampante virtuale che simula il firmware Marlin: serve per provare l'app
// senza una stampante collegata (come il "Virtual Printer" di OctoPrint).

const { EventEmitter } = require('events');
const { checksum, stripComment, commandCode, param } = require('./gcode');

const AMBIENT = 22;
const PLANNER_SIZE = 16;

class VirtualPrinter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.speed=1]  fattore di velocità della simulazione (movimenti e riscaldamento)
   * @param {number} [opts.errorRate=0] probabilità di simulare un errore di checksum (test dei resend)
   * @param {number} [opts.extruders=1]
   * @param {boolean} [opts.autoreport=true] dichiara la capability AUTOREPORT_TEMP
   */
  constructor(opts = {}) {
    super();
    this.speed = opts.speed || 1;
    this.errorRate = opts.errorRate || 0;
    this.extruderCount = opts.extruders || 1;
    this.autoreportCap = opts.autoreport !== false;
    this.startupDelay = opts.startupDelay ?? 400;
    this.name = opts.name || 'Stampante virtuale';
    this.record = opts.record ? [] : null; // per i test: comandi eseguiti in ordine

    this.lastN = 0;
    this.hotends = Array.from({ length: this.extruderCount }, () => ({ actual: AMBIENT, target: 0 }));
    this.bed = { actual: AMBIENT, target: 0 };
    this.pos = { x: 0, y: 0, z: 0, e: 0 };
    this.relative = false;
    this.relativeE = false;
    this.feedrate = 3000;
    this.fan = 0;
    this.activeTool = 0;
    this.homed = false;

    this.moveEnds = []; // istanti di fine dei movimenti nel planner
    this.queue = []; // righe ricevute in attesa di elaborazione
    this.processing = false;
    this.killed = false;
    this.open = false;
    this.timers = new Set();
    this.autoreportInterval = 0;
  }

  // --- interfaccia di trasporto -------------------------------------------------

  start() {
    this.open = true;
    this._every(250, () => this._tickTemps());
    this._later(this.startupDelay, () => {
      this._send('start');
      this._send(`echo: Marlin 2.1.2 (${this.name})`);
      this._send('echo: Last Updated: 2026-01-01 | Author: SonoPrint');
      this._send('echo:SD card ok');
    });
  }

  stop() {
    this.open = false;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers.clear();
  }

  write(data) {
    if (!this.open) return;
    for (const raw of String(data).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // M112 viene gestito subito, come l'emergency parser di Marlin
      if (/(^|\s)M112\b/.test(line)) {
        this.killed = true;
        this.queue = [];
        this._send('Error:Printer halted. kill() called!');
        continue;
      }
      this.queue.push(line);
    }
    this._pump();
  }

  // --- elaborazione -------------------------------------------------------------

  _pump() {
    if (this.processing || !this.queue.length || !this.open) return;
    this.processing = true;
    const line = this.queue.shift();
    Promise.resolve(this._handleLine(line))
      .catch((err) => this._send('Error:' + err.message))
      .finally(() => {
        this.processing = false;
        if (this.queue.length) setImmediate(() => this._pump());
      });
  }

  async _handleLine(line) {
    if (this.killed) return; // dopo un kill il firmware non risponde più
    let cmd = line;

    const nm = /^N(\d+)\s+(.*)$/.exec(line);
    if (nm) {
      const n = parseInt(nm[1], 10);
      let body = nm[2];
      const star = body.lastIndexOf('*');
      if (star < 0) return this._resend('No Checksum with line number, Last Line: ' + this.lastN);
      const cs = parseInt(body.slice(star + 1), 10);
      body = body.slice(0, star).trim();
      const isM110 = /^M110\b/i.test(body);
      if (!isM110 && n !== this.lastN + 1) {
        return this._resend('Line Number is not Last Line Number+1, Last Line: ' + this.lastN);
      }
      if (checksum(`N${n} ${body}`) !== cs || (!isM110 && Math.random() < this.errorRate)) {
        return this._resend('checksum mismatch, Last Line: ' + this.lastN);
      }
      this.lastN = n;
      cmd = body;
    }

    cmd = stripComment(cmd);
    if (!cmd) return this._send('ok');
    if (this.record) this.record.push(cmd);
    await this._execute(cmd);
  }

  _resend(message) {
    this._send('Error:' + message);
    this._send('Resend: ' + (this.lastN + 1));
    this._send('ok');
  }

  async _execute(cmd) {
    const code = commandCode(cmd);
    switch (code) {
      case 'G0':
      case 'G1':
        return this._move(cmd);
      case 'G4': {
        const ms = (param(cmd, 'P') ?? 0) + (param(cmd, 'S') ?? 0) * 1000;
        await this._waitMoves();
        await this._sleep(ms / this.speed);
        return this._send('ok');
      }
      case 'G28': {
        await this._waitMoves();
        await this._busy(1500 / Math.sqrt(this.speed));
        const all = !/[XYZ]/i.test(cmd.slice(3));
        if (all || /X/i.test(cmd.slice(3))) this.pos.x = 0;
        if (all || /Y/i.test(cmd.slice(3))) this.pos.y = 0;
        if (all || /Z/i.test(cmd.slice(3))) this.pos.z = 0;
        this.homed = true;
        this._send(`X:${this.pos.x.toFixed(2)} Y:${this.pos.y.toFixed(2)} Z:${this.pos.z.toFixed(2)} E:${this.pos.e.toFixed(2)} Count X:0 Y:0 Z:0`);
        return this._send('ok');
      }
      case 'G29':
        await this._waitMoves();
        await this._busy(4000 / Math.sqrt(this.speed));
        this._send('Bilinear Leveling Grid:');
        this._send('      0      1      2');
        this._send(' 0 +0.020 -0.010 +0.035');
        this._send(' 1 -0.005 +0.000 +0.012');
        this._send(' 2 +0.041 +0.018 -0.022');
        return this._send('ok');
      case 'G90': this.relative = false; this.relativeE = false; return this._send('ok');
      case 'G91': this.relative = true; this.relativeE = true; return this._send('ok');
      case 'M82': this.relativeE = false; return this._send('ok');
      case 'M83': this.relativeE = true; return this._send('ok');
      case 'G92': {
        for (const a of ['x', 'y', 'z', 'e']) {
          const v = param(cmd, a.toUpperCase());
          if (v !== null) this.pos[a] = v;
        }
        return this._send('ok');
      }
      case 'M104':
      case 'M109': {
        const t = param(cmd, 'T');
        const idx = t !== null ? t : this.activeTool;
        const target = param(cmd, 'S') ?? param(cmd, 'R') ?? 0;
        if (this.hotends[idx]) this.hotends[idx].target = target;
        if (code === 'M109' && target > 0) {
          await this._waitMoves();
          await this._waitTemp(() => this.hotends[idx], 'T');
        }
        return this._send('ok');
      }
      case 'M140':
      case 'M190': {
        const target = param(cmd, 'S') ?? param(cmd, 'R') ?? 0;
        this.bed.target = target;
        if (code === 'M190' && target > 0) {
          await this._waitMoves();
          await this._waitTemp(() => this.bed, 'B');
        }
        return this._send('ok');
      }
      case 'M105':
        return this._send('ok ' + this._tempString());
      case 'M155': {
        const s = param(cmd, 'S') ?? 0;
        this.autoreportInterval = s;
        if (this._autoTimer) { clearInterval(this._autoTimer); this.timers.delete(this._autoTimer); this._autoTimer = null; }
        if (s > 0) this._autoTimer = this._every(s * 1000, () => this._send(' ' + this._tempString()));
        return this._send('ok');
      }
      case 'M106': this.fan = param(cmd, 'S') ?? 255; return this._send('ok');
      case 'M107': this.fan = 0; return this._send('ok');
      case 'M110': {
        const n = param(cmd, 'N');
        this.lastN = n !== null ? n : 0;
        return this._send('ok');
      }
      case 'M114':
        await this._waitMoves();
        this._send(`X:${this.pos.x.toFixed(2)} Y:${this.pos.y.toFixed(2)} Z:${this.pos.z.toFixed(2)} E:${this.pos.e.toFixed(2)} Count X:0 Y:0 Z:0`);
        return this._send('ok');
      case 'M115':
        this._send(`FIRMWARE_NAME:Marlin 2.1.2 (SonoPrint virtual) SOURCE_CODE_URL:github.com/MarlinFirmware/Marlin PROTOCOL_VERSION:1.0 MACHINE_TYPE:${this.name} EXTRUDER_COUNT:${this.extruderCount} UUID:00000000-0000-0000-0000-000000000000`);
        this._send(`Cap:AUTOREPORT_TEMP:${this.autoreportCap ? 1 : 0}`);
        this._send('Cap:AUTOREPORT_POS:0');
        this._send('Cap:EMERGENCY_PARSER:1');
        this._send('Cap:HOST_ACTION_COMMANDS:1');
        this._send('Cap:EEPROM:1');
        return this._send('ok');
      case 'M400':
        await this._waitMoves();
        return this._send('ok');
      case 'M503':
        this._send('echo:; Steps per unit:');
        this._send('echo: M92 X80.00 Y80.00 Z400.00 E93.00');
        this._send('echo:; Maximum feedrates (units/s):');
        this._send('echo: M203 X500.00 Y500.00 Z5.00 E25.00');
        return this._send('ok');
      case 'M18':
      case 'M84':
      case 'M117':
      case 'M73':
      case 'M220':
      case 'M221':
      case 'M201':
      case 'M203':
      case 'M204':
      case 'M205':
      case 'M500':
      case 'M501':
      case 'M502':
      case 'M900':
      case 'M907':
      case 'M75':
      case 'M76':
      case 'M77':
      case 'M300':
        return this._send('ok');
      case 'M0':
      case 'M1':
        this._send('echo:busy: paused for user');
        return this._send('ok');
      default:
        if (/^T\d+$/.test(code || '')) {
          const idx = parseInt(code.slice(1), 10);
          if (idx < this.extruderCount) this.activeTool = idx;
          else this._send('echo:T' + idx + ' Invalid extruder');
          return this._send('ok');
        }
        this._send(`echo:Unknown command: "${cmd}"`);
        return this._send('ok');
    }
  }

  async _move(cmd) {
    const f = param(cmd, 'F');
    if (f) this.feedrate = f;
    const target = { ...this.pos };
    for (const a of ['x', 'y', 'z']) {
      const v = param(cmd, a.toUpperCase());
      if (v !== null) target[a] = this.relative ? this.pos[a] + v : v;
    }
    const ve = param(cmd, 'E');
    if (ve !== null) target.e = this.relativeE ? this.pos.e + ve : ve;
    const dist = Math.hypot(target.x - this.pos.x, target.y - this.pos.y, target.z - this.pos.z) || Math.abs(target.e - this.pos.e);
    this.pos = target;
    const durMs = (dist / Math.max(this.feedrate, 1)) * 60000 / this.speed;

    // simula il planner di Marlin: "ok" immediato finché c'è spazio nel buffer
    const now = Date.now();
    this.moveEnds = this.moveEnds.filter((t) => t > now);
    const start = this.moveEnds.length ? this.moveEnds[this.moveEnds.length - 1] : now;
    this.moveEnds.push(start + durMs);
    if (this.moveEnds.length >= PLANNER_SIZE) {
      const waitUntil = this.moveEnds[this.moveEnds.length - PLANNER_SIZE];
      await this._sleep(Math.max(0, waitUntil - Date.now()));
    }
    this._send('ok');
  }

  async _waitMoves() {
    const last = this.moveEnds.length ? this.moveEnds[this.moveEnds.length - 1] : 0;
    const wait = last - Date.now();
    if (wait > 0) await this._busy(wait);
    this.moveEnds = [];
  }

  async _busy(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && this.open && !this.killed) {
      await this._sleep(Math.min(2000, end - Date.now()));
      if (Date.now() < end) this._send('echo:busy: processing');
    }
  }

  async _waitTemp(getHeater, label) {
    let last = 0;
    while (this.open && !this.killed) {
      const h = getHeater();
      if (!h || h.target <= 0 || Math.abs(h.actual - h.target) < 1) break;
      if (Date.now() - last >= 1000) {
        last = Date.now();
        this._send(this._tempString() + ' W:?');
      }
      await this._sleep(100);
    }
    void label;
  }

  _tickTemps() {
    const dt = 0.25 * this.speed;
    const step = (h, tau) => {
      const goal = h.target > 0 ? h.target : AMBIENT;
      const k = 1 - Math.exp(-dt / tau);
      h.actual += (goal - h.actual) * k;
      if (h.target > 0 && Math.abs(goal - h.actual) < 2) h.actual += (Math.random() - 0.5) * 0.3;
    };
    for (const h of this.hotends) step(h, 12);
    step(this.bed, 30);
  }

  _tempString() {
    const t = this.hotends[this.activeTool] || this.hotends[0];
    let s = `T:${t.actual.toFixed(2)} /${t.target.toFixed(2)} B:${this.bed.actual.toFixed(2)} /${this.bed.target.toFixed(2)}`;
    if (this.extruderCount > 1) {
      this.hotends.forEach((h, i) => { s += ` T${i}:${h.actual.toFixed(2)} /${h.target.toFixed(2)}`; });
    }
    const power = (h) => Math.max(0, Math.min(127, Math.round((h.target - h.actual) * 6)));
    s += ` @:${power(t)} B@:${power(this.bed)}`;
    return s;
  }

  // --- helper ---------------------------------------------------------------------

  _send(line) {
    if (!this.open) return;
    // risposta asincrona (come una vera seriale), mantenendo l'ordine delle righe
    if (!this.outbox) this.outbox = [];
    this.outbox.push(line);
    if (this.outbox.length === 1) {
      setImmediate(() => {
        const lines = this.outbox;
        this.outbox = [];
        for (const l of lines) if (this.open) this.emit('line', l);
      });
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.timers.delete(t); resolve(); }, Math.max(0, ms));
      this.timers.add(t);
    });
  }

  _later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  _every(ms, fn) {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }
}

module.exports = { VirtualPrinter };
