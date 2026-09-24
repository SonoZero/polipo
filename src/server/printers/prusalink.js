'use strict';

// Stampanti Prusa con PrusaLink (MK4, MK3.9, Core One, MINI+, XL): stato letto
// ogni due secondi, invio dei file sulla chiavetta USB con avvio automatico,
// pausa, ripresa e annullamento. PrusaLink non permette di muovere gli assi
// né di impostare le temperature da remoto.

const { NetworkPrinter, remoteFileName } = require('./network');
const { HttpClient, networkError } = require('./http');
const { blendRemaining } = require('./base');
const { latestRelease, compareVersions } = require('../firmware/releases');

const POLL_MS = 2000;

class PrusaLinkPrinter extends NetworkPrinter {
  constructor(config, deps) {
    super(config, deps);
    this._poll = null;
    this._jobId = null;
    this._jobFile = null;
    this._storage = '/usb';
    this._failures = 0;
  }

  get capabilities() {
    return {
      link: 'prusalink',
      temps: false, jog: false, home: false, extrude: false, motorsOff: false,
      fan: false, feedRate: false, flowRate: false, emergency: false,
      terminal: false, scripts: false, preview: true, webcam: null,
      firmware: 'prusalink',
      files: ['.gcode'],
    };
  }

  _client() {
    const base = `http://${this.net.host}${this.net.port ? ':' + this.net.port : ''}`;
    if (this.net.apiKey) return new HttpClient({ base, headers: { 'X-Api-Key': this.net.apiKey } });
    if (!this._http || this._http.base !== base) {
      this._http = new HttpClient({ base, digest: { username: this.net.username || 'maker', password: this.net.password || '' } });
    }
    return this._http;
  }

  async _get(path, timeout) {
    const res = await this._client().request('GET', path, { timeout });
    if (res.status === 401) throw new Error('Nome utente o password di PrusaLink sbagliati. Li trovi sullo schermo della stampante in Impostazioni > Rete > PrusaLink.');
    if (res.status === 204) return null;
    if (res.status >= 400) throw Object.assign(new Error(`PrusaLink ha risposto con l'errore ${res.status}.`), { status: res.status });
    return res.data;
  }

  async _send(method, path, timeout) {
    const res = await this._client().request(method, path, { timeout });
    if (res.status === 401) throw new Error('Nome utente o password di PrusaLink sbagliati.');
    if (res.status === 409) throw new Error('La stampante non può farlo adesso (è occupata o già in quello stato).');
    if (res.status >= 400) throw new Error(`PrusaLink ha risposto con l'errore ${res.status}.`);
  }

  _friendlyError(err) {
    if (err && err.code) return networkError(err, this.address);
    return err && err.message ? err.message : String(err);
  }

