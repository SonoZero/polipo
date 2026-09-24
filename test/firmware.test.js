'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { flashHex, parseIntelHex } = require('../src/server/firmware/avr');
const { compareVersions } = require('../src/server/firmware/releases');
const { FileStore } = require('../src/server/files');

// --- file Intel HEX ------------------------------------------------------------------

function toHex(buf) {
  const lines = [];
  const rec = (type, addr, data) => {
    const bytes = [data.length, (addr >> 8) & 255, addr & 255, type, ...data];
    const sum = (256 - (bytes.reduce((a, b) => a + b, 0) & 255)) & 255;
    lines.push(':' + Buffer.from([...bytes, sum]).toString('hex').toUpperCase());
  };
  for (let off = 0; off < buf.length; off += 16) {
    if (off % 65536 === 0) rec(4, 0, [(off >> 24) & 255, (off >> 16) & 255]);
    rec(0, off & 0xffff, [...buf.subarray(off, off + 16)]);
  }
  rec(1, 0, []);
  return lines.join('\r\n') + '\r\n';
}

// --- bootloader finti ----------------------------------------------------------------

class FakePort extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
  }

  write(data, cb) {
    setImmediate(() => {
      const out = this.handler(Buffer.from(data));
      if (out) this.emit('data', out);
    });
    cb && cb();
  }

  drain(cb) { cb && cb(); }
  set(opts, cb) { cb && cb(); }
  close(cb) { cb && cb(); }
}

function stk500v2Board(signature, flashSize) {
  const flash = Buffer.alloc(flashSize, 0xff);
  let addr = 0;
  let pending = Buffer.alloc(0);
  return {
    flash,
    handle(data) {
      pending = Buffer.concat([pending, data]);
      if (pending.length < 5 || pending[0] !== 0x1b) { pending = Buffer.alloc(0); return null; }
      const size = (pending[2] << 8) | pending[3];
      if (pending.length < size + 6) return null;
      const seq = pending[1];
      const body = pending.subarray(5, 5 + size);
      pending = pending.subarray(size + 6);
      let answer;
      switch (body[0]) {
        case 0x01: answer = [0x01, 0x00, 8, ...Buffer.from('AVRISP_2')]; break;
        case 0x10: case 0x11: answer = [body[0], 0x00]; break;
        case 0x1b: answer = [0x1b, 0x00, signature[body[4]], 0x00]; break;
        case 0x06: {
          const w = ((body[1] & 0x7f) << 24) | (body[2] << 16) | (body[3] << 8) | body[4];
          addr = w * 2;
          answer = [0x06, 0x00];
          break;
        }
        case 0x13: {
          const n = (body[1] << 8) | body[2];
          body.subarray(10, 10 + n).copy(flash, addr);
          addr += n;
          answer = [0x13, 0x00];
          break;
        }
        case 0x14: {
          const n = (body[1] << 8) | body[2];
          answer = [0x14, 0x00, ...flash.subarray(addr, addr + n), 0x00];
          addr += n;
          break;
        }
        default: answer = [body[0], 0xc0];
      }
      const len = answer.length;
      const msg = Buffer.alloc(len + 6);
      msg[0] = 0x1b; msg[1] = seq; msg[2] = len >> 8; msg[3] = len & 255; msg[4] = 0x0e;
      Buffer.from(answer).copy(msg, 5);
      let cs = 0;
      for (let i = 0; i < len + 5; i++) cs ^= msg[i];
      msg[len + 5] = cs;
      return msg;
    },
  };
}

function stk500v1Board(signature, flashSize) {
  const flash = Buffer.alloc(flashSize, 0xff);
  let addr = 0;
  let pending = Buffer.alloc(0);
  return {
    flash,
    handle(data) {
      pending = Buffer.concat([pending, data]);
      const lens = { 0x30: 1, 0x50: 1, 0x51: 1, 0x75: 1, 0x55: 3, 0x74: 4 };
      // byte sconosciuti (per esempio pacchetti STK500v2): come optiboot, li scarta
      if (!(pending[0] in lens) && pending[0] !== 0x64) { pending = Buffer.alloc(0); return null; }
      const len = pending[0] === 0x64 ? 4 + ((pending[1] << 8) | pending[2]) : lens[pending[0]] || 1;
      if (pending.length < len + 1) return null;
      const cmd = pending.subarray(0, len);
      pending = pending.subarray(len + 1);
      const ok = (extra = []) => Buffer.from([0x14, ...extra, 0x10]);
      switch (cmd[0]) {
        case 0x30: case 0x50: case 0x51: return ok();
        case 0x75: return ok(signature);
        case 0x55: addr = (cmd[1] | (cmd[2] << 8)) * 2; return ok();
        case 0x64: {
          const n = (cmd[1] << 8) | cmd[2];
          cmd.subarray(4, 4 + n).copy(flash, addr);
          return ok();
        }
        case 0x74: {
          const n = (cmd[1] << 8) | cmd[2];
          return ok([...flash.subarray(addr, addr + n)]);
        }
        default: return Buffer.from([0x15]);
      }
    },
  };
}

