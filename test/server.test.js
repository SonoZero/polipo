'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');
const { startServer } = require('../src/server');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sonoprint-srv-'));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return null;
}

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('accesso locale con token e protezione dell\'host', async () => {
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    assert.strictEqual((await call(`${base}/api/printers`)).status, 401);
    assert.strictEqual((await call(`${base}/api/printers`, { headers: { 'X-SonoPrint-Token': srv.token } })).status, 200);
    // la chiave del telefono non funziona finché l'accesso remoto è spento
    const key = srv.manager.settings.remote.key;
    const r = await call(`${base}/api/printers`, { headers: { 'X-SonoPrint-Key': key } });
    assert.strictEqual(r.status, 401);
    assert.match(r.data.error, /disattivato/);
    // DNS rebinding: pagina e API rifiutate con un Host diverso da localhost
    const page = await new Promise((resolve) => {
      require('http').get({ host: '127.0.0.1', port: srv.port, path: '/', headers: { Host: 'evil.example:80' } }, resolve);
    });
    assert.strictEqual(page.statusCode, 403);
    // le impostazioni non contengono mai la chiave
    const s = await call(`${base}/api/settings`, { headers: { 'X-SonoPrint-Token': srv.token } });
    assert.deepStrictEqual(s.data.remote, { enabled: false });
    assert.ok(!JSON.stringify(s.data).includes(key));
  } finally {
    await srv.close();
  }
});

test('accesso dal telefono con la chiave', async () => {
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    const r1 = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { developer: true, remote: { enabled: true } } });
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(r1.data.remote, { enabled: true });
    await sleep(900); // il server si riapre su tutte le interfacce

    const pairing = await call(`${base}/api/remote`, { headers: T });
    assert.strictEqual(pairing.status, 200);
    assert.match(pairing.data.pairingUrl, /^sonoprint:\/\/pair\?/);
    assert.match(pairing.data.qrSvg, /^<svg/);
    const key = pairing.data.key;
    const K = { 'X-SonoPrint-Key': key };

    assert.strictEqual((await call(`${base}/api/printers`, { headers: K })).status, 200);
    // operazioni riservate al PC
    assert.strictEqual((await call(`${base}/api/remote`, { headers: K })).status, 403);
    // il telefono non può cambiare porta o disattivare l'accesso remoto
    const r2 = await call(`${base}/api/settings`, { method: 'PUT', headers: K, body: { port: 6000, remote: { enabled: false }, notifications: false } });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(srv.manager.settings.remote.enabled, true);
    assert.strictEqual(srv.manager.settings.notifications, false);

    // CORS (app del telefono provata nel browser)
    const pre = await fetch(`${base}/api/printers`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Headers': 'x-sonoprint-key' } });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'http://localhost:8081');

    // WebSocket con la chiave: arriva lo stato completo, senza chiave
    const hello = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?key=${encodeURIComponent(key)}`);
      ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
      ws.on('error', reject);
    });
    assert.strictEqual(hello.type, 'hello');
    assert.ok(!JSON.stringify(hello).includes(key));

    // dalla rete (non localhost): API con la chiave sì, pagina web no
    const ip = lanIp();
    if (ip) {
      const lan = `http://${ip}:${srv.port}`;
      assert.strictEqual((await call(`${lan}/api/printers`, { headers: K })).status, 200);
      assert.strictEqual((await call(`${lan}/api/printers`, { headers: { 'X-SonoPrint-Key': 'sbagliata' } })).status, 401);
      assert.strictEqual((await call(`${lan}/api/printers`, { headers: T })).status, 401);
      assert.strictEqual((await call(`${lan}/`)).status, 403);
    }

    // nuova chiave: quella vecchia smette di funzionare
    const regen = await call(`${base}/api/remote/key`, { method: 'POST', headers: T });
    assert.notStrictEqual(regen.data.key, key);
    assert.strictEqual((await call(`${base}/api/printers`, { headers: K })).status, 401);
  } finally {
    await srv.close();
  }
});

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

