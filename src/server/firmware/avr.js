'use strict';

// Scrittura del firmware (.hex) sulle schede a 8 bit tramite il bootloader, via USB:
// STK500v2 (ATmega2560: Anycubic Trigorilla, RAMPS, Einsy) e STK500v1 / optiboot
// (ATmega1284P e ATmega328P con bootloader). Ogni pagina scritta viene riletta e verificata.

const DEVICES = {
  '1e9801': { name: 'ATmega2560', flash: 256 * 1024, page: 256, boot: 8 * 1024 },
  '1e9703': { name: 'ATmega1280', flash: 128 * 1024, page: 256, boot: 4 * 1024 },
  '1e9705': { name: 'ATmega1284P', flash: 128 * 1024, page: 256, boot: 1024 },
  '1e960a': { name: 'ATmega644P', flash: 64 * 1024, page: 256, boot: 1024 },
  '1e950f': { name: 'ATmega328P', flash: 32 * 1024, page: 128, boot: 512 },
};

// --- file Intel HEX -------------------------------------------------------------------

function parseIntelHex(text) {
  let base = 0;
  let end = 0;
  let dataBytes = 0;
  const records = [];
  const lines = String(text).split(/\r?\n/);
  let eof = false;
  for (let i = 0; i < lines.length && !eof; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line[0] !== ':' || !/^:[0-9a-fA-F]+$/.test(line) || line.length % 2 === 0) {
      throw new Error(`Il file non è un firmware .hex valido (riga ${i + 1}).`);
    }
    const bytes = Buffer.from(line.slice(1), 'hex');
    const len = bytes[0];
    if (bytes.length !== len + 5) throw new Error(`Riga ${i + 1} del file .hex incompleta.`);
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new Error(`Il file .hex è danneggiato (checksum sbagliato alla riga ${i + 1}).`);
    const addr = bytes.readUInt16BE(1);
    const type = bytes[3];
    const data = bytes.subarray(4, 4 + len);
    if (type === 0) {
      const abs = base + addr;
      records.push({ abs, data });
      end = Math.max(end, abs + len);
      dataBytes += len;
    } else if (type === 1) {
      eof = true;
    } else if (type === 2) {
      base = data.readUInt16BE(0) << 4;
    } else if (type === 4) {
      base = data.readUInt16BE(0) * 65536;
    }
  }
  if (!eof) throw new Error('Il file .hex è incompleto (manca la riga finale).');
  if (!dataBytes) throw new Error('Il file .hex non contiene dati.');
  const image = Buffer.alloc(end, 0xff);
  for (const r of records) r.data.copy(image, r.abs);
  return { image, size: end, dataBytes };
}

// --- porta seriale ------------------------------------------------------------------

