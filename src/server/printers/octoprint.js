'use strict';

// Stampanti gestite da un OctoPrint in rete (per esempio su un Raspberry Pi):
// stato letto ogni due secondi, comandi, invio dei file con avvio della stampa
// e aggiornamento del software di OctoPrint (plugin Software Update).

const { NetworkPrinter, remoteFileName } = require('./network');
const { HttpClient, networkError } = require('./http');

const POLL_MS = 2000;

class OctoPrintPrinter extends NetworkPrinter {
  constructor(config, deps) {
    super(config, deps);
    this._poll = null;
    this._failures = 0;
    this._lastFile = null;
  }

  get capabilities() {
    return {
      link: 'octoprint',
      temps: true, jog: true, home: true, extrude: true, motorsOff: true,
      fan: true, feedRate: true, flowRate: true, emergency: true,
      terminal: 'send', scripts: false, preview: true,
      webcam: this.extra.webcam ? 'builtin' : null,
      firmware: 'octoprint',
      files: ['.gcode'],
    };
  }

  _client() {
    const base = `http://${this.net.host}${this.net.port ? ':' + this.net.port : ''}`;
    return new HttpClient({ base, headers: { 'X-Api-Key': this.net.apiKey || '' } });
  }

  async _call(method, path, body, timeout) {
    const c = this._client();
    const res = body === undefined ? await c.request(method, path, { timeout }) : await c.json(method, path, body, { timeout });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('Chiave API di OctoPrint non valida o senza permessi. Creala in OctoPrint: Impostazioni > Application Keys.'), { status: res.status });
    }
    if (res.status >= 400) {
      const msg = (res.data && res.data.error) || res.text || `errore ${res.status}`;
      throw Object.assign(new Error(String(msg).slice(0, 300)), { status: res.status });
    }
    return res.data;
  }

  _friendlyError(err) {
    if (err && err.code) return networkError(err, this.address);
    return err && err.message ? err.message : String(err);
  }

  async _open(session) {
    if (!this.net.apiKey) throw new Error('Inserisci la chiave API di OctoPrint (o premi "Chiedi l\'accesso" per crearla).');
    const version = await this._call('GET', '/api/version', undefined, 6000);
    this.firmware = { name: 'OctoPrint', version: version && (version.server || version.text) || null };
    const conn = await this._call('GET', '/api/connection').catch(() => null);
    if (conn && conn.current && /closed|offline/i.test(conn.current.state || '')) {
      this._log('info', 'OctoPrint non è collegato alla stampante: lo collego.');
      await this._call('POST', '/api/connection', { command: 'connect', autoconnect: true }).catch(() => {});
    }
    this._loadWebcam();
    this._failures = 0;
    await this._tick(session);
    clearInterval(this._poll);
    this._poll = setInterval(() => this._tick(session).catch(() => {}), POLL_MS);
  }

  async _close() {
    clearInterval(this._poll);
    this._poll = null;
  }

  _pollNow() {
    this._tick(this._session).catch(() => {});
  }

  async _loadWebcam() {
    try {
      const s = await this._call('GET', '/api/settings');
      const w = s && s.webcam;
      if (!w || w.webcamEnabled === false || !w.streamUrl) return;
      const base = `http://${this.net.host}${this.net.port ? ':' + this.net.port : ''}`;
      const abs = (u) => (!u ? null : /^https?:\/\//i.test(u) ? u : base + (u.startsWith('/') ? '' : '/') + u);
      this.extra.webcam = { name: 'Webcam', stream: abs(w.streamUrl), snapshot: abs(w.snapshotUrl), flipH: !!w.flipH, flipV: !!w.flipV, rotate: w.rotate90 ? 90 : 0 };
      this._changed();
    } catch (_) { /* nessuna webcam */ }
  }

  async _tick(session) {
    let printer = null;
    let job = null;
    try {
      [printer, job] = await Promise.all([
        this._call('GET', '/api/printer', undefined, 5000).catch((err) => {
          if (err.status === 409) return { notConnected: true };
          throw err;
        }),
        this._call('GET', '/api/job', undefined, 5000),
      ]);
      this._failures = 0;
    } catch (err) {
      if (session !== this._session) return;
      if (err.status === 401 || err.status === 403) return this._connectionLost(err.message);
      if (++this._failures >= 3) this._connectionLost(this._friendlyError(err));
      return;
    }
    if (session !== this._session) return;

    if (printer.notConnected) {
      this.error = 'OctoPrint è raggiungibile ma non è collegato alla stampante.';
      if (this.job) this._remoteJobEnded('failed', 'OctoPrint ha perso la stampante');
      this._setState('error');
      return;
    }
    const t = printer.temperature || {};
    const tools = {};
    for (const [k, v] of Object.entries(t)) {
      const m = /^tool(\d+)$/.exec(k);
      if (m && v) tools['T' + m[1]] = { actual: v.actual ?? null, target: v.target ?? null };
    }
    this._applyTemps({
      tools,
      bed: t.bed ? { actual: t.bed.actual ?? null, target: t.bed.target ?? null } : null,
      chamber: t.chamber && t.chamber.actual !== null ? { actual: t.chamber.actual, target: t.chamber.target ?? null } : null,
    });

    const flags = (printer.state && printer.state.flags) || {};
    if (flags.error || flags.closedOrError) {
      this.error = (printer.state && printer.state.error) || (job && job.error) || 'OctoPrint segnala un errore della stampante.';
    } else {
      this.error = null;
    }
    let state = 'operational';
    if (flags.cancelling) state = 'cancelling';
    else if (flags.pausing) state = 'pausing';
    else if (flags.paused) state = 'paused';
    else if (flags.printing) state = 'printing';
    else if (flags.error || flags.closedOrError) state = 'error';

    const file = job && job.job && job.job.file && job.job.file.name ? job.job.file.name : null;
    if (file) this._lastFile = file;
    if (['operational', 'error'].includes(state)) {
      if (this.job && !this._awaitingStart) {
        const text = String((job && job.state) || '');
        const result = state === 'error' ? 'failed' : /cancel/i.test(text) ? 'cancelled' : (job && job.progress && job.progress.completion >= 99.9) || this.job.progress >= 0.99 ? 'done' : 'cancelled';
        this._remoteJobEnded(result, state === 'error' ? this.error : null);
      }
      if (state === 'error') { this.job = null; this._setState('error'); } else this._applyRemote('operational', null);
      return;
    }
    const pr = (job && job.progress) || {};
    this._applyRemote(state, {
      file: file || this._lastFile || 'Stampa',
      size: job && job.job && job.job.file ? job.job.file.size : null,
      progress: (pr.completion || 0) / 100,
      elapsed: pr.printTime ?? null,
      remaining: pr.printTimeLeft ?? null,
      estimatedTime: job && job.job ? job.job.estimatedPrintTime : null,
    });
  }

  // ---------------------------------------------------------------------------
  // Comandi

  async _command(lines) {
    this._requireConnected();
    const list = lines.map((l) => String(l).trim()).filter(Boolean);
    for (const l of list) this._log('send', l);
    await this._call('POST', '/api/printer/command', { commands: list });
  }

  sendCommands(commands) {
    const list = Array.isArray(commands) ? commands : String(commands).split('\n');
    return this._command(list);
  }

  setTemperature(heater, target) {
    const t = Math.max(0, Math.round(Number(target) || 0));
    if (heater === 'bed') return this._call('POST', '/api/printer/bed', { command: 'target', target: t });
    if (heater === 'chamber') return this._call('POST', '/api/printer/chamber', { command: 'target', target: t });
    const m = /^T(\d+)$/.exec(heater);
    if (!m) throw new Error('Riscaldatore sconosciuto: ' + heater);
    return this._call('POST', '/api/printer/tool', { command: 'target', targets: { ['tool' + m[1]]: t } });
  }

  jog(axes, speed) {
    this._requireIdle();
    const body = { command: 'jog', absolute: false };
    for (const a of ['x', 'y', 'z']) if (Number(axes[a])) body[a] = Number(axes[a]);
    if (speed) body.speed = speed;
    return this._call('POST', '/api/printer/printhead', body);
  }

  home(axes) {
    this._requireIdle();
    const list = (axes && axes.length ? axes : ['x', 'y', 'z']).map((a) => String(a).toLowerCase()).filter((a) => /^[xyz]$/.test(a));
    return this._call('POST', '/api/printer/printhead', { command: 'home', axes: list });
  }

  extrude(amount, speed, tool) {
    this._requireIdle();
    const cmds = [];
    if (tool !== undefined && tool !== null) cmds.push(`T${tool}`);
    cmds.push('M83', `G1 E${Math.round(Number(amount) * 1000) / 1000} F${speed || this.config.extrudeSpeed || 300}`, 'M82');
    return this._command(cmds);
  }

  setFan(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    return this._command([p > 0 ? `M106 S${Math.round(p * 2.55)}` : 'M107']);
  }

  motorsOff() {
    this._requireIdle();
    return this._command(['M84']);
  }

  setFeedRate(p) { return this._call('POST', '/api/printer/printhead', { command: 'feedrate', factor: Math.round(Number(p)) }); }
  setFlowRate(p) { return this._call('POST', '/api/printer/tool', { command: 'flowrate', factor: Math.round(Number(p)) }); }

  emergencyStop() {
    return this._command(['M112']);
  }

  async pause() {
    if (this.state !== 'printing') throw new Error('Nessuna stampa in corso da mettere in pausa.');
    await this._call('POST', '/api/job', { command: 'pause', action: 'pause' });
    this._setState('pausing');
  }

  async resume() {
    if (this.state !== 'paused') throw new Error('La stampa non è in pausa.');
    await this._call('POST', '/api/job', { command: 'pause', action: 'resume' });
  }

  async cancel() {
    if (!this.job) throw new Error('Nessuna stampa da annullare.');
    await this._call('POST', '/api/job', { command: 'cancel' });
    this._setState('cancelling');
  }

  // ---------------------------------------------------------------------------
  // Invio e avvio dei file

  async _uploadForPrint(file, onProgress) {
    const name = remoteFileName(file.name);
    const res = await this._client().upload({
      method: 'POST',
      path: '/api/files/local',
      filePath: file.path,
      fileName: name,
      multipart: { fileField: 'file', fields: { select: 'true', print: 'true' } },
      onProgress,
      timeout: 30 * 60 * 1000,
    });
    if (res.status === 401 || res.status === 403) throw new Error('Chiave API di OctoPrint non valida o senza il permesso di caricare file.');
    if (res.status === 409) throw new Error('OctoPrint non può stampare adesso (stampante non pronta o già in stampa).');
    if (res.status >= 400) throw new Error(`Caricamento rifiutato da OctoPrint (errore ${res.status}).`);
    return name;
  }

  async _startRemotePrint() {}

  // ---------------------------------------------------------------------------
  // Aggiornamento del software di OctoPrint

  async firmwareInfo(refresh) {
    this._requireConnected();
    let data;
    try {
      data = await this._call('GET', '/plugin/softwareupdate/check' + (refresh ? '?force=true' : ''), undefined, 60000);
    } catch (err) {
      if (err.status === 403 || err.status === 401) {
        return { kind: 'octoprint', current: this.firmware, components: [], error: 'Per controllare gli aggiornamenti serve una chiave API di un amministratore di OctoPrint.', canInstall: false };
      }
      throw err;
    }
    const components = Object.entries((data && data.information) || {}).map(([name, v]) => ({
      name,
      label: v.displayName || name,
      version: v.information && v.information.local ? v.information.local.value : null,
      remote: v.information && v.information.remote ? v.information.remote.value : null,
      available: !!v.updateAvailable,
      possible: v.updatePossible !== false,
    }));
    return { kind: 'octoprint', current: this.firmware, components, canInstall: this.isConnected && !this.isPrinting };
  }

  async installFirmware(name) {
    this._requireConnected();
    if (this.isPrinting) throw new Error('Aspetta la fine della stampa.');
    this._requireNoTask();
    const info = await this.firmwareInfo(false);
    const targets = name && name !== 'full' ? [name] : info.components.filter((c) => c.available && c.possible).map((c) => c.name);
    if (!targets.length) throw new Error('Non ci sono aggiornamenti da installare.');
    this._setTask({ kind: 'firmware', status: 'running', progress: null, message: 'Aggiornamento avviato: OctoPrint si riavvierà da solo quando ha finito.' });
    try {
      await this._call('POST', '/plugin/softwareupdate/update', { targets }, 60000);
      this._setTask({ status: 'done', message: 'Aggiornamento avviato. OctoPrint si riavvia: SonoPrint si ricollega da solo.' });
    } catch (err) {
      this._setTask({ status: 'error', message: `Aggiornamento non riuscito: ${this._friendlyError(err)}` });
      throw err;
    }
  }
}

