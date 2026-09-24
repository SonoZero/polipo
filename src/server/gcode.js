'use strict';

// Utility per il protocollo G-code (Marlin / Prusa / RepRap) e per l'analisi dei file.

const fs = require('fs');
const readline = require('readline');

/** Checksum XOR usato da Marlin: "N12 G1 X10*<checksum>" */
function checksum(str) {
  let cs = 0;
  for (let i = 0; i < str.length; i++) cs ^= str.charCodeAt(i);
  return cs & 0xff;
}

/** Rimuove i commenti ";" e "(...)" e gli spazi superflui. */
function stripComment(line) {
  let out = line;
  const semi = out.indexOf(';');
  if (semi >= 0) out = out.slice(0, semi);
  if (out.indexOf('(') >= 0) out = out.replace(/\([^)]*\)/g, '');
  return out.trim();
}

/** Primo "token" del comando in maiuscolo, es. "G1", "M104", "T0". */
function commandCode(cmd) {
  const m = /^\s*([GMTgmt])\s*(\d+)/.exec(cmd);
  return m ? (m[1].toUpperCase() + String(parseInt(m[2], 10))) : null;
}

/** Legge un parametro numerico (es. 'S' in "M104 S200"). */
function param(cmd, letter) {
  const re = new RegExp('(?:^|\\s)' + letter + '\\s*(-?\\d*\\.?\\d+)', 'i');
  const m = re.exec(cmd);
  return m ? parseFloat(m[1]) : null;
}

/** Normalizza un comando inserito dall'utente: prima parola in maiuscolo. */
function normalizeCommand(cmd) {
  const s = stripComment(cmd);
  if (!s) return '';
  const idx = s.search(/\s/);
  if (idx < 0) return s.toUpperCase();
  return s.slice(0, idx).toUpperCase() + s.slice(idx);
}

const TEMP_LINE = /^(T\d*|B|C):/;
const TEMP_RE = /(?:^|\s)(T\d*|B|C):\s*(-?\d+(?:\.\d+)?)\s*(?:\/\s*(-?\d+(?:\.\d+)?))?/g;

/**
 * Interpreta un report di temperatura, ad esempio
 * "ok T:210.0 /210.0 B:60.0 /60.0 T0:210.0 /210.0 @:127 B@:0".
 * Ritorna { tools: {T0:{actual,target}}, bed, chamber } oppure null.
 */
function parseTemperatures(line) {
  let s = line.trim();
  if (s.startsWith('ok')) s = s.slice(2).trim();
  if (!TEMP_LINE.test(s)) return null;
  const found = {};
  TEMP_RE.lastIndex = 0;
  let m;
  while ((m = TEMP_RE.exec(s)) !== null) {
    const actual = parseFloat(m[2]);
    const target = m[3] !== undefined ? parseFloat(m[3]) : null;
    found[m[1]] = { actual, target };
  }
  const result = { tools: {}, bed: null, chamber: null };
  const numbered = Object.keys(found).filter((k) => /^T\d+$/.test(k));
  if (numbered.length) {
    for (const k of numbered) result.tools[k] = found[k];
  } else if (found.T) {
    result.tools.T0 = found.T;
  }
  if (found.B) result.bed = found.B;
  if (found.C) result.chamber = found.C;
  if (!numbered.length && !found.T && !found.B) return null;
  return result;
}

/** Risposta di M114: "X:0.00 Y:0.00 Z:0.00 E:0.00 Count X:0 Y:0 Z:0" */
function parsePosition(line) {
  const part = line.split('Count')[0];
  const m = /X:\s*(-?[\d.]+)\s*Y:\s*(-?[\d.]+)\s*Z:\s*(-?[\d.]+)(?:\s*E:\s*(-?[\d.]+))?/.exec(part);
  if (!m) return null;
  return { x: +m[1], y: +m[2], z: +m[3], e: m[4] !== undefined ? +m[4] : null };
}

/** Risposta di M115: "FIRMWARE_NAME:Marlin 2.1.2 ... MACHINE_TYPE:Ender-3 EXTRUDER_COUNT:1" */
function parseFirmwareInfo(line) {
  if (!line.includes('FIRMWARE_NAME')) return null;
  const info = {};
  const keys = ['FIRMWARE_NAME', 'SOURCE_CODE_URL', 'PROTOCOL_VERSION', 'MACHINE_TYPE', 'EXTRUDER_COUNT', 'UUID', 'FIRMWARE_VERSION'];
  const re = new RegExp('(' + keys.join('|') + '):', 'g');
  const positions = [];
  let m;
  while ((m = re.exec(line)) !== null) positions.push({ key: m[1], start: m.index, valueStart: re.lastIndex });
  positions.forEach((p, i) => {
    const end = i + 1 < positions.length ? positions[i + 1].start : line.length;
    info[p.key] = line.slice(p.valueStart, end).trim();
  });
  return info;
}

