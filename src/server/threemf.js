'use strict';

// Lettura dei progetti 3MF con G-code (".gcode.3mf" di Bambu Studio e OrcaSlicer):
// sono archivi ZIP con il G-code di ogni piatto, le miniature e le stime dello slicer.

const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

/** Elenco dei file contenuti nello ZIP (anche ZIP64). */
function listEntries(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66 * 1024);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Il file 3MF è danneggiato o non è un archivio valido.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('Archivio ZIP64 non valido.');
      const z64pos = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = readAt(fd, z64pos, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('Archivio ZIP64 non valido.');
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(extra.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({ name, method, compSize, size: uncompSize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function dataStart(filePath, entry) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const h = readAt(fd, entry.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('Archivio 3MF danneggiato.');
    return entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
}

function entryStream(filePath, entry) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Compressione non supportata nel 3MF (metodo ${entry.method}).`);
  const start = dataStart(filePath, entry);
  const raw = fs.createReadStream(filePath, { start, end: entry.compSize ? start + entry.compSize - 1 : start });
  if (entry.method === 0) return raw;
  return raw.pipe(zlib.createInflateRaw());
}

async function extractEntry(filePath, entry, destPath) {
  await pipeline(entryStream(filePath, entry), fs.createWriteStream(destPath));
}

async function readEntry(filePath, entry, limit = 8 * 1024 * 1024) {
  if (entry.size > limit) throw new Error('Voce del 3MF troppo grande.');
  const chunks = [];
  for await (const c of entryStream(filePath, entry)) chunks.push(c);
  return Buffer.concat(chunks);
}

function xmlAttrs(tag) {
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = m[2];
  return out;
}

/** Stime dello slicer per ogni piatto (Metadata/slice_info.config). */
function parseSliceInfo(xml) {
  const plates = {};
  const plateRe = /<plate>([\s\S]*?)<\/plate>/g;
  let m;
  while ((m = plateRe.exec(xml))) {
    const body = m[1];
    const meta = {};
    const metaRe = /<metadata\s+([^>]*?)\/>/g;
    let mm;
    while ((mm = metaRe.exec(body))) {
      const a = xmlAttrs(mm[1]);
      if (a.key) meta[a.key] = a.value;
    }
    const filaments = [];
    const filRe = /<filament\s+([^>]*?)\/>/g;
    while ((mm = filRe.exec(body))) filaments.push(xmlAttrs(mm[1]));
    const index = parseInt(meta.index, 10);
    if (index) plates[index] = { meta, filaments };
  }
  return plates;
}

/**
 * Analizza un .gcode.3mf: estrae il G-code del primo piatto in `gcodePath`
 * e ritorna { plate, gcodeEntry, thumbnail (Buffer PNG), slicer: {...} }.
 */
async function extractPlate(filePath, gcodePath) {
  const entries = listEntries(filePath);
  const gcodes = entries
    .map((e) => ({ e, m: /^Metadata\/plate_(\d+)\.gcode$/i.exec(e.name) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  if (!gcodes.length) {
    throw new Error('Questo 3MF non contiene G-code: in Bambu Studio o OrcaSlicer usa "Esporta il G-code del piatto" per ottenere un file .gcode.3mf.');
  }
  const plate = Number(gcodes[0].m[1]);
  await extractEntry(filePath, gcodes[0].e, gcodePath);

  let thumbnail = null;
  const png = entries.find((e) => e.name.toLowerCase() === `metadata/plate_${plate}.png`);
  if (png) thumbnail = await readEntry(filePath, png).catch(() => null);

  let slicer = null;
  const info = entries.find((e) => e.name.toLowerCase() === 'metadata/slice_info.config');
  if (info) {
    const xml = (await readEntry(filePath, info).catch(() => Buffer.alloc(0))).toString('utf8');
    const plates = parseSliceInfo(xml);
    const p = plates[plate];
    if (p) {
      const grams = p.filaments.reduce((s, f) => s + (parseFloat(f.used_g) || 0), 0);
      const meters = p.filaments.reduce((s, f) => s + (parseFloat(f.used_m) || 0), 0);
      slicer = {
        estimatedTime: parseInt(p.meta.prediction, 10) || null,
        filamentWeight: grams || parseFloat(p.meta.weight) || null,
        filamentLength: meters ? meters * 1000 : null,
        filamentCount: p.filaments.length || null,
        material: p.filaments.length ? [...new Set(p.filaments.map((f) => f.type).filter(Boolean))].join(', ') : null,
        colors: p.filaments.map((f) => f.color).filter(Boolean),
      };
    }
  }
  return { plate, plates: gcodes.length, thumbnail, slicer };
}

module.exports = { listEntries, extractPlate, parseSliceInfo, readEntry };