class SerialLink {
  constructor(port) {
    this.port = port;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    port.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (this.waiter) this.waiter();
    });
  }

  write(data) {
    return new Promise((resolve, reject) => {
      this.port.write(data, (err) => (err ? reject(err) : this.port.drain((e) => (e ? reject(e) : resolve()))));
    });
  }

  drainInput() {
    this.buf = Buffer.alloc(0);
  }

  /** Aspetta che nel buffer ci sia qualcosa che `parse` sa interpretare. */
  read(parse, timeout) {
    return new Promise((resolve, reject) => {
      const tryParse = () => {
        let r;
        try { r = parse(this.buf); } catch (err) { finish(); reject(err); return; }
        if (r) {
          this.buf = this.buf.subarray(r.consumed);
          finish();
          resolve(r.value);
        }
      };
      const timer = setTimeout(() => { finish(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })); }, timeout);
      const finish = () => { clearTimeout(timer); this.waiter = null; };
      this.waiter = tryParse;
      tryParse();
    });
  }

  setLines(opts) {
    return new Promise((resolve) => this.port.set(opts, () => resolve()));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Riavvia la scheda come fa l'IDE di Arduino (DTR/RTS): il bootloader resta in ascolto per un attimo. */
async function resetBoard(link) {
  await link.setLines({ dtr: false, rts: false });
  await sleep(250);
  await link.setLines({ dtr: true, rts: true });
  await sleep(50);
  await link.setLines({ dtr: false, rts: false });
  await sleep(50);
  link.drainInput();
}

// --- STK500v2 -----------------------------------------------------------------------

const V2 = {
  SIGN_ON: 0x01, LOAD_ADDRESS: 0x06, ENTER_PROGMODE: 0x10, LEAVE_PROGMODE: 0x11,
  PROGRAM_FLASH: 0x13, READ_FLASH: 0x14, READ_SIGNATURE: 0x1b, OK: 0x00,
};

class Stk500v2 {
  constructor(link) {
    this.link = link;
    this.seq = 0;
  }

  async cmd(body, timeout = 1000) {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    const len = body.length;
    const msg = Buffer.alloc(len + 6);
    msg[0] = 0x1b;
    msg[1] = seq;
    msg[2] = len >> 8;
    msg[3] = len & 0xff;
    msg[4] = 0x0e;
    Buffer.from(body).copy(msg, 5);
    let cs = 0;
    for (let i = 0; i < len + 5; i++) cs ^= msg[i];
    msg[len + 5] = cs;
    await this.link.write(msg);
    const answer = await this.link.read((buf) => {
      const start = buf.indexOf(0x1b);
      if (start < 0) return null;
      if (buf.length < start + 5) return null;
      const size = (buf[start + 2] << 8) | buf[start + 3];
      if (buf[start + 4] !== 0x0e) throw new Error('Risposta del bootloader non valida.');
      const total = size + 6;
      if (buf.length < start + total) return null;
      let c = 0;
      for (let i = start; i < start + total; i++) c ^= buf[i];
      if (c !== 0) throw new Error('Risposta del bootloader danneggiata (checksum).');
      if (buf[start + 1] !== seq) throw new Error('Risposta del bootloader fuori sequenza.');
      return { consumed: start + total, value: buf.subarray(start + 5, start + 5 + size) };
    }, timeout);
    if (answer[0] !== body[0] || answer[1] !== V2.OK) {
      throw new Error(`Il bootloader ha rifiutato il comando 0x${body[0].toString(16)} (stato 0x${(answer[1] || 0).toString(16)}).`);
    }
    return answer;
  }

  async signOn(attempts = 8) {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await this.cmd([V2.SIGN_ON], 400);
        return r.subarray(3, 3 + r[2]).toString('ascii');
      } catch (err) {
        this.link.drainInput();
        if (err.code !== 'ETIMEOUT' && i === attempts - 1) throw err;
      }
    }
    throw Object.assign(new Error('Il bootloader STK500v2 non risponde.'), { code: 'NOSYNC' });
  }

  async enterProgMode() {
    await this.cmd([V2.ENTER_PROGMODE, 200, 100, 25, 32, 0, 0x53, 3, 0xac, 0x53, 0, 0]);
  }

  async leaveProgMode() {
    await this.cmd([V2.LEAVE_PROGMODE, 1, 1]);
  }

  async signature() {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const r = await this.cmd([V2.READ_SIGNATURE, 4, 0x30, 0, i, 0]);
      out.push(r[2]);
    }
    return Buffer.from(out).toString('hex');
  }

  async loadAddress(byteAddr, extended) {
    const w = byteAddr >>> 1;
    await this.cmd([V2.LOAD_ADDRESS, ((w >>> 24) & 0xff) | (extended ? 0x80 : 0), (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff]);
  }

  async writePage(data) {
    const n = data.length;
    await this.cmd([V2.PROGRAM_FLASH, n >> 8, n & 0xff, 0xc1, 0x0a, 0x40, 0x4c, 0x20, 0, 0, ...data], 3000);
  }

  async readPage(n) {
    const r = await this.cmd([V2.READ_FLASH, n >> 8, n & 0xff, 0x20], 3000);
    return r.subarray(2, 2 + n);
  }
}

// --- STK500v1 (optiboot) ------------------------------------------------------------

const V1 = { INSYNC: 0x14, OK: 0x10, EOP: 0x20 };

class Stk500v1 {
  constructor(link) {
    this.link = link;
  }

  async cmd(bytes, replyLen = 0, timeout = 1000) {
    await this.link.write(Buffer.from([...bytes, V1.EOP]));
    const value = await this.link.read((buf) => {
      if (buf.length < replyLen + 2) return null;
      if (buf[0] !== V1.INSYNC) throw Object.assign(new Error('Bootloader fuori sincronia.'), { code: 'NOSYNC' });
      if (buf[replyLen + 1] !== V1.OK) throw new Error('Il bootloader ha rifiutato il comando.');
      return { consumed: replyLen + 2, value: Buffer.from(buf.subarray(1, 1 + replyLen)) };
    }, timeout);
    return value;
  }

  async sync(attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.cmd([0x30], 0, 300);
        return;
      } catch (_) {
        this.link.drainInput();
      }
    }
    throw Object.assign(new Error('Il bootloader STK500v1 non risponde.'), { code: 'NOSYNC' });
  }

  async signature() {
    return (await this.cmd([0x75], 3)).toString('hex');
  }

  async enterProgMode() { await this.cmd([0x50]); }
  async leaveProgMode() { await this.cmd([0x51]); }

  async loadAddress(byteAddr) {
    const w = byteAddr >>> 1;
    await this.cmd([0x55, w & 0xff, (w >> 8) & 0xff]);
  }

  async writePage(data) {
    await this.cmd([0x64, data.length >> 8, data.length & 0xff, 0x46, ...data], 0, 3000);
  }

  async readPage(n) {
    return this.cmd([0x74, n >> 8, n & 0xff, 0x46], n, 3000);
  }
}

