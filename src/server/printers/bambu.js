'use strict';

// Stampanti Bambu Lab in rete locale: stato e comandi via MQTT (porta 8883),
// file sulla scheda SD via FTPS (porta 990), telecamera delle serie P1 e A1 (porta 6000).
// Per il controllo da programmi esterni la stampante deve avere attive la
// "Modalità solo LAN" e la "Modalità sviluppatore".

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { NetworkPrinter, fileKind, remoteFileName } = require('./network');

const BAMBU_CA = fs.readFileSync(path.join(__dirname, 'certs', 'bambu-ca.pem'), 'utf8');
const CANCELLED_BY_USER = 50348044; // HMS 0300-400C: stampa annullata
const REFUSED = 84033543; // comando rifiutato: manca l'autorizzazione (Modalità sviluppatore spenta)

const MODEL_CODES = {
  'BL-P001': 'X1 Carbon',
  '3DPrinter-X1-Carbon': 'X1 Carbon',
  'BL-P002': 'X1',
  '3DPrinter-X1': 'X1',
  C13: 'X1E',
  C11: 'P1P',
  C12: 'P1S',
  N1: 'A1 mini',
  N2S: 'A1',
  O1D: 'H2D',
};

const STAGES = {
  1: 'Livellamento del piatto',
  2: 'Riscaldamento del piatto',
  3: 'Compensazione delle vibrazioni',
  4: 'Cambio del filamento',
  5: 'Pausa (M400)',
  6: 'Filamento esaurito',
  7: 'Riscaldamento dell\'ugello',
  8: 'Calibrazione dell\'estrusione',
  9: 'Scansione del piatto',
  10: 'Controllo del primo layer',
  11: 'Riconoscimento del piatto',
  12: 'Calibrazione del lidar',
  13: 'Home degli assi',
  14: 'Pulizia dell\'ugello',
  15: 'Controllo della temperatura dell\'estrusore',
  16: 'In pausa',
  17: 'Pausa: coperchio frontale caduto',
  18: 'Calibrazione del lidar',
  19: 'Calibrazione del flusso',
  20: 'Pausa: problema alla temperatura dell\'ugello',
  21: 'Pausa: problema alla temperatura del piatto',
  22: 'Scarico del filamento',
  23: 'Pausa: passi persi',
  24: 'Caricamento del filamento',
  25: 'Calibrazione del rumore dei motori',
  26: 'Pausa: AMS non raggiungibile',
  27: 'Pausa: ventola dell\'hotend troppo lenta',
  28: 'Pausa: errore della temperatura della camera',
  29: 'Raffreddamento della camera',
  30: 'Pausa dal G-code',
  32: 'Pausa: ugello coperto di filamento',
  33: 'Pausa: errore della taglierina',
  34: 'Pausa: errore del primo layer',
  35: 'Pausa: ugello ostruito',
};

function modelName(code) {
  if (!code) return null;
  return MODEL_CODES[code] ? 'Bambu Lab ' + MODEL_CODES[code] : null;
}

class BambuPrinter extends NetworkPrinter {
  constructor(config, deps) {
    super(config, deps);
    this.client = null;
    this.remote = {};
    this._seq = 0;
    this._cancelRequestedAt = 0;
    this._camera = null;
    this.startTimeout = 120000;
    // porte fisse delle stampanti Bambu (modificabili solo dai test)
    this.ports = { ftp: 990, camera: 6000, ...((deps && deps.bambuPorts) || {}) };
  }

  get serial() { return String(this.net.serial || '').trim().toUpperCase(); }
  get model() { return this.config.model || this.extra.model || ''; }

  /** Serie X1, P1 e A1 avviano i file con "file:///sdcard/", le più recenti con "ftp:///". */
  get _legacySd() { return !/\b(H2|P2|X2|A2)/i.test(this.model); }
  get _jpegCamera() { return /\b(P1|A1)/i.test(this.model); }
  get _hasChamberSensor() { return /\b(X1|H2|X2|P2)/i.test(this.model); }