  async _open(session) {
    if (!this.net.apiKey && !this.net.password) throw new Error('Inserisci la password di PrusaLink (Impostazioni > Rete > PrusaLink sullo schermo della stampante).');
    const version = await this._get('/api/version', 6000);
    if (!version) throw new Error('A questo indirizzo non risponde PrusaLink.');
    const info = await this._get('/api/v1/info').catch(() => null);
    this.firmware = {
      name: 'Prusa ' + (info && info.hostname ? info.hostname : 'PrusaLink'),
      version: version.firmware || null,
      api: version.api || null,
      serial: info && info.serial ? info.serial : null,
    };
    const storages = await this._get('/api/v1/storage').catch(() => null);
    const list = storages && (storages.storage_list || storages);
    if (Array.isArray(list)) {
      const usable = list.find((s) => s.available !== false && !s.read_only);
      if (usable && usable.path) this._storage = usable.path.replace(/\/+$/, '');
    }
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

  async _tick(session) {
    let status;
    try {
      status = await this._get('/api/v1/status', 5000);
      this._failures = 0;
    } catch (err) {
      if (session !== this._session) return;
      if (++this._failures >= 3) this._connectionLost(this._friendlyError(err));
      return;
    }
    if (session !== this._session || !status) return;
    const p = status.printer || {};
    this._applyTemps({
      tools: { T0: { actual: p.temp_nozzle ?? null, target: p.target_nozzle ?? null } },
      bed: { actual: p.temp_bed ?? null, target: p.target_bed ?? null },
    });
    if (p.speed !== undefined) this.feedRate = p.speed;
    if (p.flow !== undefined) this.flowRate = p.flow;
    if (p.axis_z !== undefined) this.position = { x: p.axis_x ?? null, y: p.axis_y ?? null, z: p.axis_z };
    this.extra = { ...this.extra, printerState: p.state || null };

    const st = String(p.state || '').toUpperCase();
    const job = status.job;
    if (st === 'ERROR' || st === 'ATTENTION') {
      this.error = st === 'ATTENTION' ? 'La stampante chiede attenzione: guarda il suo schermo.' : 'La stampante segnala un errore: guarda il suo schermo.';
    } else if (this.state !== 'error') {
      this.error = null;
    }
    let state = 'operational';
    if (st === 'PRINTING') state = 'printing';
    else if (st === 'PAUSED') state = 'paused';
    else if (st === 'BUSY' && job) state = 'printing';
    else if (st === 'ATTENTION' && job) state = 'paused';

    if (state === 'operational' || !job) {
      if (this.job && !this._awaitingStart) {
        const result = st === 'FINISHED' ? 'done' : st === 'STOPPED' ? 'cancelled' : st === 'ERROR' ? 'failed' : (this.job.progress >= 0.99 ? 'done' : 'cancelled');
        this._remoteJobEnded(result, st === 'ERROR' ? 'errore della stampante' : null);
      }
      this._jobId = null;
      this._applyRemote('operational', null);
      return;
    }
    if (job.id !== this._jobId) {
      this._jobId = job.id;
      this._jobFile = null;
      this._get('/api/v1/job').then((j) => {
        if (j && j.id === this._jobId) {
          this._jobFile = { name: (j.file && (j.file.display_name || j.file.name)) || 'Stampa', size: j.file && j.file.size ? j.file.size : null };
        }
      }).catch(() => {});
    }
    const progress = (Number(job.progress) || 0) / 100;
    const elapsed = job.time_printing ?? null;
    this._applyRemote(state, {
      file: this._jobFile ? this._jobFile.name : (this.job ? this.job.file : 'Stampa'),
      size: this._jobFile ? this._jobFile.size : null,
      progress,
      elapsed,
      remaining: job.time_remaining ?? blendRemaining(null, elapsed || 0, progress),
    });
  }

  async pause() {
    if (this.state !== 'printing' || !this._jobId) throw new Error('Nessuna stampa in corso da mettere in pausa.');
    await this._send('PUT', `/api/v1/job/${this._jobId}/pause`);
    this._setState('pausing');
  }

  async resume() {
    if (this.state !== 'paused' || !this._jobId) throw new Error('La stampa non è in pausa.');
    await this._send('PUT', `/api/v1/job/${this._jobId}/resume`);
  }

  async cancel() {
    if (!this._jobId) throw new Error('Nessuna stampa da annullare.');
    await this._send('DELETE', `/api/v1/job/${this._jobId}`);
    this._setState('cancelling');
  }

  async _uploadForPrint(file, onProgress) {
    const name = remoteFileName(file.name);
    const res = await this._client().upload({
      method: 'PUT',
      path: `/api/v1/files${this._storage}/${encodeURIComponent(name)}`,
      filePath: file.path,
      fileName: name,
      headers: { 'Content-Type': 'text/x.gcode', 'Print-After-Upload': '?1', Overwrite: '?1' },
      probePath: '/api/version',
      onProgress,
      timeout: 30 * 60 * 1000,
    });
    if (res.status === 401) throw new Error('Nome utente o password di PrusaLink sbagliati.');
    if (res.status === 409) throw new Error('La stampante è occupata: aspetta che finisca e riprova.');
    if (res.status === 415) throw new Error('PrusaLink non accetta questo tipo di file.');
    if (res.status >= 400) throw new Error(`Caricamento rifiutato da PrusaLink (errore ${res.status}).`);
    return name;
  }

  // la stampa parte da sola a fine caricamento (Print-After-Upload)
  async _startRemotePrint() {}

  // ---------------------------------------------------------------------------
  // Firmware: versione installata e ultima versione pubblicata da Prusa

  async firmwareInfo(refresh) {
    const latest = await latestRelease('prusa3d/Prusa-Firmware-Buddy', refresh);
    return {
      kind: 'prusalink',
      current: this.firmware,
      latest,
      updateAvailable: !!(latest && this.firmware && this.firmware.version && compareVersions(latest.version, this.firmware.version) > 0),
      downloadUrl: 'https://www.prusa3d.com/drivers/',
      canInstall: false,
    };
  }
}

module.exports = { PrusaLinkPrinter };
