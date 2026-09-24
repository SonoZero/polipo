'use strict';

// Archivio dei file da stampare condiviso tra tutte le stampanti:
// G-code e progetti .gcode.3mf (Bambu Studio, OrcaSlicer).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { pipeline } = require('stream/promises');
const { analyzeFile } = require('./gcode');
const { extractPlate } = require('./threemf');

const EXTENSIONS = ['.gcode', '.gco', '.g', '.bgcode', '.3mf'];
const META_VERSION = 3;

class FileStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = path.join(dataDir, 'files');
    this.thumbDir = path.join(dataDir, 'thumbs');
    this.cacheDir = path.join(dataDir, 'cache');
    this.metaPath = path.join(dataDir, 'files.json');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.thumbDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.meta = readJsonSafe(this.metaPath, {});
    this.analyzing = new Set();
    this.isInUse = () => false;
    this._saveTimer = null;
  }

  init() {
    for (const name of this._scan()) this._ensureAnalyzed(name);
    // rimuovi dai metadati i file cancellati a mano
    const present = new Set(this._scan());
    for (const name of Object.keys(this.meta)) if (!present.has(name)) delete this.meta[name];
    this._save();
  }

  _scan() {
    try {
      return fs.readdirSync(this.dir).filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase()));
    } catch (_) {
      return [];
    }
  }

  list() {
    const out = [];
    for (const name of this._scan()) {
      let st;
      try { st = fs.statSync(path.join(this.dir, name)); } catch (_) { continue; }
      const m = this.meta[name] || {};
      out.push({
        name,
        kind: isProject(name) ? '3mf' : 'gcode',
        size: st.size,
        addedAt: m.addedAt || st.mtimeMs,
        analyzing: this.analyzing.has(name),
        meta: m.meta || null,
        hasThumb: !!m.thumb,
        prints: m.prints || { success: 0, failure: 0, last: null },
      });
    }
    out.sort((a, b) => b.addedAt - a.addedAt);
    return out;
  }

  get(name) {
    const safe = sanitizeName(name);
    const p = path.join(this.dir, safe);
    if (!fs.existsSync(p)) return null;
    const m = this.meta[safe] || {};
    const gcodePath = m.gcode ? path.join(this.cacheDir, m.gcode) : (isProject(safe) ? null : p);
    return { name: safe, path: p, size: fs.statSync(p).size, meta: m.meta || null, gcodePath: gcodePath && fs.existsSync(gcodePath) ? gcodePath : null };
  }

  thumbPath(name) {
    const m = this.meta[sanitizeName(name)];
    if (!m || !m.thumb) return null;
    const p = path.join(this.thumbDir, m.thumb);
    return fs.existsSync(p) ? p : null;
  }

  /** Salva un file caricato (stream) e ne avvia l'analisi. Ritorna il nome finale. */
  async add(originalName, stream) {
    let name = sanitizeName(originalName);
    if (!name) throw new Error('Nome file non valido.');
    if (!EXTENSIONS.includes(path.extname(name).toLowerCase())) {
      throw new Error('Sono accettati file G-code (.gcode) e progetti .gcode.3mf di Bambu Studio e OrcaSlicer.');
    }
    if (path.extname(name).toLowerCase() === '.bgcode') {
      throw new Error('I file .bgcode (G-code binario Prusa) non sono supportati: nello slicer disattiva "G-code binario".');
    }
    // non sovrascrivere un file che una stampante sta usando
    if (this.isInUse(name)) name = uniqueName(this.dir, name);

    const tmp = path.join(this.dir, `.upload-${crypto.randomBytes(6).toString('hex')}`);
    try {
      await pipeline(stream, fs.createWriteStream(tmp));
      const finalPath = path.join(this.dir, name);
      fs.renameSync(tmp, finalPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignora */ }
      throw err;
    }
    const old = this.meta[name];
    if (old && old.thumb) removeQuiet(path.join(this.thumbDir, old.thumb));
    if (old && old.gcode) removeQuiet(path.join(this.cacheDir, old.gcode));
    this.meta[name] = { addedAt: Date.now(), prints: old ? old.prints : undefined };
    this._save();
    this.emit('changed');
    this._ensureAnalyzed(name, true);
    return name;
  }

  remove(name) {
    const safe = sanitizeName(name);
    if (this.isInUse(safe)) throw new Error('Il file è in stampa o in invio a una stampante: aspetta o annulla prima la stampa.');
    const p = path.join(this.dir, safe);
    if (!fs.existsSync(p)) throw new Error('File non trovato.');
    fs.unlinkSync(p);
    const m = this.meta[safe];
    if (m && m.thumb) removeQuiet(path.join(this.thumbDir, m.thumb));
    if (m && m.gcode) removeQuiet(path.join(this.cacheDir, m.gcode));
    delete this.meta[safe];
    this._save();
    this.emit('changed');
  }

  recordPrint(name, result, printerName) {
    const m = this.meta[name];
    if (!m) return;
    m.prints = m.prints || { success: 0, failure: 0, last: null };
    if (result === 'done') m.prints.success++;
    else if (result === 'failed') m.prints.failure++;
    m.prints.last = { date: Date.now(), result, printer: printerName };
    this._save();
    this.emit('changed');
  }

  async _ensureAnalyzed(name, force) {
    const m = this.meta[name] || (this.meta[name] = { addedAt: Date.now() });
    const p = path.join(this.dir, name);
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    if (!force && m.meta && m.metaVersion === META_VERSION && m.size === st.size && m.mtime === st.mtimeMs) return;
    if (this.analyzing.has(name)) return;
    this.analyzing.add(name);
    this.emit('changed');
    try {
      const key = crypto.createHash('sha1').update(name + st.mtimeMs).digest('hex').slice(0, 16);
      let meta;
      let thumb = null;
      if (isProject(name)) {
        const gcodeName = key + '.gcode';
        const project = await extractPlate(p, path.join(this.cacheDir, gcodeName));
        if (m.gcode && m.gcode !== gcodeName) removeQuiet(path.join(this.cacheDir, m.gcode));
        m.gcode = gcodeName;
        meta = await analyzeFile(path.join(this.cacheDir, gcodeName));
        meta.plate = project.plate;
        meta.plates = project.plates;
        if (project.slicer) {
          for (const [k, v] of Object.entries(project.slicer)) if (v !== null && v !== undefined) meta[k] = v;
        }
        if (!meta.slicer) meta.slicer = 'BambuStudio';
        if (project.thumbnail) thumb = project.thumbnail;
      } else {
        meta = await analyzeFile(p);
      }
      if (!thumb && meta.thumbnail) thumb = Buffer.from(meta.thumbnail.base64, 'base64');
      if (thumb) {
        const thumbName = key + '.png';
        fs.writeFileSync(path.join(this.thumbDir, thumbName), thumb);
        if (m.thumb && m.thumb !== thumbName) removeQuiet(path.join(this.thumbDir, m.thumb));
        m.thumb = thumbName;
      }
      delete meta.thumbnail;
      m.meta = meta;
      m.metaVersion = META_VERSION;
      m.size = st.size;
      m.mtime = st.mtimeMs;
    } catch (err) {
      m.meta = { error: err.message };
    } finally {
      this.analyzing.delete(name);
      this._save();
      this.emit('changed');
    }
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => writeJson(this.metaPath, this.meta), 200);
  }

  flush() {
    clearTimeout(this._saveTimer);
    writeJson(this.metaPath, this.meta);
  }
}

function isProject(name) {
  return path.extname(String(name)).toLowerCase() === '.3mf';
}

function sanitizeName(name) {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (!base || base.startsWith('.')) return '';
  return base.slice(0, 200);
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, -ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return def; }
}

/**
 * Lettura dei file importanti (configurazione, cronologia) senza mai perderli:
 * - file mancante: valore iniziale;
 * - file rovinato: se ne tiene una copia accanto e si riparte dal valore iniziale;
 * - file bloccato (per esempio subito dopo un aggiornamento): si riprova per qualche secondo e,
 *   se resta illeggibile, errore, così non viene sovrascritto con dati vuoti.
 */
function readJsonSafe(p, def, { attempts = 15, waitMs = 200 } = {}) {
  for (let i = 0; ; i++) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return def;
      if (i + 1 >= attempts) throw new Error(`Impossibile leggere ${path.basename(p)}: ${err.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      try { fs.copyFileSync(p, `${p}.rovinato-${Date.now()}`); } catch (__) { /* copia facoltativa */ }
      return def;
    }
  }
}

function writeJson(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function removeQuiet(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignora */ }
}

module.exports = { FileStore, sanitizeName, readJson, readJsonSafe, writeJson, isProject };