  get capabilities() {
    return {
      link: 'bambu',
      temps: true, jog: true, home: true, extrude: true, motorsOff: true,
      fan: true, feedRate: false, flowRate: false, speedLevel: true, light: true,
      emergency: false, terminal: 'send', scripts: false, preview: true,
      webcam: this._jpegCamera ? 'builtin' : null,
      firmware: 'bambu',
      files: ['.3mf', '.gcode'],
    };
  }

  // ---------------------------------------------------------------------------
  // Connessione MQTT

  _tlsOptions() {
    return {
      ca: BAMBU_CA,
      servername: this.serial || undefined,
      rejectUnauthorized: false, // la verifica la fa _checkPeer (CA di Bambu Lab o certificato memorizzato)
      checkServerIdentity: () => undefined,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };
  }

  /**
   * Verifica il certificato della stampante: firmato dalle CA di Bambu Lab e intestato
   * al numero di serie; se non è firmato, vale il primo visto (come fa SSH).
   */
  _checkPeer(socket) {
    if (!socket || typeof socket.getPeerCertificate !== 'function') return;
    const cert = socket.getPeerCertificate();
    if (!cert || !cert.fingerprint256) return;
    const cn = cert.subject && cert.subject.CN ? String(cert.subject.CN).toUpperCase() : null;
    if (socket.authorized) {
      if (cn && /^[0-9A-Z]{10,20}$/.test(cn)) {
        if (!this.serial) {
          this._patchNet({ serial: cn });
        } else if (cn !== this.serial) {
          throw new Error(`Il numero di serie inserito (${this.serial}) non corrisponde a quello della stampante a questo indirizzo (${cn}).`);
        }
      }
      return;
    }
    const pinned = this.net.tlsFingerprint;
    if (!pinned) {
      this._patchNet(!this.serial && cn && /^[0-9A-Z]{10,20}$/.test(cn)
        ? { tlsFingerprint: cert.fingerprint256, serial: cn }
        : { tlsFingerprint: cert.fingerprint256 });
      this._log('warn', 'Il certificato della stampante non è firmato da Bambu Lab: lo memorizzo e dalle prossime connessioni accetto solo questo.');
      return;
    }
    if (pinned !== cert.fingerprint256) {
      throw new Error('Il certificato della stampante è cambiato dall\'ultima connessione. Se hai sostituito la scheda o aggiornato il firmware, rimuovi e aggiungi di nuovo la stampante.');
    }
  }

  _patchNet(patch) {
    this.config.net = { ...this.config.net, ...patch };
    this.emit('config-patch', { net: this.config.net });
  }