test('accesso remoto acceso e spento più volte di fila: nessun server orfano', async () => {
  const ip = lanIp();
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    for (const enabled of [true, false, true, false, true, false]) {
      const r = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { developer: true, remote: { enabled } } });
      assert.strictEqual(r.status, 200);
    }
    await sleep(3500); // attende che la coda dei cambi sia finita
    assert.strictEqual(srv.manager.settings.remote.enabled, false);
    assert.strictEqual((await call(`${base}/api/printers`, { headers: T })).status, 200);
    if (ip) assert.strictEqual(await canConnect(ip, srv.port), false, 'dalla rete non deve rispondere nessuno');

    await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { developer: true, remote: { enabled: true } } });
    await sleep(900);
    if (ip) assert.strictEqual(await canConnect(ip, srv.port), true);
    assert.strictEqual((await call(`${base}/api/printers`, { headers: T })).status, 200);
  } finally {
    await srv.close();
  }
});

test('cambio della porta dalle impostazioni', async () => {
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const oldPort = srv.port;
  const T = { 'X-SonoPrint-Token': srv.token };
  const urls = [];
  srv.events.on('url-changed', (u) => urls.push(u));
  try {
    // porta occupata da un altro programma: errore chiaro e nessun cambiamento
    const busy = net.createServer();
    const busyPort = await new Promise((r) => busy.listen(0, '127.0.0.1', () => r(busy.address().port)));
    const r1 = await call(`http://127.0.0.1:${oldPort}/api/settings`, { method: 'PUT', headers: T, body: { port: busyPort } });
    busy.close();
    assert.strictEqual(r1.status, 400);
    assert.match(r1.data.error, /già usata/);
    assert.strictEqual(srv.port, oldPort);

    const newPort = await freePort();
    const r2 = await call(`http://127.0.0.1:${oldPort}/api/settings`, { method: 'PUT', headers: T, body: { port: newPort } });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.data.port, newPort);
    assert.strictEqual(srv.port, newPort);
    assert.deepStrictEqual(urls, [`http://127.0.0.1:${newPort}/`]);
    assert.strictEqual((await call(`http://127.0.0.1:${newPort}/api/printers`, { headers: T })).status, 200);
    await sleep(1200); // la vecchia porta si chiude poco dopo
    await assert.rejects(call(`http://127.0.0.1:${oldPort}/api/printers`, { headers: T }));

    const r3 = await call(`http://127.0.0.1:${newPort}/api/settings`, { method: 'PUT', headers: T, body: { port: 80 } });
    assert.strictEqual(r3.status, 400);
  } finally {
    await srv.close();
  }
});

// --- modalità sviluppatore e rotte delle funzioni nuove ------------------------------------

const { startFakeMoonraker } = require('./fakes/http-printers');
const { startFakeBambu } = require('./fakes/bambu');

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

async function uploadFile(base, T, name, content) {
  const res = await fetch(`${base}/api/files?name=${encodeURIComponent(name)}`, { method: 'POST', headers: T, body: content });
  assert.strictEqual(res.status, 200);
  return (await res.json()).name;
}

test('modalità sviluppatore: senza non si apre l\'accesso dal telefono', async () => {
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    const r1 = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { remote: { enabled: true } } });
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(r1.data.remote, { enabled: false });
    await sleep(900);
    assert.strictEqual(srv.host, '127.0.0.1');

    const r2 = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { developer: true, remote: { enabled: true } } });
    assert.deepStrictEqual(r2.data.remote, { enabled: true });
    await sleep(900);
    assert.strictEqual(srv.host, '0.0.0.0');

    // il telefono non può spegnere la modalità sviluppatore
    const K = { 'X-SonoPrint-Key': srv.manager.settings.remote.key };
    const r3 = await call(`${base}/api/settings`, { method: 'PUT', headers: K, body: { developer: false } });
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(srv.manager.settings.developer, true);

    // spegnendola dal PC si spegne anche l'accesso dal telefono
    const r4 = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { developer: false } });
    assert.deepStrictEqual(r4.data.remote, { enabled: false });
    await sleep(900);
    assert.strictEqual(srv.host, '127.0.0.1');
  } finally {
    await srv.close();
  }
});