test('Intel HEX: lettura, checksum e indirizzi estesi', () => {
  const data = crypto.randomBytes(70000);
  const parsed = parseIntelHex(toHex(data));
  assert.strictEqual(parsed.size, data.length);
  assert.ok(parsed.image.equals(data));
  assert.throws(() => parseIntelHex(':0400000001020304F0\n:00000001FF'), /danneggiato/);
  assert.throws(() => parseIntelHex('ciao'), /non è un firmware/);
});

test('firmware .hex su ATmega2560 (STK500v2) con verifica', async () => {
  const board = stk500v2Board([0x1e, 0x98, 0x01], 256 * 1024);
  const image = crypto.randomBytes(140 * 1024); // oltre i 128 KB: serve l'indirizzamento esteso
  const steps = [];
  const result = await flashHex({
    path: 'COM9',
    hex: toHex(image),
    openPort: async () => new FakePort((d) => board.handle(d)),
    onProgress: (p) => steps.push(p.step),
  });
  assert.strictEqual(result.device, 'ATmega2560');
  assert.ok(board.flash.subarray(0, image.length).equals(image));
  assert.ok(steps.includes('write') && steps.includes('verify'));
});

test('firmware .hex su ATmega1284P con optiboot (STK500v1)', async () => {
  const board = stk500v1Board([0x1e, 0x97, 0x05], 128 * 1024);
  const image = crypto.randomBytes(90 * 1024);
  const bauds = [];
  const result = await flashHex({
    path: 'COM9',
    hex: toHex(image),
    openPort: async (p, baud) => {
      bauds.push(baud);
      // al primo tentativo (STK500v2) la scheda non risponde
      return new FakePort((d) => (bauds.length === 1 ? null : board.handle(d)));
    },
  });
  assert.strictEqual(result.device, 'ATmega1284P');
  assert.strictEqual(result.protocol, 'stk500v1');
  assert.ok(board.flash.subarray(0, image.length).equals(image));
});

test('firmware .hex: scheda senza bootloader e firmware troppo grande', async () => {
  await assert.rejects(flashHex({
    path: 'COM9',
    hex: toHex(crypto.randomBytes(1000)),
    openPort: async () => new FakePort(() => null),
  }), /non risponde al bootloader/);

  const board = stk500v1Board([0x1e, 0x95, 0x0f], 32 * 1024);
  await assert.rejects(flashHex({
    path: 'COM9',
    hex: toHex(crypto.randomBytes(40 * 1024)),
    openPort: async (p, baud) => new FakePort((d) => board.handle(d)),
  }), /troppo grande/);
});

test('confronto delle versioni', () => {
  assert.ok(compareVersions('2.1.2.5', '2.0.9.3') > 0);
  assert.ok(compareVersions('6.2.4', '6.2.4+8103') === 0);
  assert.ok(compareVersions('v6.1.0', '6.2.0') < 0);
});

// --- progetti .gcode.3mf -------------------------------------------------------------

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const data = Buffer.from(content);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function waitAnalyzed(store, name) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 8000);
    const check = () => {
      const f = store.list().find((x) => x.name === name);
      if (f && !f.analyzing && f.meta) { clearTimeout(t); store.off('changed', check); resolve(f); }
    };
    store.on('changed', check);
    check();
  });
}

test('progetto .gcode.3mf: G-code del piatto, miniatura e stime dello slicer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoprint-3mf-'));
  const store = new FileStore(dir);
  store.init();
  const gcode = '; generated by BambuStudio\n;LAYER_CHANGE\nG1 Z0.2 F600\nG1 X10 Y10 E1\n;LAYER_CHANGE\nG1 Z0.4\nG1 X20 Y20 E2\n';
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const info = '<?xml version="1.0"?><config><plate><metadata key="index" value="1"/><metadata key="prediction" value="1234"/><metadata key="weight" value="3.5"/>'
    + '<filament id="1" type="PETG" color="#FF0000" used_m="1.25" used_g="3.5"/></plate></config>';
  const file = zip([
    ['[Content_Types].xml', '<Types/>', false],
    ['Metadata/plate_1.gcode', gcode, true],
    ['Metadata/plate_1.png', png, false],
    ['Metadata/slice_info.config', info, true],
  ]);
  const name = await store.add('cubo.gcode.3mf', Readable.from([file]));
  const f = await waitAnalyzed(store, name);
  assert.strictEqual(f.kind, '3mf');
  assert.strictEqual(f.meta.plate, 1);
  assert.strictEqual(f.meta.estimatedTime, 1234);
  assert.strictEqual(f.meta.material, 'PETG');
  assert.strictEqual(f.meta.filamentCount, 1);
  assert.ok(f.hasThumb);
  const got = store.get(name);
  assert.strictEqual(fs.readFileSync(got.gcodePath, 'utf8'), gcode);

  await assert.rejects(store.add('vuoto.3mf', Readable.from([zip([['3D/3dmodel.model', '<model/>', true]])])).then(() => waitAnalyzed(store, 'vuoto.3mf')).then((x) => {
    if (x.meta && x.meta.error) throw new Error(x.meta.error);
  }), /non contiene G-code/);
  store.flush();
});
