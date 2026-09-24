'use strict';

// Archivio dei file G-code condiviso tra tutte le stampanti.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { pipeline } = require('stream/promises');
const { analyzeFile } = require('./gcode');

const EXTENSIONS = ['.gcode', '.gco', '.g', '.bgcode'];
const META_VERSION = 3;

class FileStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = path.join(dataDir, 'files');
    this.thumbDir = path.join(dataDir, 'thumbs');
    this.metaPath = path.join(dataDir, 'files.json');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.meta = readJson(this.metaPath, {});
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
    return { name: safe, path: p, meta: m.meta || null };
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
      throw new Error('Sono accettati solo file G-code (.gcode, .gco, .g).');
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
    this.meta[name] = { addedAt: Date.now(), prints: old ? old.prints : undefined };
    this._save();
    this.emit('changed');
    this._ensureAnalyzed(name, true);
    return name;
  }

  remove(name) {
    const safe = sanitizeName(name);
    if (this.isInUse(safe)) throw new Error('Il file è in stampa su una stampante: annulla prima la stampa.');
    const p = path.join(this.dir, safe);
    if (!fs.existsSync(p)) throw new Error('File non trovato.');
    fs.unlinkSync(p);
    const m = this.meta[safe];
    if (m && m.thumb) removeQuiet(path.join(this.thumbDir, m.thumb));
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
      const meta = await analyzeFile(p);
      if (meta.thumbnail) {
        const thumbName = crypto.createHash('sha1').update(name + st.mtimeMs).digest('hex').slice(0, 16) + '.png';
        fs.writeFileSync(path.join(this.thumbDir, thumbName), Buffer.from(meta.thumbnail.base64, 'base64'));
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

function writeJson(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function removeQuiet(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignora */ }
}

module.exports = { FileStore, sanitizeName, readJson, writeJson };
