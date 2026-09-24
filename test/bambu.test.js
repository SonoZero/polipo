'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeBambu, SERIAL } = require('./fakes/bambu');
const { BambuPrinter } = require('../src/server/printers/bambu');
const { sanitizeConfig } = require('../src/server/manager');

function until(fn, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let ok = false;
      try { ok = fn(); } catch (_) { ok = false; }
      if (ok) { clearInterval(t); resolve(); } else if (Date.now() - start > timeout) { clearInterval(t); reject(new Error('timeout')); }
    }, 25);
  });
}

function makePrinter(fake, net = {}) {
  const cfg = sanitizeConfig({
    id: 'b1', type: 'bambu', name: 'P1S di prova',
    net: { host: '127.0.0.1', port: fake.mqttPort, accessCode: fake.accessCode, ...net },
  }, 0);
  const p = new BambuPrinter(cfg, { bambuPorts: { ftp: fake.ftpPort, camera: fake.cameraPort } });
  const patches = [];
  p.on('config-patch', (x) => patches.push(x));
  const notes = [];
  p.on('notify', (n) => notes.push(n));
  const ended = [];
  p.on('job-ended', (j) => ended.push(j));
  return { p, patches, notes, ended };
}

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoprint-bambu-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

test('Bambu: connessione, numero di serie dal certificato e stato', async () => {
  const fake = await startFakeBambu();
  const { p, patches } = makePrinter(fake);
  try {
    await p.connect();
    await until(() => p.state === 'operational' && p.firmware && p.firmware.version);
    assert.strictEqual(p.config.net.serial, SERIAL, 'il numero di serie arriva dal certificato');
    assert.ok(p.config.net.tlsFingerprint, 'certificato non firmato da Bambu: memorizzato');
    assert.ok(patches.length >= 1);
    assert.strictEqual(p.firmware.version, '01.08.02.00');
    assert.strictEqual(p.extra.model, 'Bambu Lab P1S');
    assert.strictEqual(p.temps.tools.T0.actual, 25);
    assert.ok(p.extra.ams && p.extra.ams[0].trays[0].color === '#FF6A00');

    await p.setTemperature('T0', 210);
    await p.setTemperature('bed', 60);
    await until(() => p.temps.tools.T0.target === 210 && p.temps.bed.target === 60);
    p.setLight(true);
    await until(() => fake.state.report.lights_report[0].mode === 'on');
    p.setSpeedLevel(3);
    await until(() => p.extra.speedLevel === 3);

    const frames = [];
    const stop = p.watchCamera((f) => frames.push(f));
    await until(() => frames.length >= 2);
    stop();
    assert.strictEqual(frames[0][0], 0xff);
    assert.strictEqual(frames[0][1], 0xd8);
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('Bambu: codice di accesso sbagliato', async () => {
  const fake = await startFakeBambu();
  const { p } = makePrinter(fake, { accessCode: '00000000' });
  try {
    await assert.rejects(p.connect(), /Codice di accesso sbagliato/);
    assert.strictEqual(p.state, 'error');
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('Bambu: invio del 3MF via FTPS, stampa completa e annullamento', async () => {
  const fake = await startFakeBambu();
  const { p, ended } = makePrinter(fake);
  try {
    await p.connect();
    await until(() => p.state === 'operational');
    const content = Buffer.alloc(300 * 1024, 42);
    const file = { name: 'cubo di prova.gcode.3mf', path: tmpFile('cubo di prova.gcode.3mf', content), meta: { plate: 1, filamentCount: 1 } };
    p.startPrint(file);
    assert.strictEqual(p.state, 'sending');
    await until(() => ended.length === 1, 15000);
    assert.strictEqual(ended[0].result, 'done');
    assert.strictEqual(fake.state.files.get('cubo di prova.gcode.3mf').length, content.length, 'file arrivato intero');
    const cmd = fake.state.requests.find((r) => r.print && r.print.command === 'project_file').print;
    assert.strictEqual(cmd.url, 'file:///sdcard/cubo di prova.gcode.3mf');
    assert.strictEqual(cmd.param, 'Metadata/plate_1.gcode');
    assert.strictEqual(p.state, 'operational');

    p.startPrint(file);
    await until(() => p.state === 'printing' && p.job && p.job.progress > 0);
    p.cancel();
    await until(() => ended.length === 2);
    assert.strictEqual(ended[1].result, 'cancelled');
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('Bambu: comando rifiutato senza modalità sviluppatore', async () => {
  const fake = await startFakeBambu();
  const { p, notes } = makePrinter(fake);
  try {
    await p.connect();
    await until(() => p.state === 'operational');
    fake.state.refuse = true;
    p.startPrint({ name: 'a.gcode.3mf', path: tmpFile('a.gcode.3mf', 'x'), meta: { plate: 1 } });
    await until(() => notes.some((n) => /Modalità sviluppatore/.test(n.message)));
    await until(() => p.state === 'operational');
    assert.strictEqual(p.job, null);
  } finally {
    await p.destroy();
    await fake.close();
  }
});