  _open(session) {
    const code = String(this.net.accessCode || '').trim();
    if (!code) return Promise.reject(new Error('Inserisci il codice di accesso LAN (lo trovi sullo schermo della stampante, nelle impostazioni di rete).'));
    const mqtt = require('mqtt');
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const client = mqtt.connect({
        host: this.net.host,
        port: this.net.port || 8883,
        protocol: 'mqtts',
        username: 'bblp',
        password: code,
        clientId: 'sonoprint_' + crypto.randomBytes(4).toString('hex'),
        clean: true,
        keepalive: 30,
        connectTimeout: 10000,
        reconnectPeriod: 0,
        protocolVersion: 4,
        ...this._tlsOptions(),
      });
      this.client = client;
      client.on('error', (err) => {
        if (!settled) return fail(err);
        if (session === this._session) this._connectionLost(this._friendlyError(err));
      });
      client.on('close', () => {
        if (!settled) return fail(new Error('La stampante ha chiuso la connessione.'));
        if (session === this._session && this.client === client) this._connectionLost('Connessione con la stampante persa.');
      });
      client.on('message', (topic, payload) => {
        if (session === this._session) this._onMessage(payload);
      });
      client.once('connect', () => {
        try {
          this._checkPeer(client.stream);
        } catch (err) {
          client.end(true);
          return fail(err);
        }
        if (!this.serial) {
          client.end(true);
          return fail(new Error('Inserisci il numero di serie della stampante (Impostazioni > Dispositivo sullo schermo della stampante).'));
        }
        client.subscribe(`device/${this.serial}/report`, { qos: 0 }, (err) => {
          if (err) {
            client.end(true);
            return fail(err);
          }
          settled = true;
          resolve();
          this.remote = {};
          this._publish({ pushing: { sequence_id: this._nextSeq(), command: 'pushall', version: 1, push_target: 1 } });
          this._publish({ info: { sequence_id: this._nextSeq(), command: 'get_version' } });
          // se la stampante non manda subito lo stato completo, considerala libera
          clearTimeout(this._firstReport);
          this._firstReport = setTimeout(() => {
            if (session === this._session && this.state === 'connecting' && this.client === client) this._applyRemote('operational', null);
          }, 10000);
        });
      });
    });
  }

  async _close() {
    const client = this.client;
    this.client = null;
    clearTimeout(this._firstReport);
    this._stopCamera();
    if (client) {
      client.removeAllListeners();
      client.on('error', () => {});
      await new Promise((resolve) => client.end(true, {}, () => resolve()));
    }
  }

  _friendlyError(err) {
    const code = err && err.code;
    const msg = String(err && err.message || err);
    if (code === 4 || code === 5 || code === 134 || code === 135 || /not authori[sz]ed|bad user name or password/i.test(msg)) {
      return 'Codice di accesso sbagliato. Controllalo sullo schermo della stampante (Impostazioni > Rete o WLAN): cambia quando si riattiva la modalità LAN.';
    }
    if (code === 'ECONNREFUSED') {
      return `La stampante all'indirizzo ${this.address} rifiuta la connessione. Sulla stampante attiva "Modalità solo LAN" e "Modalità sviluppatore".`;
    }
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /timeout/i.test(msg)) {
      return `La stampante all'indirizzo ${this.address} non risponde. È accesa e collegata alla stessa rete del PC?`;
    }
    return msg;
  }

  _nextSeq() {
    this._seq = (this._seq + 1) % 100000;
    return String(this._seq);
  }

  _publish(obj) {
    if (!this.client || !this.client.connected) throw new Error('La stampante non è connessa.');
    this.client.publish(`device/${this.serial}/request`, JSON.stringify(obj), { qos: 1 });
  }

  // ---------------------------------------------------------------------------
  // Messaggi dalla stampante

  _onMessage(payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (_) { return; }
    if (msg.print) this._onPrint(msg.print);
    if (msg.info && msg.info.command === 'get_version') this._onVersion(msg.info);
    for (const k of ['system', 'upgrade']) {
      const r = msg[k];
      if (r && r.command && isFailure(r)) this._onRefused(r);
    }
  }

  _onPrint(p) {
    if (p.command && p.command !== 'push_status' && isFailure(p)) {
      this._onRefused(p);
      return;
    }
    if (p.command && p.command !== 'push_status') return;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'command' || k === 'sequence_id' || k === 'msg') continue;
      this.remote[k] = v;
    }
    this._sync();
  }

  _onRefused(r) {
    const code = Number(r.err_code || r.error_code || 0);
    const denied = code === REFUSED || /auth|permission|denied|sign/i.test(String(r.reason || ''));
    const msg = denied
      ? 'La stampante ha rifiutato il comando. Sullo schermo della stampante attiva "Modalità solo LAN" e poi "Modalità sviluppatore".'
      : `La stampante ha rifiutato il comando "${r.command}"${r.reason ? ': ' + r.reason : ''}${code ? ` (codice ${code})` : ''}.`;
    this._log('error', msg);
    this.emit('notify', { level: 'error', title: this.config.name, message: msg });
    if (this._awaitingStart && ['project_file', 'gcode_file'].includes(r.command)) {
      this._awaitingStart = null;
      clearTimeout(this._startGuard);
      this.job = null;
      this._setState('operational');
    }
  }

  _onVersion(info) {
    const modules = Array.isArray(info.module) ? info.module : [];
    const ota = modules.find((m) => m.name === 'ota');
    const withName = modules.find((m) => m.product_name);
    const product = withName ? String(withName.product_name).trim() : null;
    if (product) this.extra.model = product.startsWith('Bambu') ? product : 'Bambu Lab ' + product;
    else if (!this.extra.model) {
      const ap = modules.find((m) => /^AP0/.test(m.hw_ver || ''));
      const byCode = ap && modelName(ap.project_name);
      if (byCode) this.extra.model = byCode;
    }
    this.firmware = {
      name: this.extra.model || 'Bambu Lab',
      version: ota ? ota.sw_ver : null,
      modules: modules.filter((m) => m.sw_ver).map((m) => ({ name: m.name, version: m.sw_ver, hardware: m.hw_ver || null })),
    };
    this._changed();
  }

  _sync() {
    const r = this.remote;
    const temps = {
      tools: { T0: { actual: num(r.nozzle_temper), target: num(r.nozzle_target_temper) } },
      bed: { actual: num(r.bed_temper), target: num(r.bed_target_temper) },
    };
    if (this._hasChamberSensor && r.chamber_temper !== undefined) temps.chamber = { actual: num(r.chamber_temper), target: null };
    if (temps.tools.T0.actual !== null || temps.bed.actual !== null) this._applyTemps(temps);

    const fan = num(r.cooling_fan_speed);
    this.fanSpeed = fan === null ? null : Math.round((fan / 15) * 100);
    const light = Array.isArray(r.lights_report) ? r.lights_report.find((l) => l.node === 'chamber_light') : null;
    this.extra = {
      ...this.extra,
      speedLevel: num(r.spd_lvl),
      speedPercent: num(r.spd_mag),
      light: light ? light.mode === 'on' : null,
      wifi: r.wifi_signal || null,
      stage: STAGES[num(r.stg_cur)] || null,
      nozzle: r.nozzle_diameter ? `${r.nozzle_diameter} mm${r.nozzle_type ? ' ' + String(r.nozzle_type).replace(/_/g, ' ') : ''}` : null,
      hms: Array.isArray(r.hms) ? r.hms.map(hmsCode) : [],
      printError: num(r.print_error) || null,
      ams: amsInfo(r.ams),
      externalSpool: r.vt_tray ? trayInfo(r.vt_tray) : null,
    };

    const gs = String(r.gcode_state || '').toUpperCase();
    let state = 'operational';
    if (['RUNNING', 'PREPARE', 'SLICING', 'INIT'].includes(gs)) state = 'printing';
    else if (gs === 'PAUSE') state = 'paused';

    if (state === 'operational') {
      if (this.job && !this._awaitingStart) {
        let result;
        let reason = null;
        const errCode = num(r.print_error);
        if (gs === 'FINISH') result = 'done';
        else if (gs === 'FAILED') {
          if (errCode === CANCELLED_BY_USER || Date.now() - this._cancelRequestedAt < 60000) result = 'cancelled';
          else { result = 'failed'; reason = errCode ? `errore ${hmsHex(errCode)}` : null; }
        } else result = this.job.progress >= 0.99 ? 'done' : 'cancelled';
        this._remoteJobEnded(result, reason);
      }
      this._applyRemote('operational', null);
      return;
    }
    const startSec = num(r.gcode_start_time);
    this._applyRemote(state, {
      file: displayName(r.subtask_name || r.gcode_file || 'Stampa'),
      progress: (num(r.mc_percent) || 0) / 100,
      remaining: r.mc_remaining_time !== undefined ? (num(r.mc_remaining_time) || 0) * 60 : null,
      layer: num(r.layer_num),
      layerCount: num(r.total_layer_num),
      startedAt: startSec ? startSec * 1000 : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Comandi

  _gcode(lines, quiet) {
    this._requireConnected();
    const list = lines.map((l) => String(l).trim()).filter(Boolean);
    for (const l of list) this._log('send', l, quiet);
    this._publish({ print: { sequence_id: this._nextSeq(), command: 'gcode_line', param: list.join('\n') + '\n' } });
  }

  sendCommands(commands) {
    const list = Array.isArray(commands) ? commands : String(commands).split('\n');
    this._gcode(list);
  }

  setTemperature(heater, target) {
    const t = Math.max(0, Math.round(Number(target) || 0));
    if (heater === 'bed') return this._gcode([`M140 S${t}`]);
    if (/^T\d+$/.test(heater)) return this._gcode([`M104 S${t}`]);
    throw this._unsupported('Temperatura della camera');
  }

  jog(axes, speed) {
    this._requireIdle();
    const parts = [];
    for (const a of ['x', 'y', 'z']) {
      const v = Number(axes[a]);
      if (v) parts.push(a.toUpperCase() + Math.round(v * 1000) / 1000);
    }
    if (!parts.length) return;
    const onlyZ = parts.length === 1 && parts[0][0] === 'Z';
    const jogCfg = this.config.jog || {};
    const f = speed || (onlyZ ? (jogCfg.zSpeed || 600) : Math.min(jogCfg.xySpeed || 3000, 12000));
    this._gcode(['M211 S', 'M211 X1 Y1 Z1', 'M1002 push_ref_mode', 'G91', `G1 ${parts.join(' ')} F${f}`, 'M1002 pop_ref_mode', 'M211 R']);
  }

  home() {
    this._requireIdle();
    this._gcode(['G28']);
  }

  extrude(amount, speed) {
    this._requireIdle();
    const t = this.temps.tools.T0;
    if (!t || t.actual === null || t.actual < 170) throw new Error('Scalda l\'ugello ad almeno 170° prima di estrudere.');
    this._gcode(['M83', `G1 E${Math.round(Number(amount) * 1000) / 1000} F${speed || this.config.extrudeSpeed || 300}`]);
  }

  setFan(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    this._gcode([`M106 P1 S${Math.round(p * 2.55)}`]);
  }

  motorsOff() {
    this._requireIdle();
    this._gcode(['M18']);
  }

  setLight(on) {
    this._requireConnected();
    this._publish({ system: { sequence_id: this._nextSeq(), command: 'ledctrl', led_node: 'chamber_light', led_mode: on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } });
    this.extra.light = !!on;
    this._changed();
  }

  setSpeedLevel(level) {
    this._requireConnected();
    const l = Math.round(Number(level));
    if (!(l >= 1 && l <= 4)) throw new Error('Livello di velocità non valido.');
    this._publish({ print: { sequence_id: this._nextSeq(), command: 'print_speed', param: String(l) } });
  }

  pause() {
    if (this.state !== 'printing') throw new Error('Nessuna stampa in corso da mettere in pausa.');
    this._publish({ print: { sequence_id: this._nextSeq(), command: 'pause' } });
    this._setState('pausing');
    this._log('info', 'Pausa richiesta.');
  }

  resume() {
    if (this.state !== 'paused') throw new Error('La stampa non è in pausa.');
    this._publish({ print: { sequence_id: this._nextSeq(), command: 'resume' } });
    this._log('info', 'Ripresa richiesta.');
  }

  cancel() {
    if (!this.job) throw new Error('Nessuna stampa da annullare.');
    this._cancelRequestedAt = Date.now();
    this._publish({ print: { sequence_id: this._nextSeq(), command: 'stop' } });
    this._setState('cancelling');
    this._log('info', 'Annullamento richiesto.');
  }

  // ---------------------------------------------------------------------------
  // File sulla scheda SD (FTPS)

  async _ftp(fn) {
    const ftp = require('basic-ftp');
    const client = new ftp.Client(30000);
    try {
      await client.access({
        host: this.net.host,
        port: this.ports.ftp,
        user: 'bblp',
        password: String(this.net.accessCode || '').trim(),
        secure: 'implicit',
        secureOptions: this._tlsOptions(),
      });
      this._checkPeer(client.ftp.socket);
      return await fn(client);
    } finally {
      client.close();
    }
  }

  async _uploadToSd(localPath, remoteName, onProgress) {
    const size = fs.statSync(localPath).size;
    await this._ftp(async (client) => {
      client.trackProgress((info) => { if (onProgress && size) onProgress(Math.min(1, info.bytes / size)); });
      await client.uploadFrom(localPath, remoteName);
      client.trackProgress();
      const remoteSize = await client.size(remoteName).catch(() => size);
      if (remoteSize !== size) throw new Error(`Il file sulla scheda SD è incompleto (${remoteSize} di ${size} byte).`);
    });
  }

  async _uploadForPrint(file, onProgress) {
    const name = remoteFileName(file.name);
    await this._uploadToSd(file.path, name, onProgress);
    return name;
  }

  async _startRemotePrint(remoteName, file) {
    const b = this.config.bambu || {};
    if (fileKind(remoteName) === '.3mf') {
      const meta = file.meta || {};
      const plate = meta.plate || 1;
      const filaments = Math.max(1, meta.filamentCount || 1);
      this._publish({
        print: {
          sequence_id: this._nextSeq(),
          command: 'project_file',
          param: `Metadata/plate_${plate}.gcode`,
          url: this._legacySd ? `file:///sdcard/${remoteName}` : `ftp:///${remoteName}`,
          subtask_name: remoteName.replace(/(\.gcode)?\.3mf$/i, ''),
          md5: '',
          project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0',
          timelapse: !!b.timelapse,
          bed_type: 'auto',
          bed_leveling: b.bedLeveling !== false,
          bed_levelling: b.bedLeveling !== false,
          flow_cali: !!b.flowCalibration,
          vibration_cali: !!b.vibrationCalibration,
          layer_inspect: false,
          use_ams: !!b.useAms,
          ams_mapping: b.useAms ? Array.from({ length: filaments }, (_, i) => i) : [],
        },
      });
    } else {
      this._publish({ print: { sequence_id: this._nextSeq(), command: 'gcode_file', param: this._legacySd ? `/sdcard/${remoteName}` : remoteName } });
    }
  }

  _startFailedMessage() {
    return 'La stampante non ha avviato la stampa. Guarda il suo schermo; se usi la modalità LAN attiva anche la "Modalità sviluppatore".';
  }

  // ---------------------------------------------------------------------------
  // Firmware: aggiornamento offline dalla scheda SD

  firmwareInfo() {
    return {
      kind: 'bambu',
      current: this.firmware,
      model: this.model || null,
      downloadUrl: 'https://bambulab.com/it/support/firmware-download/all',
      canInstall: this.isConnected && !this.isPrinting,
    };
  }

  async installFirmware(filePath, fileName) {
    this._requireConnected();
    if (this.isPrinting) throw new Error('Aspetta la fine della stampa.');
    this._requireNoTask();
    const name = path.basename(String(fileName || ''));
    if (!/\.(zip|bin|sig)$/i.test(name)) throw new Error('Scegli il file del firmware scaricato dal sito di Bambu Lab, senza rinominarlo né estrarlo.');
    this._setTask({ kind: 'firmware', status: 'running', progress: 0, message: `Copia di ${name} sulla scheda SD...` });
    try {
      await this._uploadToSd(filePath, name, (p) => this._setTask({ progress: p }));
      this._setTask({ status: 'done', progress: 1, message: `Firmware copiato sulla scheda SD. Ora sullo schermo della stampante apri Impostazioni > Firmware e avvia l'aggiornamento dalla scheda SD.` });
      this._log('info', `Firmware ${name} copiato sulla scheda SD.`);
    } catch (err) {
      const msg = this._friendlyError(err);
      this._setTask({ status: 'error', message: `Copia non riuscita: ${msg}` });
      throw new Error(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Telecamera delle serie P1 e A1: immagini JPEG su TLS (porta 6000)

  /** Iscrive un visualizzatore alla telecamera; ritorna la funzione per smettere. */
  watchCamera(onFrame) {
    if (!this._jpegCamera) throw this._unsupported('Telecamera integrata (solo serie P1 e A1)');
    this._requireConnected();
    if (!this._camera) {
      this._camera = new JpegCamera({
        host: this.net.host,
        port: this.ports.camera,
        accessCode: String(this.net.accessCode || '').trim(),
        tls: this._tlsOptions(),
      });
      this._camera.on('error', (err) => this._log('warn', 'Telecamera: ' + err.message, true));
      this._camera.start();
    }
    const cam = this._camera;
    cam.on('frame', onFrame);
    if (cam.lastFrame) onFrame(cam.lastFrame);
    return () => {
      cam.off('frame', onFrame);
      if (cam.listenerCount('frame') === 0 && this._camera === cam) this._stopCamera();
    };
  }

  _stopCamera() {
    if (this._camera) {
      this._camera.stop();
      this._camera = null;
    }
  }
}

class JpegCamera extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.socket = null;
    this.stopped = false;
    this.lastFrame = null;
    this._timer = null;
  }

  start() {
    this.stopped = false;
    const auth = Buffer.alloc(80);
    auth.writeUInt32LE(0x40, 0);
    auth.writeUInt32LE(0x3000, 4);
    auth.write('bblp', 16, 'ascii');
    auth.write(this.opts.accessCode, 48, 'ascii');
    const socket = tls.connect({ host: this.opts.host, port: this.opts.port || 6000, ...this.opts.tls }, () => socket.write(auth));
    this.socket = socket;
    let buf = Buffer.alloc(0);
    let need = null;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need === null) {
          if (buf.length < 16) break;
          need = buf.readUInt32LE(0);
          buf = buf.subarray(16);
          if (need > 8 * 1024 * 1024) { socket.destroy(new Error('immagine non valida')); return; }
        }
        if (buf.length < need) break;
        const frame = buf.subarray(0, need);
        buf = buf.subarray(need);
        need = null;
        if (frame[0] === 0xff && frame[1] === 0xd8) {
          this.lastFrame = Buffer.from(frame);
          this.emit('frame', this.lastFrame);
        }
      }
    });
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      if (this.stopped) return;
      this._timer = setTimeout(() => { if (!this.stopped) this.start(); }, 3000);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.removeAllListeners('frame');
  }
}

