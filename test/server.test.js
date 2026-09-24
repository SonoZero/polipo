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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polipo-srv-'));
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
    assert.strictEqual((await call(`${base}/api/printers`, { headers: { 'X-Polipo-Token': srv.token } })).status, 200);
    // la chiave del telefono non funziona finché l'accesso remoto è spento
    const key = srv.manager.settings.remote.key;
    const r = await call(`${base}/api/printers`, { headers: { 'X-Polipo-Key': key } });
    assert.strictEqual(r.status, 401);
    assert.match(r.data.error, /disattivato/);
    // DNS rebinding: pagina e API rifiutate con un Host diverso da localhost
    const page = await new Promise((resolve) => {
      require('http').get({ host: '127.0.0.1', port: srv.port, path: '/', headers: { Host: 'evil.example:80' } }, resolve);
    });
    assert.strictEqual(page.statusCode, 403);
    // le impostazioni non contengono mai la chiave
    const s = await call(`${base}/api/settings`, { headers: { 'X-Polipo-Token': srv.token } });
    assert.deepStrictEqual(s.data.remote, { enabled: false });
    assert.ok(!JSON.stringify(s.data).includes(key));
  } finally {
    await srv.close();
  }
});

test('accesso dal telefono con la chiave', async () => {
  const srv = await startServer({ dataDir: tmpDir(), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-Polipo-Token': srv.token };
  try {
    const r1 = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { remote: { enabled: true } } });
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(r1.data.remote, { enabled: true });
    await sleep(900); // il server si riapre su tutte le interfacce

    const pairing = await call(`${base}/api/remote`, { headers: T });
    assert.strictEqual(pairing.status, 200);
    assert.match(pairing.data.pairingUrl, /^polipo:\/\/pair\?/);
    assert.match(pairing.data.qrSvg, /^<svg/);
    const key = pairing.data.key;
    const K = { 'X-Polipo-Key': key };

    assert.strictEqual((await call(`${base}/api/printers`, { headers: K })).status, 200);
    // operazioni riservate al PC
    assert.strictEqual((await call(`${base}/api/remote`, { headers: K })).status, 403);
    // il telefono non può cambiare porta o disattivare l'accesso remoto
    const r2 = await call(`${base}/api/settings`, { method: 'PUT', headers: K, body: { port: 6000, remote: { enabled: false }, notifications: false } });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(srv.manager.settings.remote.enabled, true);
    assert.strictEqual(srv.manager.settings.notifications, false);

    // CORS (app del telefono provata nel browser)
    const pre = await fetch(`${base}/api/printers`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Headers': 'x-polipo-key' } });
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
      assert.strictEqual((await call(`${lan}/api/printers`, { headers: { 'X-Polipo-Key': 'sbagliata' } })).status, 401);
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
  const T = { 'X-Polipo-Token': srv.token };
  try {
    for (const enabled of [true, false, true, false, true, false]) {
      const r = await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { remote: { enabled } } });
      assert.strictEqual(r.status, 200);
    }
    await sleep(3500); // attende che la coda dei cambi sia finita
    assert.strictEqual(srv.manager.settings.remote.enabled, false);
    assert.strictEqual((await call(`${base}/api/printers`, { headers: T })).status, 200);
    if (ip) assert.strictEqual(await canConnect(ip, srv.port), false, 'dalla rete non deve rispondere nessuno');

    await call(`${base}/api/settings`, { method: 'PUT', headers: T, body: { remote: { enabled: true } } });
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
  const T = { 'X-Polipo-Token': srv.token };
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
