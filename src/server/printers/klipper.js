'use strict';

// Stampanti con Klipper, tramite Moonraker (la stessa API di Mainsail e Fluidd):
// stato in tempo reale via WebSocket JSON-RPC, comandi G-code, invio dei file,
// telecamere e aggiornamento del software (update manager).

const WebSocket = require('ws');
const { NetworkPrinter, remoteFileName } = require('./network');
const { HttpClient, networkError } = require('./http');
const { blendRemaining } = require('./base');

const DEFAULT_PORT = 7125;
const OBJECTS = {
  webhooks: ['state', 'state_message'],
  print_stats: ['state', 'filename', 'print_duration', 'total_duration', 'message', 'info'],
  virtual_sdcard: ['progress', 'is_active'],
  display_status: ['progress', 'message'],
  extruder: ['temperature', 'target'],
  extruder1: ['temperature', 'target'],
  heater_bed: ['temperature', 'target'],
  fan: ['speed'],
  gcode_move: ['speed_factor', 'extrude_factor'],
  toolhead: ['position', 'homed_axes'],
};

class KlipperPrinter extends NetworkPrinter {
  constructor(config, deps) {
    super(config, deps);
    this.ws = null;
    this.status = {};
    this._rpcId = 0;
    this._pending = new Map();
    this._meta = { file: null, data: null };
    this._pingTimer = null;
  }

  get capabilities() {
    return {
      link: 'klipper',
      temps: true, jog: true, home: true, extrude: true, motorsOff: true,
      fan: true, feedRate: true, flowRate: true, emergency: true,
      terminal: 'full', scripts: false, preview: true,
      webcam: this.extra.webcam ? 'builtin' : null,
      firmware: 'klipper',
      files: ['.gcode'],
    };
  }

  _http() {
    const port = this.net.port || DEFAULT_PORT;
    return new HttpClient({
      base: `http://${this.net.host}:${port}`,
      headers: this.net.apiKey ? { 'X-Api-Key': this.net.apiKey } : {},
    });
  }

  async _get(path, timeout) {
    const res = await this._http().request('GET', path, { timeout });
    return this._result(res);
  }

  async _post(path, body, timeout) {
    const res = await this._http().json('POST', path, body || {}, { timeout });
    return this._result(res);
  }