test('rotte delicate riservate al PC', async () => {
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { developer: true, remote: { enabled: true } } });
    await sleep(900);
    const K = { 'X-SonoPrint-Key': srv.manager.settings.remote.key };
    const add = await call(`${base}/api/printers`, { method: 'POST', headers: T, body: { type: 'usb', name: 'Prova', port: 'VIRTUAL' } });
    const id = add.data.id;
    for (const [method, url, body] of [
      ['POST', '/api/discovery', {}],
      ['POST', '/api/discovery/probe', { host: '127.0.0.1' }],
      ['POST', '/api/octoprint/appkey', { host: '127.0.0.1' }],
      ['POST', `/api/printers/${id}/firmware/upload?name=f.hex`, {}],
      ['GET', '/api/drives'],
    ]) {
      const r = await call(base + url, { method, headers: K, body });
      assert.strictEqual(r.status, 403, `${method} ${url} dal telefono`);
    }
  } finally {
    await srv.close();
  }
});

test('Klipper dal server: firmware, file protetto durante l\'invio e connessione che cade', async () => {
  let hold = null;
  const fake = await startFakeMoonraker({
    onUpload: (req, res) => { hold = { req, res }; req.resume(); },
  });
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    const add = await call(`${base}/api/printers`, { method: 'POST', headers: T, body: { type: 'klipper', name: 'Voron', net: { host: '127.0.0.1', port: fake.port } } });
    assert.strictEqual(add.status, 200);
    const id = add.data.id;
    const p = srv.manager.get(id);
    await p.connect();
    await until(() => p.state === 'operational');

    const fw = await call(`${base}/api/printers/${id}/firmware`, { headers: T });
    assert.strictEqual(fw.status, 200);
    assert.ok(JSON.stringify(fw.data).includes('klipper'));

    // download del file originale
    const content = 'G28\nG1 X10 Y10\n'.repeat(2000);
    const name = await uploadFile(base, T, 'pezzo.gcode', content);
    const dl = await fetch(`${base}/api/files/${encodeURIComponent(name)}/download`, { headers: T });
    assert.strictEqual(dl.status, 200);
    assert.strictEqual(await dl.text(), content);

    // durante l'invio il file non si può cancellare
    const start = await call(`${base}/api/printers/${id}/job`, { method: 'POST', headers: T, body: { action: 'start', file: name } });
    assert.strictEqual(start.status, 200);
    await until(() => hold && p.state === 'sending');
    const del = await call(`${base}/api/files/${encodeURIComponent(name)}`, { method: 'DELETE', headers: T });
    assert.strictEqual(del.status, 400);

    // la stampante chiude la connessione a metà invio: errore chiaro e stato di nuovo pronto
    const notes = [];
    p.on('notify', (n) => notes.push(n));
    hold.req.socket.destroy();
    await until(() => p.task && p.task.status === 'error');
    await until(() => p.state === 'operational');
    assert.ok(notes.some((n) => n.level === 'error' && /Stampa non avviata/.test(n.message)));
    assert.strictEqual(p.job, null);
    const del2 = await call(`${base}/api/files/${encodeURIComponent(name)}`, { method: 'DELETE', headers: T });
    assert.strictEqual(del2.status, 200);
  } finally {
    await srv.close();
    await fake.close();
  }
});

