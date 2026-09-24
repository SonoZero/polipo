'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeMoonraker, startFakePrusaLink, startFakeOctoPrint } = require('./fakes/http-printers');
const { createPrinter } = require('../src/server/printers');
const { sanitizeConfig } = require('../src/server/manager');
const { identify, bambuFromSsdp, discoverPrinters } = require('../src/server/discovery');
const { requestOctoPrintKey } = require('../src/server/printers/octoprint');
const dgram = require('dgram');

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

function make(type, net) {
  const p = createPrinter(sanitizeConfig({ id: type, type, name: type, net: { host: '127.0.0.1', ...net } }, 0), {});
  const ended = [];
  p.on('job-ended', (j) => ended.push(j));
  return { p, ended };
}

function gcodeFile(name = 'pezzo.gcode') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoprint-net-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'G28\nG1 X10 Y10\n'.repeat(5000));
  return { name, path: f, size: fs.statSync(f).size, meta: { estimatedTime: 400 } };
}

test('Klipper: stato, comandi, stampa e aggiornamenti', async () => {
  const fake = await startFakeMoonraker();
  const { p, ended } = make('klipper', { port: fake.port });
  try {
    await p.connect();
    await until(() => p.state === 'operational');
    assert.strictEqual(p.firmware.name, 'Klipper');
    assert.strictEqual(p.temps.tools.T0.actual, 24.5);
    await until(() => p.extra.webcam);
    assert.match(p.extra.webcam.stream, /^http:\/\/127\.0\.0\.1\/webcam\/\?action=stream$/);

    await p.setTemperature('T0', 205);
    await until(() => p.temps.tools.T0.target === 205);
    await p.jog({ x: 10 });
    assert.ok(fake.state.gcode.some((g) => /G1 X10/.test(g)));

    const file = gcodeFile();
    p.startPrint(file);
    await until(() => ended.length === 1, 10000);
    assert.strictEqual(ended[0].result, 'done');
    assert.strictEqual(fake.state.files.get('pezzo.gcode'), file.size, 'file caricato intero');

    p.startPrint(file);
    await until(() => p.state === 'printing' && p.job && p.job.progress > 0);
    await p.pause();
    await until(() => p.state === 'paused');
    await p.resume();
    await until(() => p.state === 'printing');
    await p.cancel();
    await until(() => ended.length === 2);
    assert.strictEqual(ended[1].result, 'cancelled');

    const info = await p.firmwareInfo(false);
    const klipper = info.components.find((c) => c.name === 'klipper');
    assert.strictEqual(klipper.available, true);
    assert.strictEqual(info.components.find((c) => c.name === 'mainsail').available, false);
    assert.strictEqual(info.components.find((c) => c.name === 'system').updates, 3);
    await p.installFirmware('klipper');
    assert.deepStrictEqual(fake.state.upgrades, ['klipper']);
    assert.strictEqual(p.task.status, 'done');
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('Klipper: arresto di emergenza porta Klipper in shutdown', async () => {
  const fake = await startFakeMoonraker();
  const { p } = make('klipper', { port: fake.port });
  try {
    await p.connect();
    await until(() => p.state === 'operational');
    await p.emergencyStop();
    await until(() => p.state === 'error');
    assert.match(p.error, /arresto/);
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('PrusaLink: autenticazione Digest, invio con avvio automatico e fine stampa', async () => {
  const fake = await startFakePrusaLink({ stepMs: 700 });
  const { p, ended } = make('prusalink', { port: fake.port, password: fake.password });
  try {
    await p.connect();
    await until(() => p.state === 'operational');
    assert.strictEqual(p.firmware.version, '6.1.3+8103');
    assert.strictEqual(p.temps.tools.T0.actual, 215.2);
    const file = gcodeFile('benchy.gcode');
    p.startPrint(file);
    await until(() => p.state === 'printing' && p.job && p.job.file === 'benchy.gcode', 8000);
    await until(() => ended.length === 1, 10000);
    assert.strictEqual(ended[0].result, 'done');
    assert.strictEqual(fake.state.files.get('benchy.gcode'), file.size);
    assert.throws(() => p.setTemperature('T0', 200), /non disponibile/);
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('PrusaLink: password sbagliata', async () => {
  const fake = await startFakePrusaLink();
  const { p } = make('prusalink', { port: fake.port, password: 'errata' });
  try {
    await assert.rejects(p.connect(), /password di PrusaLink sbagliati/);
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('OctoPrint: chiave dall\'app, temperature, stampa, annullamento e aggiornamenti', async () => {
  const fake = await startFakeOctoPrint({ stepMs: 700 });
  const key = await requestOctoPrintKey('127.0.0.1', fake.port);
  assert.strictEqual(key, fake.apiKey);
  const { p, ended } = make('octoprint', { port: fake.port, apiKey: key });
  try {
    await p.connect();
    await until(() => p.state === 'operational');
    assert.strictEqual(p.firmware.version, '1.10.3');
    await p.setTemperature('T0', 210);
    await p.setTemperature('bed', 65);
    assert.deepStrictEqual(fake.state.targets, { tool0: 210, bed: 65 });
    await p.home(['x', 'y']);
    assert.deepStrictEqual(fake.state.commands[0], { command: 'home', axes: ['x', 'y'] });

    const file = gcodeFile();
    p.startPrint(file);
    await until(() => ended.length === 1, 10000);
    assert.strictEqual(ended[0].result, 'done');

    p.startPrint(file);
    await until(() => p.state === 'printing' && p.job && p.job.progress > 0, 8000);
    await p.cancel();
    await until(() => ended.length === 2);
    assert.strictEqual(ended[1].result, 'cancelled');

    const info = await p.firmwareInfo(false);
    assert.strictEqual(info.components[0].available, true);
    await p.installFirmware('full');
    assert.deepStrictEqual(fake.state.updates, [['octoprint']]);
  } finally {
    await p.destroy();
    await fake.close();
  }
});

test('ricerca: riconosce Klipper, PrusaLink, OctoPrint e gli annunci Bambu', async () => {
  const k = await startFakeMoonraker();
  const pl = await startFakePrusaLink();
  const op = await startFakeOctoPrint();
  try {
    assert.strictEqual((await identify('127.0.0.1', k.port)).type, 'klipper');
    assert.strictEqual((await identify('127.0.0.1', pl.port)).type, 'prusalink');
    assert.strictEqual((await identify('127.0.0.1', op.port)).type, 'octoprint');
  } finally {
    await Promise.all([k.close(), pl.close(), op.close()]);
  }

  const notify = [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1990',
    'Location: 192.168.1.77',
    'NT: urn:bambulab-com:device:3dprinter:1',
    'USN: 01S00C123456789',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Officina',
    'DevConnect.bambu.com: lan',
    '', '',
  ].join('\r\n');
  const parsed = bambuFromSsdp(notify, '192.168.1.77');
  assert.deepStrictEqual(
    { host: parsed.host, serial: parsed.serial, model: parsed.model, name: parsed.name, lanMode: parsed.lanMode },
    { host: '192.168.1.77', serial: '01S00C123456789', model: 'Bambu Lab P1S', name: 'Officina', lanMode: true },
  );

  // annuncio SSDP ricevuto davvero su una porta UDP
  const port = 20000 + Math.floor(Math.random() * 20000);
  const found = discoverPrinters({ timeout: 1200, scan: false, ssdpPorts: [port] });
  setTimeout(() => {
    const s = dgram.createSocket('udp4');
    s.send(Buffer.from(notify), port, '127.0.0.1', () => s.close());
  }, 300);
  const list = await found;
  assert.ok(list.some((r) => r.type === 'bambu' && r.serial === '01S00C123456789'));
});