/** Riga di capability di M115: "Cap:AUTOREPORT_TEMP:1" */
function parseCapability(line) {
  const m = /^Cap:([A-Z0-9_]+):([01])/.exec(line.trim());
  return m ? { name: m[1], enabled: m[2] === '1' } : null;
}

/** Converte "1d 2h 3m 4s" / "1h 2m" in secondi. */
function parseDurationText(text) {
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const v = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    total += u === 'd' ? v * 86400 : u === 'h' ? v * 3600 : u === 'm' ? v * 60 : v;
  }
  return matched ? Math.round(total) : null;
}

/**
 * Analizza un file G-code in streaming: slicer, tempo stimato, filamento,
 * numero di layer, ingombro e miniatura (PrusaSlicer/Orca/Cura).
 */
async function analyzeFile(filePath) {
  const meta = {
    slicer: null,
    estimatedTime: null,
    filamentLength: null, // mm
    filamentWeight: null, // g
    layerCount: null,
    layerHeight: null,
    lineCount: 0,
    commandCount: 0,
    bounds: null,
    thumbnail: null, // { width, height, base64 }
    material: null,
    nozzleTemp: null,
    bedTemp: null,
  };

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let x = 0, y = 0, z = 0, e = 0;
  let relative = false, relativeE = false;
  let layerChanges = 0;
  let lastExtrudeZ = null;
  let zLayers = 0;
  let totalE = 0;

  let thumbCurrent = null;
  let thumbBest = null;

  const stream = fs.createReadStream(filePath, { encoding: 'latin1' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    meta.lineCount++;
    const line = raw.trim();
    if (!line) continue;

    if (line[0] === ';') {
      const c = line.slice(1).trim();
      if (thumbCurrent) {
        if (/^thumbnail(_\w+)? end/.test(c)) {
          if (!thumbBest || thumbCurrent.width * thumbCurrent.height > thumbBest.width * thumbBest.height) {
            thumbBest = thumbCurrent;
          }
          thumbCurrent = null;
        } else {
          thumbCurrent.data.push(c);
        }
        continue;
      }
      let m;
      if ((m = /^thumbnail(?:_(\w+))? begin (\d+)x(\d+)/.exec(c))) {
        const fmt = (m[1] || 'PNG').toUpperCase();
        thumbCurrent = fmt === 'PNG' ? { width: +m[2], height: +m[3], data: [] } : null;
        if (!thumbCurrent) thumbCurrent = { width: 0, height: 0, data: [], skip: true };
        continue;
      }
      if (!meta.slicer) {
        if (/generated (with|by) (PrusaSlicer|SuperSlicer|OrcaSlicer|BambuStudio|Slic3r|Cura|Simplify3D|IdeaMaker|Creality)/i.test(c)
          || /^Generated with Cura/i.test(c) || /^FLAVOR:/.test(c)) {
          const sm = /(PrusaSlicer|SuperSlicer|OrcaSlicer|BambuStudio|Slic3r|Cura|Simplify3D|IdeaMaker|Creality\w*)/i.exec(c);
          meta.slicer = sm ? sm[1] : 'Cura';
        }
      }
      if ((m = /^TIME:(\d+)/.exec(c))) meta.estimatedTime = +m[1];
      else if ((m = /^estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/i.exec(c))) {
        const t = parseDurationText(m[1]);
        if (t !== null) meta.estimatedTime = t;
      } else if ((m = /^model printing time:\s*([^;]+)/i.exec(c))) {
        const t = parseDurationText(m[1]);
        if (t !== null && meta.estimatedTime === null) meta.estimatedTime = t;
      } else if ((m = /^Build time:\s*(\d+) hours? (\d+) minutes?/i.exec(c))) {
        meta.estimatedTime = (+m[1]) * 3600 + (+m[2]) * 60;
      } else if ((m = /^Filament used:\s*([\d.]+)m/i.exec(c))) {
        meta.filamentLength = parseFloat(m[1]) * 1000;
      } else if ((m = /^filament used \[mm\]\s*=\s*([\d.]+)/i.exec(c))) {
        meta.filamentLength = parseFloat(m[1]);
      } else if ((m = /^(?:total )?filament used \[g\]\s*=\s*([\d.]+)/i.exec(c))) {
        meta.filamentWeight = parseFloat(m[1]);
      } else if ((m = /^LAYER_COUNT:(\d+)/.exec(c))) {
        meta.layerCount = +m[1];
      } else if ((m = /^(?:total layers? count|total_layer_number)\s*[=:]\s*(\d+)/i.exec(c))) {
        meta.layerCount = +m[1];
      } else if (c === 'LAYER_CHANGE' || /^LAYER:\d+/.test(c)) {
        layerChanges++;
      } else if ((m = /^layer_height\s*=\s*([\d.]+)/.exec(c)) || (m = /^Layer height:\s*([\d.]+)/i.exec(c))) {
        meta.layerHeight = parseFloat(m[1]);
      } else if ((m = /^filament_type\s*=\s*(\S+)/.exec(c)) || (m = /^MATERIAL:?\s*(\S+)/.exec(c))) {
        if (!meta.material) meta.material = m[1].split(';')[0];
      }
      continue;
    }

    const cmd = stripComment(line);
    if (!cmd) continue;
    meta.commandCount++;
    const code = commandCode(cmd);
    if (!code) continue;

    if (code === 'G0' || code === 'G1') {
      const px = param(cmd, 'X'), py = param(cmd, 'Y'), pz = param(cmd, 'Z'), pe = param(cmd, 'E');
      if (px !== null) x = relative ? x + px : px;
      if (py !== null) y = relative ? y + py : py;
      if (pz !== null) z = relative ? z + pz : pz;
      let extruding = false;
      if (pe !== null) {
        const de = relativeE ? pe : pe - e;
        e = relativeE ? e + pe : pe;
        if (de > 0) { extruding = true; totalE += de; }
      }
      if (extruding && (px !== null || py !== null)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (lastExtrudeZ === null || Math.abs(z - lastExtrudeZ) > 1e-6) {
          if (lastExtrudeZ === null || z > lastExtrudeZ) zLayers++;
          lastExtrudeZ = z;
        }
      }
    } else if (code === 'G90') { relative = false; relativeE = false; }
    else if (code === 'G91') { relative = true; relativeE = true; }
    else if (code === 'M82') relativeE = false;
    else if (code === 'M83') relativeE = true;
    else if (code === 'G92') {
      const pe = param(cmd, 'E');
      if (pe !== null) e = pe;
      const px = param(cmd, 'X'); if (px !== null) x = px;
      const py = param(cmd, 'Y'); if (py !== null) y = py;
      const pz = param(cmd, 'Z'); if (pz !== null) z = pz;
    } else if ((code === 'M104' || code === 'M109') && meta.nozzleTemp === null) {
      const s = param(cmd, 'S') ?? param(cmd, 'R');
      if (s) meta.nozzleTemp = s;
    } else if ((code === 'M140' || code === 'M190') && meta.bedTemp === null) {
      const s = param(cmd, 'S') ?? param(cmd, 'R');
      if (s) meta.bedTemp = s;
    }
  }

  if (meta.layerCount === null) meta.layerCount = layerChanges || zLayers || null;
  if (meta.filamentLength === null && totalE > 0) meta.filamentLength = Math.round(totalE);
  if (isFinite(minX)) {
    meta.bounds = {
      minX: round2(minX), maxX: round2(maxX),
      minY: round2(minY), maxY: round2(maxY),
      minZ: round2(minZ), maxZ: round2(maxZ),
    };
  }
  if (thumbBest && !thumbBest.skip && thumbBest.data.length) {
    meta.thumbnail = { width: thumbBest.width, height: thumbBest.height, base64: thumbBest.data.join('') };
  }
  return meta;
}

function round2(v) { return Math.round(v * 100) / 100; }

/**
 * Lettore "a richiesta" di un file G-code: legge a blocchi e restituisce una riga
 * alla volta insieme alla posizione in byte, così anche file da centinaia di MB
 * non occupano memoria.
 */
class GcodeFileReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.pos = 0; // byte consumati (righe complete restituite)
    this.readPos = 0;
    this.buffer = '';
    this.eof = false;
    this.chunk = Buffer.allocUnsafe(64 * 1024);
  }

  /** Ritorna la prossima riga grezza (senza \n) o null a fine file. */
  nextRaw() {
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.pos += nl + 1;
        return line.replace(/\r$/, '');
      }
      if (this.eof) {
        if (this.buffer.length) {
          const line = this.buffer;
          this.pos += line.length;
          this.buffer = '';
          return line.replace(/\r$/, '');
        }
        return null;
      }
      const n = fs.readSync(this.fd, this.chunk, 0, this.chunk.length, this.readPos);
      if (n <= 0) this.eof = true;
      else {
        this.readPos += n;
        this.buffer += this.chunk.toString('latin1', 0, n);
      }
    }
  }

  get progress() {
    return this.size ? Math.min(1, this.pos / this.size) : 1;
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch (_) { /* già chiuso */ }
      this.fd = null;
    }
  }
}

module.exports = {
  checksum,
  stripComment,
  commandCode,
  param,
  normalizeCommand,
  parseTemperatures,
  parsePosition,
  parseFirmwareInfo,
  parseCapability,
  parseDurationText,
  analyzeFile,
  GcodeFileReader,
};