test('Klipper trovato controllando un indirizzo', async (t) => {
  // il controllo prova anche la porta 5000: se c'è un OctoPrint vero su questo PC non lo si disturba
  if (await canConnect('127.0.0.1', 5000)) return t.skip('porta 5000 occupata da un altro programma');
  let fake;
  try { fake = await startFakeMoonraker({ port: 7125 }); } catch (_) { return t.skip('porta 7125 occupata'); }
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    const r = await call(`${base}/api/discovery/probe`, { method: 'POST', headers: T, body: { host: '127.0.0.1' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.some((x) => x.type === 'klipper' && x.host === '127.0.0.1'), JSON.stringify(r.data));
  } finally {
    await srv.close();
    await fake.close();
  }
});

test('telecamera Bambu come flusso MJPEG', async () => {
  const fake = await startFakeBambu();
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  srv.manager.printerDeps = { bambuPorts: { ftp: fake.ftpPort, camera: fake.cameraPort } };
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  try {
    const add = await call(`${base}/api/printers`, { method: 'POST', headers: T, body: { type: 'bambu', name: 'P1S', model: 'Bambu Lab P1S', net: { host: '127.0.0.1', port: fake.mqttPort, accessCode: fake.accessCode } } });
    assert.strictEqual(add.status, 200);
    const p = srv.manager.get(add.data.id);
    await p.connect();
    await until(() => p.state === 'operational');
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/printers/${p.id}/camera`, { headers: T, signal: ctrl.signal });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^multipart\/x-mixed-replace/);
    const { value } = await res.body.getReader().read();
    assert.ok(value && value.length > 0);
    ctrl.abort();
  } finally {
    await srv.close();
    await fake.close();
  }
});

// --- accesso dai browser della rete, con password ------------------------------------------

/** Richiesta come da un altro dispositivo: Host = indirizzo di rete del computer. */
function asLan(port, host, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({
      host: '127.0.0.1', port, method, path: reqPath,
      headers: { Host: host, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('accesso dalla rete con password', async (t) => {
  const ip = lanIp();
  if (!ip) return t.skip('nessuna scheda di rete');
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token };
  const host = `${ip}:${srv.port}`;
  const lan = (method, p, o) => asLan(srv.port, host, method, p, o);
  try {
    // spento: dalla rete non si apre niente
    assert.strictEqual((await lan('GET', '/')).status, 403);
    // non si accende senza password, e la password deve essere lunga abbastanza
    assert.strictEqual((await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { lan: { enabled: true } } })).status, 400);
    assert.strictEqual((await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { lan: { password: 'corta' } } })).status, 400);
    const on = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { lan: { enabled: true, password: 'segreta123' } } });
    assert.strictEqual(on.status, 200);
    assert.deepStrictEqual(on.data.lan, { enabled: true, hasPassword: true });
    assert.ok(!JSON.stringify(on.data).includes(srv.manager.settings.lan.hash), 'la password non esce mai');
    await sleep(900);
    assert.strictEqual(srv.host, '0.0.0.0');

    // senza accesso: pagina della password, API rifiutate
    const page = await lan('GET', '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /id="login-form"/);
    const denied = await lan('GET', '/api/printers');
    assert.strictEqual(denied.status, 401);
    assert.strictEqual(denied.json.login, true);

    assert.strictEqual((await lan('POST', '/api/login', { body: { password: 'sbagliata' } })).status, 401);
    const ok = await lan('POST', '/api/login', { body: { password: 'segreta123' } });
    assert.strictEqual(ok.status, 200);
    const setCookie = ok.headers['set-cookie'][0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const C = { Cookie: setCookie.split(';')[0] };

    // dentro: API e interfaccia, ma senza il token del computer
    assert.strictEqual((await lan('GET', '/api/printers', { headers: C })).status, 200);
    const index = await lan('GET', '/', { headers: C });
    assert.match(index.text, /id="app"/);
    assert.match(index.text, /name="sonoprint-token" content=""/);
    assert.ok(!index.text.includes(srv.token));
    // le operazioni riservate al computer restano chiuse, e l'accesso dalla rete non si cambia da qui
    assert.strictEqual((await lan('GET', '/api/remote', { headers: C })).status, 403);
    assert.strictEqual((await lan('GET', '/api/lan', { headers: C })).status, 403);
    await lan('PUT', '/api/settings', { headers: C, body: { lan: { enabled: false } } });
    assert.strictEqual(srv.manager.settings.lan.enabled, true);

    // un sito esterno (DNS rebinding) non può usare il cookie
    assert.strictEqual((await asLan(srv.port, 'evil.example', 'GET', '/api/printers', { headers: C })).status, 401);
    assert.strictEqual((await asLan(srv.port, 'evil.example', 'GET', '/')).status, 403);

    // WebSocket dal browser della rete
    const hello = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Host: host, ...C }, origin: `http://${host}` });
      ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
      ws.on('error', reject);
    });
    assert.strictEqual(hello.type, 'hello');
    assert.strictEqual(hello.access, 'lan');

    // password nuova: chi era entrato deve rientrare
    await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { lan: { password: 'nuova-password' } } });
    assert.strictEqual((await lan('GET', '/api/printers', { headers: C })).status, 401);

    // spento: di nuovo chiuso alla rete
    await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { lan: { enabled: false } } });
    await sleep(900);
    assert.strictEqual(srv.host, '127.0.0.1');
    // il computer continua a funzionare come prima
    assert.strictEqual((await call(`${base}/api/printers`, { headers: T })).status, 200);
  } finally {
    await srv.close();
  }
});