function isFailure(r) {
  return r.result && /^fail/i.test(String(r.result));
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function displayName(name) {
  return String(name || '').replace(/^.*[\\/]/, '') || 'Stampa';
}

function hmsHex(code) {
  const h = Number(code).toString(16).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

function hmsCode(h) {
  const attr = Number(h.attr || 0).toString(16).toUpperCase().padStart(8, '0');
  const code = Number(h.code || 0).toString(16).toUpperCase().padStart(8, '0');
  return `${attr.slice(0, 4)}_${attr.slice(4)}_${code.slice(0, 4)}_${code.slice(4)}`;
}

function trayInfo(t) {
  if (!t) return null;
  const color = /^[0-9a-f]{6}/i.test(t.tray_color || '') ? '#' + String(t.tray_color).slice(0, 6) : null;
  return { type: t.tray_type || null, color, remain: num(t.remain), empty: !t.tray_type };
}

function amsInfo(ams) {
  if (!ams || !Array.isArray(ams.ams)) return null;
  const active = num(ams.tray_now);
  return ams.ams.map((unit) => ({
    id: num(unit.id),
    humidity: num(unit.humidity),
    trays: (unit.tray || []).map((t) => {
      const slot = num(t.id);
      const globalId = num(unit.id) * 4 + slot;
      return { slot, ...trayInfo(t), active: active === globalId };
    }),
  }));
}

module.exports = { BambuPrinter, JpegCamera, modelName, MODEL_CODES, BAMBU_CA };