// --- scrittura ------------------------------------------------------------------------

/**
 * Scrive un firmware .hex sulla scheda collegata a `path`.
 * @param {object} o { path, hex (testo), onProgress({ step, progress, message }), openPort(path, baud) }
 */
async function flashHex(o) {
  const { image, size } = parseIntelHex(o.hex);
  const report = o.onProgress || (() => {});
  const attempts = [
    { protocol: 'stk500v2', baud: 115200 },
    { protocol: 'stk500v1', baud: 115200 },
    { protocol: 'stk500v1', baud: 57600 },
  ];
  let lastErr = null;
  for (const a of attempts) {
    report({ step: 'connect', progress: null, message: `Ricerca del bootloader (${a.protocol === 'stk500v2' ? 'ATmega2560' : 'optiboot'}, ${a.baud} baud)...` });
    const port = await o.openPort(o.path, a.baud);
    const link = new SerialLink(port);
    try {
      await resetBoard(link);
      const prog = a.protocol === 'stk500v2' ? new Stk500v2(link) : new Stk500v1(link);
      if (a.protocol === 'stk500v2') await prog.signOn();
      else await prog.sync();
      await prog.enterProgMode();
      const sig = await prog.signature();
      const dev = DEVICES[sig];
      if (!dev) {
        await prog.leaveProgMode().catch(() => {});
        throw Object.assign(new Error(`Microcontrollore sconosciuto (firma ${sig}): SonoPrint non lo sa programmare.`), { fatal: true });
      }
      if (size > dev.flash - dev.boot) {
        await prog.leaveProgMode().catch(() => {});
        throw Object.assign(new Error(`Il firmware è troppo grande per ${dev.name} (${size} byte): forse è per un'altra scheda o contiene anche il bootloader.`), { fatal: true });
      }
      const extended = dev.flash > 128 * 1024;
      const pages = Math.ceil(size / dev.page);
      report({ step: 'write', progress: 0, message: `Scrittura su ${dev.name}...`, device: dev.name });
      await prog.loadAddress(0, extended);
      for (let i = 0; i < pages; i++) {
        const page = Buffer.alloc(dev.page, 0xff);
        image.copy(page, 0, i * dev.page, Math.min(size, (i + 1) * dev.page));
        if (a.protocol === 'stk500v1') await prog.loadAddress(i * dev.page, extended);
        await prog.writePage(page);
        if (i % 4 === 0 || i === pages - 1) report({ step: 'write', progress: (i + 1) / pages / 2, message: `Scrittura su ${dev.name}...` });
      }
      report({ step: 'verify', progress: 0.5, message: 'Verifica...' });
      await prog.loadAddress(0, extended);
      for (let i = 0; i < pages; i++) {
        if (a.protocol === 'stk500v1') await prog.loadAddress(i * dev.page, extended);
        const got = await prog.readPage(dev.page);
        const want = Buffer.alloc(dev.page, 0xff);
        image.copy(want, 0, i * dev.page, Math.min(size, (i + 1) * dev.page));
        if (!got.equals(want)) {
          throw Object.assign(new Error(`Verifica non riuscita all'indirizzo 0x${(i * dev.page).toString(16)}: la scheda non contiene quello che è stato scritto. Riprova (il bootloader non viene toccato).`), { fatal: true });
        }
        if (i % 4 === 0 || i === pages - 1) report({ step: 'verify', progress: 0.5 + (i + 1) / pages / 2, message: 'Verifica...' });
      }
      await prog.leaveProgMode();
      return { device: dev.name, protocol: a.protocol, bytes: size };
    } catch (err) {
      lastErr = err;
      if (err.fatal || err.code !== 'NOSYNC') throw err;
    } finally {
      await new Promise((r) => port.close(() => r()));
    }
  }
  const e = new Error('La scheda non risponde al bootloader. Le schede a 32 bit (Creality 4.2.x, BTT SKR...) si aggiornano con un file .bin sulla scheda SD; alcune schede a 8 bit (come le Melzi delle Ender-3 più vecchie) non hanno il bootloader e vanno programmate con un programmatore ISP.');
  e.cause = lastErr;
  throw e;
}

module.exports = { parseIntelHex, flashHex, Stk500v1, Stk500v2, SerialLink, DEVICES };