/**
 * Chiede a OctoPrint una chiave per SonoPrint (plugin Application Keys):
 * l'utente conferma nella pagina di OctoPrint. Ritorna la chiave oppure null se rifiutata.
 */
async function requestOctoPrintKey(host, port, { timeoutMs = 120000, signal } = {}) {
  const c = new HttpClient({ base: `http://${host}${port ? ':' + port : ''}` });
  const probe = await c.request('GET', '/plugin/appkeys/probe', { timeout: 6000 });
  if (probe.status !== 204) throw new Error('Questo OctoPrint non supporta la richiesta automatica della chiave: creala a mano in Impostazioni > Application Keys.');
  const req = await c.json('POST', '/plugin/appkeys/request', { app: 'SonoPrint' }, { timeout: 6000 });
  if (req.status !== 201 || !req.data || !req.data.app_token) throw new Error('OctoPrint non ha accettato la richiesta.');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (signal && signal.aborted) return null;
    await new Promise((r) => setTimeout(r, 1500));
    const r = await c.request('GET', `/plugin/appkeys/request/${req.data.app_token}`, { timeout: 6000 });
    if (r.status === 200 && r.data && r.data.api_key) return r.data.api_key;
    if (r.status === 404) return null;
  }
  throw new Error('Tempo scaduto: conferma la richiesta nella pagina di OctoPrint entro due minuti.');
}

module.exports = { OctoPrintPrinter, requestOctoPrintKey };