  _result(res) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Moonraker chiede una chiave API: copiala da Mainsail o Fluidd (Impostazioni > Chiave API) nelle impostazioni della stampante.');
    }
    if (res.status >= 400) {
      const msg = res.data && res.data.error ? (res.data.error.message || res.data.error) : `errore ${res.status}`;
      const e = new Error(String(msg));
      e.status = res.status;
      throw e;
    }
    return res.data ? res.data.result : null;
  }

  _friendlyError(err) {
    if (err && err.code) return networkError(err, this.address);
    return err && err.message ? err.message : String(err);
  }

  // ---------------------------------------------------------------------------
  // Connessione

  async _open(session) {
    const info = await this._get('/server/info', 6000);
    if (!info) throw new Error('A questo indirizzo non risponde Moonraker.');
    let token = null;
    if (this.net.apiKey) {
      const t = await this._get('/access/oneshot_token').catch(() => null);
      token = t || null;
    }
    const port = this.net.port || DEFAULT_PORT;
    const url = `ws://${this.net.host}:${port}/websocket${token ? '?token=' + encodeURIComponent(token) : ''}`;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: 8000 });
      this.ws = ws;
      let opened = false;
      ws.on('open', () => { opened = true; resolve(); });
      ws.on('error', (err) => { if (!opened) reject(err); });
      ws.on('close', () => {
        if (!opened) return reject(new Error('Moonraker ha chiuso la connessione.'));
        this._rejectPending('Connessione chiusa.');
        if (session === this._session && this.ws === ws) this._connectionLost('Connessione con Moonraker persa.');
      });
      ws.on('message', (data) => { if (session === this._session) this._onMessage(data); });
    });
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => { if (this.ws && this.ws.readyState === 1) this.ws.ping(); }, 20000);
    await this._rpc('server.connection.identify', {
      client_name: 'SonoPrint', version: require('../../../package.json').version, type: 'other', url: 'https://github.com/Bubo780/sonoprint',
    }).catch(() => {});
    this._loadWebcam();
    await this._subscribe(info.klippy_state);
  }

  async _subscribe(klippyState) {
    if (klippyState && klippyState !== 'ready') {
      this._klippyNotReady(klippyState);
      return;
    }
    const printerInfo = await this._rpc('printer.info').catch(() => null);
    if (printerInfo && printerInfo.state && printerInfo.state !== 'ready') {
      this._klippyNotReady(printerInfo.state, printerInfo.state_message);
      return;
    }
    if (printerInfo) {
      this.firmware = { name: 'Klipper', version: printerInfo.software_version || null, host: printerInfo.hostname || null };
    }
    const res = await this._rpc('printer.objects.subscribe', { objects: OBJECTS });
    this.status = {};
    this._merge(res && res.status);
    this.error = null;
    this._sync();
  }

  _klippyNotReady(state, message) {
    const labels = { startup: 'Klipper si sta avviando...', shutdown: 'Klipper è in arresto (shutdown).', error: 'Klipper segnala un errore.', disconnected: 'Klipper non è collegato a Moonraker.' };
    this.error = [labels[state] || `Klipper non è pronto (${state}).`, message].filter(Boolean).join(' ');
    this.job = null;
    this._setState('error');
    this._changed(true);
  }

  async _close() {
    clearInterval(this._pingTimer);
    const ws = this.ws;
    this.ws = null;
    this._rejectPending('Disconnessa.');
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC

  _rpc(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('La stampante non è connessa.'));
      const id = ++this._rpcId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('La stampante non ha risposto in tempo.'));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id }));
    });
  }

  _rejectPending(msg) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
      this._pending.delete(id);
    }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (_) { return; }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'Errore della stampante.'));
      else p.resolve(msg.result);
      return;
    }
    const params = msg.params || [];
    switch (msg.method) {
      case 'notify_status_update':
        this._merge(params[0]);
        this._sync();
        break;
      case 'notify_gcode_response':
        for (const line of String(params[0] || '').split('\n')) {
          if (!line) continue;
          const error = /^!!/.test(line);
          this._log(error ? 'error' : 'recv', line.replace(/^\/\/\s?/, ''), /^B:|^T\d?:/.test(line));
        }
        break;
      case 'notify_klippy_ready':
        this._subscribe('ready').catch((err) => this._log('error', err.message));
        break;
      case 'notify_klippy_shutdown':
        this._klippyNotReady('shutdown');
        break;
      case 'notify_klippy_disconnected':
        this._klippyNotReady('disconnected');
        break;
      case 'notify_update_response':
        this._onUpdateResponse(params[0] || {});
        break;
      default:
        break;
    }
  }

  _merge(changes) {
    for (const [obj, fields] of Object.entries(changes || {})) {
      this.status[obj] = { ...(this.status[obj] || {}), ...fields };
    }
  }

  // ---------------------------------------------------------------------------
  // Stato

  _sync() {
    const s = this.status;
    const temps = { tools: {} };
    if (s.extruder) temps.tools.T0 = { actual: round1(s.extruder.temperature), target: s.extruder.target ?? null };
    if (s.extruder1 && s.extruder1.temperature !== undefined) temps.tools.T1 = { actual: round1(s.extruder1.temperature), target: s.extruder1.target ?? null };
    if (s.heater_bed) temps.bed = { actual: round1(s.heater_bed.temperature), target: s.heater_bed.target ?? null };
    this._applyTemps(temps);

    if (s.fan && s.fan.speed !== undefined) this.fanSpeed = Math.round(s.fan.speed * 100);
    if (s.gcode_move) {
      if (s.gcode_move.speed_factor !== undefined) this.feedRate = Math.round(s.gcode_move.speed_factor * 100);
      if (s.gcode_move.extrude_factor !== undefined) this.flowRate = Math.round(s.gcode_move.extrude_factor * 100);
    }
    if (s.toolhead && Array.isArray(s.toolhead.position)) {
      const [x, y, z] = s.toolhead.position;
      this.position = { x, y, z };
    }

    const ps = s.print_stats || {};
    const map = { printing: 'printing', paused: 'paused' };
    const state = map[ps.state] || 'operational';

    if (state === 'operational') {
      if (this.job && !this._awaitingStart) {
        const result = ps.state === 'complete' ? 'done' : ps.state === 'cancelled' ? 'cancelled' : ps.state === 'error' ? 'failed' : 'cancelled';
        this._remoteJobEnded(result, ps.state === 'error' ? ps.message || null : null);
      }
      this._applyRemote('operational', null);
      return;
    }
    const file = ps.filename || '';
    if (file && this._meta.file !== file) this._loadMetadata(file);
    const meta = this._meta.file === file ? this._meta.data || {} : {};
    const progress = s.virtual_sdcard && s.virtual_sdcard.progress !== undefined ? s.virtual_sdcard.progress : (s.display_status && s.display_status.progress) || 0;
    const elapsed = Math.round(ps.print_duration || 0);
    const info = ps.info || {};
    this._applyRemote(state, {
      file: file.split('/').pop() || 'Stampa',
      progress,
      elapsed: Math.round(ps.total_duration || elapsed),
      remaining: blendRemaining(meta.estimated_time || null, elapsed, progress),
      layer: info.current_layer || null,
      layerCount: info.total_layer || meta.layer_count || null,
      estimatedTime: meta.estimated_time || null,
      startedAt: Date.now() - Math.round(ps.total_duration || 0) * 1000,
      thumbnail: meta.thumbnail || null,
    });
  }

  async _loadMetadata(file) {
    this._meta = { file, data: null };
    try {
      const m = await this._get('/server/files/metadata?filename=' + encodeURIComponent(file));
      if (!m || this._meta.file !== file) return;
      const thumbs = (m.thumbnails || []).slice().sort((a, b) => b.width - a.width);
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const port = this.net.port || DEFAULT_PORT;
      this._meta.data = {
        estimated_time: m.estimated_time || null,
        layer_count: m.layer_count || null,
        thumbnail: thumbs[0] ? `http://${this.net.host}:${port}/server/files/gcodes/${encodeURI(dir + thumbs[0].relative_path)}` : null,
      };
      this._sync();
    } catch (_) { /* metadati non disponibili */ }
  }

  async _loadWebcam() {
    try {
      const res = await this._rpc('server.webcams.list');
      const cams = (res && res.webcams) || [];
      const cam = cams.find((c) => c.enabled !== false && (c.stream_url || c.snapshot_url));
      if (!cam) return;
      const port = this.net.port || DEFAULT_PORT;
      const abs = (u) => (!u ? null : /^https?:\/\//i.test(u) ? u : `http://${this.net.host}${u.startsWith('/') ? '' : '/'}${u}`);
      this.extra.webcam = {
        name: cam.name || 'Webcam',
        stream: abs(cam.stream_url),
        snapshot: abs(cam.snapshot_url),
        flipH: !!cam.flip_horizontal,
        flipV: !!cam.flip_vertical,
        rotate: Number(cam.rotation) || 0,
        port,
      };
      this._changed();
    } catch (_) { /* nessuna telecamera configurata */ }
  }

  // ---------------------------------------------------------------------------
  // Comandi

  async _script(lines, quiet) {
    this._requireConnected();
    const list = lines.map((l) => String(l).trim()).filter(Boolean);
    for (const l of list) this._log('send', l, quiet);
    try {
      await this._rpc('printer.gcode.script', { script: list.join('\n') }, 10 * 60 * 1000);
    } catch (err) {
      this._log('error', err.message);
      throw err;
    }
  }

  sendCommands(commands) {
    const list = Array.isArray(commands) ? commands : String(commands).split('\n');
    this._script(list).catch(() => {});
  }

  setTemperature(heater, target) {
    const t = Math.max(0, Math.round(Number(target) || 0));
    if (heater === 'bed') return this._script([`M140 S${t}`]);
    const m = /^T(\d+)$/.exec(heater);
    if (!m) throw this._unsupported('Temperatura della camera');
    return this._script([`M104 T${m[1]} S${t}`]);
  }

  jog(axes, speed) {
    this._requireIdle();
    const parts = [];
    for (const a of ['x', 'y', 'z']) {
      const v = Number(axes[a]);
      if (v) parts.push(a.toUpperCase() + Math.round(v * 1000) / 1000);
    }
    if (!parts.length) return null;
    const onlyZ = parts.length === 1 && parts[0][0] === 'Z';
    const jogCfg = this.config.jog || {};
    const f = speed || (onlyZ ? (jogCfg.zSpeed || 600) : (jogCfg.xySpeed || 6000));
    return this._script(['G91', `G1 ${parts.join(' ')} F${f}`, 'G90']);
  }

  home(axes) {
    this._requireIdle();
    const list = (axes || []).map((a) => String(a).toUpperCase()).filter((a) => /^[XYZ]$/.test(a));
    return this._script([list.length ? `G28 ${list.join(' ')}` : 'G28']);
  }

  extrude(amount, speed) {
    this._requireIdle();
    return this._script(['M83', `G1 E${Math.round(Number(amount) * 1000) / 1000} F${speed || this.config.extrudeSpeed || 300}`]);
  }

  setFan(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    return this._script([p > 0 ? `M106 S${Math.round(p * 2.55)}` : 'M107']);
  }

  motorsOff() {
    this._requireIdle();
    return this._script(['M84']);
  }

  setFeedRate(p) { return this._script([`M220 S${Math.round(Number(p))}`]); }
  setFlowRate(p) { return this._script([`M221 S${Math.round(Number(p))}`]); }

  async emergencyStop() {
    this._requireConnected();
    this._log('send', 'M112');
    await this._rpc('printer.emergency_stop');
  }

  async pause() {
    if (this.state !== 'printing') throw new Error('Nessuna stampa in corso da mettere in pausa.');
    this._setState('pausing');
    await this._rpc('printer.print.pause', {}, 120000);
  }

  async resume() {
    if (this.state !== 'paused') throw new Error('La stampa non è in pausa.');
    await this._rpc('printer.print.resume', {}, 120000);
  }

  async cancel() {
    if (!this.job) throw new Error('Nessuna stampa da annullare.');
    this._setState('cancelling');
    await this._rpc('printer.print.cancel', {}, 120000);
  }

  // ---------------------------------------------------------------------------
  // Invio e avvio dei file

  async _uploadForPrint(file, onProgress) {
    const name = remoteFileName(file.name);
    const res = await this._http().upload({
      method: 'POST',
      path: '/server/files/upload',
      filePath: file.path,
      fileName: name,
      multipart: { fileField: 'file', fields: { root: 'gcodes' } },
      onProgress,
      timeout: 10 * 60 * 1000,
    });
    this._result(res);
    return name;
  }

  async _startRemotePrint(remoteName) {
    await this._rpc('printer.print.start', { filename: remoteName }, 60000);
  }

  // ---------------------------------------------------------------------------
  // Aggiornamento del software (update manager di Moonraker)

  async firmwareInfo(refresh) {
    this._requireConnected();
    let status;
    if (refresh) {
      status = await this._post('/machine/update/refresh', {}, 120000).catch(() => null);
    }
    if (!status) status = await this._get('/machine/update/status' + (refresh ? '?refresh=true' : ''), 120000);
    const components = [];
    for (const [name, v] of Object.entries((status && status.version_info) || {})) {
      if (name === 'system') {
        components.push({ name, label: 'Sistema operativo', version: null, remote: null, updates: v.package_count || 0, available: (v.package_count || 0) > 0 });
        continue;
      }
      const current = v.version || v.full_version_string || null;
      const remote = v.remote_version || null;
      const behind = Array.isArray(v.commits_behind) ? v.commits_behind.length : null;
      const available = v.is_valid !== false && (behind !== null
        ? behind > 0
        : !!(remote && current && remote !== '?' && normalizeVersion(remote) !== normalizeVersion(current)));
      components.push({ name, label: componentLabel(name), version: current, remote, available, behind, dirty: !!v.is_dirty, valid: v.is_valid !== false });
    }
    return {
      kind: 'klipper',
      current: this.firmware,
      busy: !!(status && status.busy),
      components,
      canInstall: this.isConnected && !this.isPrinting,
    };
  }

  async installFirmware(name) {
    this._requireConnected();
    if (this.isPrinting) throw new Error('Aspetta la fine della stampa.');
    this._requireNoTask();
    const target = String(name || 'full');
    this._setTask({ kind: 'firmware', status: 'running', progress: null, message: target === 'full' ? 'Aggiornamento di tutti i componenti...' : `Aggiornamento di ${componentLabel(target)}...`, lines: [] });
    try {
      try {
        await this._post('/machine/update/upgrade', target === 'full' ? {} : { name: target }, 60 * 60 * 1000);
      } catch (err) {
        if (err.status !== 404) throw err;
        // Moonraker meno recenti
        const legacy = target === 'full' ? '/machine/update/full'
          : target === 'system' ? '/machine/update/system'
            : target === 'klipper' ? '/machine/update/klipper'
              : target === 'moonraker' ? '/machine/update/moonraker'
                : '/machine/update/client?name=' + encodeURIComponent(target);
        await this._post(legacy, {}, 60 * 60 * 1000);
      }
      this._setTask({ status: 'done', message: 'Aggiornamento completato.' });
    } catch (err) {
      this._setTask({ status: 'error', message: `Aggiornamento non riuscito: ${this._friendlyError(err)}` });
      throw err;
    }
  }

  _onUpdateResponse(r) {
    if (!this.task || this.task.kind !== 'firmware') return;
    const lines = (this.task.lines || []).concat(String(r.message || '').split('\n').filter(Boolean)).slice(-200);
    this._setTask({ lines, message: r.complete ? 'Aggiornamento completato.' : (lines[lines.length - 1] || this.task.message) });
  }
}

function componentLabel(name) {
  const labels = { klipper: 'Klipper', moonraker: 'Moonraker', mainsail: 'Mainsail', fluidd: 'Fluidd', system: 'Sistema operativo', crowsnest: 'Crowsnest', KlipperScreen: 'KlipperScreen' };
  return labels[name] || name;
}

function normalizeVersion(v) {
  return String(v).replace(/^v/i, '').replace(/-\d+-g[0-9a-f]+.*$/i, '').trim();
}

function round1(v) {
  return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}

module.exports = { KlipperPrinter, DEFAULT_PORT };
