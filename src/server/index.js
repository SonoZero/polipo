'use strict';

// Server HTTP (API REST + file dell'interfaccia) e WebSocket per gli aggiornamenti in tempo reale.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { PrinterManager } = require('./manager');
const { writeJson } = require('./files');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function startServer(options = {}) {
  const dataDir = options.dataDir;
  const host = options.host || '127.0.0.1';
  const preferredPort = options.port ?? 5723;
  fs.mkdirSync(dataDir, { recursive: true });

  const events = new EventEmitter();
  const manager = new PrinterManager(dataDir);
  // informazioni sull'app e aggiornamenti (forniti da Electron; senza finestra non ci sono)
  const appInfo = options.appInfo || headlessAppInfo();
  const token = crypto.randomBytes(24).toString('hex');
  let actualPort = preferredPort;

  // ---------------------------------------------------------------------------
  // Router API

  const routes = [];
  const route = (method, pattern, handler, options = {}) => routes.push({ method, pattern, handler, options });

  route('GET', /^\/api\/state$/, () => fullState());
  route('GET', /^\/api\/ports$/, () => manager.ports());

  route('GET', /^\/api\/printers$/, () => manager.snapshots());
  route('POST', /^\/api\/printers$/, async (req) => manager.add(await readJsonBody(req)).snapshot());
  route('PUT', /^\/api\/printers\/order$/, async (req) => { manager.reorder((await readJsonBody(req)).ids || []); return { ok: true }; });
  route('PUT', /^\/api\/printers\/([\w-]+)$/, async (req, m) => manager.update(m[1], await readJsonBody(req)).snapshot());
  route('DELETE', /^\/api\/printers\/([\w-]+)$/, async (req, m) => { await manager.remove(m[1]); return { ok: true }; });
  route('GET', /^\/api\/printers\/([\w-]+)\/log$/, (req, m) => manager.get(m[1]).getLog());
  route('GET', /^\/api\/printers\/([\w-]+)\/temps$/, (req, m) => manager.get(m[1]).getTempHistory());

  route('POST', /^\/api\/printers\/([\w-]+)\/connect$/, async (req, m) => {
    const body = await readJsonBody(req);
    await manager.connect(m[1], { port: body.port, baudrate: body.baudrate });
    return manager.get(m[1]).snapshot();
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/disconnect$/, async (req, m) => {
    await manager.get(m[1]).disconnect();
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/command$/, async (req, m) => {
    const body = await readJsonBody(req);
    manager.get(m[1]).sendCommands(body.commands || body.command || []);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/temperature$/, async (req, m) => {
    const body = await readJsonBody(req);
    const p = manager.get(m[1]);
    const targets = body.targets || { [body.heater]: body.target };
    for (const [heater, target] of Object.entries(targets)) p.setTemperature(heater, target);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/jog$/, async (req, m) => {
    const body = await readJsonBody(req);
    manager.get(m[1]).jog(body, body.speed);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/home$/, async (req, m) => {
    manager.get(m[1]).home((await readJsonBody(req)).axes);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/extrude$/, async (req, m) => {
    const body = await readJsonBody(req);
    manager.get(m[1]).extrude(body.amount, body.speed, body.tool);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/fan$/, async (req, m) => {
    manager.get(m[1]).setFan((await readJsonBody(req)).speed);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/rates$/, async (req, m) => {
    const body = await readJsonBody(req);
    const p = manager.get(m[1]);
    if (body.feed !== undefined) p.setFeedRate(body.feed);
    if (body.flow !== undefined) p.setFlowRate(body.flow);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/motors-off$/, (req, m) => { manager.get(m[1]).motorsOff(); return { ok: true }; });
  route('POST', /^\/api\/printers\/([\w-]+)\/emergency$/, (req, m) => { manager.get(m[1]).emergencyStop(); return { ok: true }; });
  route('POST', /^\/api\/printers\/([\w-]+)\/job$/, async (req, m) => {
    const body = await readJsonBody(req);
    const p = manager.get(m[1]);
    switch (body.action) {
      case 'start': manager.startPrint(m[1], body.file); break;
      case 'pause': p.pause(); break;
      case 'resume': p.resume(); break;
      case 'cancel': p.cancel(); break;
      default: throw badRequest('Azione sconosciuta.');
    }
    return p.snapshot();
  });

  route('GET', /^\/api\/files$/, () => manager.files.list());
  route('POST', /^\/api\/files$/, async (req, url) => {
    const name = url.searchParams.get('name');
    const saved = await manager.files.add(name, req);
    return { name: saved };
  }, { raw: true });
  route('DELETE', /^\/api\/files\/(.+)$/, (req, m) => { manager.files.remove(decodeURIComponent(m[1])); return { ok: true }; });
  route('GET', /^\/api\/files\/(.+)\/thumb$/, (req, m, res) => {
    const p = manager.files.thumbPath(decodeURIComponent(m[1]));
    if (!p) throw notFound();
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    fs.createReadStream(p).pipe(res);
    return STREAMED;
  });
  route('GET', /^\/api\/files\/(.+)\/content$/, (req, m, res) => {
    const f = manager.files.get(decodeURIComponent(m[1]));
    if (!f) throw notFound();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=latin1', 'Content-Length': fs.statSync(f.path).size });
    fs.createReadStream(f.path).pipe(res);
    return STREAMED;
  });

  route('GET', /^\/api\/app$/, () => appInfo.getState());
  route('POST', /^\/api\/app\/update\/check$/, () => appInfo.check());
  route('POST', /^\/api\/app\/update\/install$/, () => {
    const active = manager.activePrints();
    if (active.length) throw badRequest(`Aspetta la fine delle stampe in corso (${active.join(', ')}) prima di aggiornare.`);
    return appInfo.install();
  });

  route('GET', /^\/api\/settings$/, () => manager.settings);
  route('PUT', /^\/api\/settings$/, async (req) => manager.updateSettings(await readJsonBody(req)));
  route('GET', /^\/api\/history$/, () => manager.history);
  route('DELETE', /^\/api\/history$/, () => {
    manager.history = [];
    writeJson(manager.historyPath, []);
    manager.emit('history-changed');
    return { ok: true };
  });

  function fullState() {
    const temps = {};
    for (const p of manager.list()) temps[p.id] = p.getTempHistory();
    return {
      printers: manager.snapshots(),
      files: manager.files.list(),
      settings: manager.settings,
      history: manager.history.slice(0, 200),
      temps,
      app: appInfo.getState(),
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP

  const allowedHost = (h) => {
    if (!h) return false;
    const hostOnly = h.replace(/:\d+$/, '').toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostOnly);
  };

  const server = http.createServer(async (req, res) => {
    try {
      // protezione DNS-rebinding: accetta solo richieste rivolte a localhost
      if (!allowedHost(req.headers.host)) return sendJson(res, 403, { error: 'Host non consentito.' });
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname.startsWith('/api/')) {
        // protezione CSRF: ogni chiamata deve avere il token della sessione
        const t = req.headers['x-polipo-token'] || (req.method === 'GET' ? url.searchParams.get('token') : null);
        if (!t || !safeEqual(String(t), token)) return sendJson(res, 401, { error: 'Token non valido.' });
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          const result = await r.handler(req, r.options.raw ? url : m, res);
          if (result === STREAMED) return;
          return sendJson(res, 200, result === undefined ? { ok: true } : result);
        }
        return sendJson(res, 404, { error: 'Endpoint non trovato.' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Metodo non consentito.' });
      return serveStatic(url.pathname, res);
    } catch (err) {
      const status = err.status || 400;
      if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
      else res.end();
    }
  });
  function serveStatic(pathname, res) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(WEB_DIR, rel));
    if (!filePath.startsWith(WEB_DIR)) return sendJson(res, 403, { error: 'Vietato.' });
    fs.readFile(filePath, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'Non trovato.' });
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.html') data = Buffer.from(data.toString('utf8').replace('%%POLIPO_TOKEN%%', token));
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(ext === '.html' ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: http: https:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'" } : {}),
      });
      res.end(data);
    });
  }

  // ---------------------------------------------------------------------------
  // WebSocket

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const originOk = !origin || allowedHost(origin.replace(/^https?:\/\//, ''));
    if (url.pathname !== '/ws' || !allowedHost(req.headers.host) || !originOk || !safeEqual(url.searchParams.get('token') || '', token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.subs = new Set();
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch (_) { return; }
        if (msg.type === 'subscribe-log' && manager.printers.has(msg.id)) {
          ws.subs.add(msg.id);
          send(ws, { type: 'log-init', id: msg.id, lines: manager.get(msg.id).getLog() });
        } else if (msg.type === 'unsubscribe-log') {
          ws.subs.delete(msg.id);
        }
      });
      send(ws, { type: 'hello', ...fullState() });
    });
  });

  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of clients) if (ws.readyState === 1) ws.send(data);
  }

  manager.on('printer-update', (p) => broadcast({ type: 'printer', printer: p.snapshot() }));
  manager.on('printers-changed', () => broadcast({ type: 'printers', printers: manager.snapshots() }));
  manager.on('temp', (id, sample) => broadcast({ type: 'temp', id, sample }));
  manager.on('settings-changed', () => broadcast({ type: 'settings', settings: manager.settings }));
  manager.on('history-changed', () => broadcast({ type: 'history', history: manager.history.slice(0, 200) }));
  manager.on('notify', (n) => {
    broadcast({ type: 'notify', ...n });
    events.emit('notify', n);
  });
  manager.on('printing-changed', () => events.emit('printing-changed', manager.anyPrinting()));
  appInfo.on('change', (state) => broadcast({ type: 'app', app: state }));

  let filesTimer = null;
  manager.on('files-changed', () => {
    if (filesTimer) return;
    filesTimer = setTimeout(() => {
      filesTimer = null;
      broadcast({ type: 'files', files: manager.files.list() });
    }, 250);
  });

  // il log del terminale viene raggruppato e inviato solo a chi lo sta guardando
  const pendingLogs = new Map();
  manager.on('log', (id, entry) => {
    if (!pendingLogs.has(id)) pendingLogs.set(id, []);
    pendingLogs.get(id).push(entry);
  });
  const logTimer = setInterval(() => {
    if (!pendingLogs.size) return;
    for (const [id, lines] of pendingLogs) {
      const data = JSON.stringify({ type: 'log', id, lines });
      for (const ws of clients) if (ws.subs.has(id) && ws.readyState === 1) ws.send(data);
    }
    pendingLogs.clear();
  }, 150);

  // ---------------------------------------------------------------------------
  // Avvio

  await manager.init();
  actualPort = await listen(server, preferredPort, host);

  return {
    url: `http://127.0.0.1:${actualPort}/`,
    port: actualPort,
    token,
    manager,
    events,
    async close() {
      clearInterval(logTimer);
      for (const ws of clients) ws.terminate();
      await manager.shutdown();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const STREAMED = Symbol('streamed');

function headlessAppInfo() {
  const info = new EventEmitter();
  const state = {
    current: require('../../package.json').version,
    status: 'unsupported',
    version: null, percent: null, error: null, checkedAt: null, portable: false, releaseUrl: null,
  };
  const unsupported = () => { throw badRequest('Gli aggiornamenti automatici funzionano solo nella versione installata di Polipo.'); };
  info.getState = () => state;
  info.check = unsupported;
  info.install = unsupported;
  return info;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onError);
        listen(server, 0, host).then(resolve, reject);
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(badRequest('Richiesta troppo grande.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(badRequest('JSON non valido.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }
function notFound() { const e = new Error('Non trovato.'); e.status = 404; return e; }

module.exports = { startServer };
