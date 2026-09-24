'use strict';

// Server HTTP (API REST + file dell'interfaccia) e WebSocket per gli aggiornamenti in tempo reale.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { PrinterManager } = require('./manager');
const { writeJson } = require('./files');

const LOCAL_HOST = '127.0.0.1';
const ANY_HOST = '0.0.0.0';

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
  fs.mkdirSync(dataDir, { recursive: true });

  const events = new EventEmitter();
  const manager = new PrinterManager(dataDir);
  // informazioni sull'app e aggiornamenti (forniti da Electron; senza finestra non ci sono)
  const appInfo = options.appInfo || headlessAppInfo();
  // token della sessione locale: lo conosce solo l'interfaccia servita a questo PC
  const token = crypto.randomBytes(24).toString('hex');
  // server HTTP in ascolto: { server, port, host }
  let current = null;
  let portFallback = false;
  const failedKeys = new Map(); // ip -> { count, until }

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
  }, { localOnly: true });

  route('GET', /^\/api\/settings$/, () => manager.publicSettings());
  route('PUT', /^\/api\/settings$/, async (req, m, res, auth) => {
    const body = await readJsonBody(req);
    // porta e accesso remoto si cambiano solo dal PC
    if (!auth.local) { delete body.port; delete body.remote; }
    let port = current.port;
    if ('port' in body) {
      port = validPort(body.port);
      if (!port) throw badRequest('La porta deve essere un numero tra 1024 e 65535.');
      if (port === manager.settings.port && !portFallback) port = current.port; // non cambiata
    }
    const host = 'remote' in body ? (body.remote && body.remote.enabled ? ANY_HOST : LOCAL_HOST) : current.host;
    if (port !== current.port || host !== current.host) await moveListener(port, host);
    return manager.updateSettings(body);
  });

  route('GET', /^\/api\/network$/, () => networkInfo());
  route('GET', /^\/api\/remote$/, () => pairingInfo(), { localOnly: true });
  route('POST', /^\/api\/remote\/key$/, () => {
    manager.regenerateRemoteKey();
    return pairingInfo();
  }, { localOnly: true });
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
      settings: manager.publicSettings(),
      history: manager.history.slice(0, 200),
      temps,
      app: appInfo.getState(),
      network: networkInfo(),
    };
  }

  function localUrl(port = current.port) {
    return `http://127.0.0.1:${port}/`;
  }

  function networkInfo() {
    return {
      port: current.port,
      configuredPort: manager.settings.port,
      portFallback,
      remote: current.host === ANY_HOST,
      url: localUrl(),
      hostname: os.hostname(),
      addresses: current.host === ANY_HOST ? lanAddresses() : [],
    };
  }

  async function pairingInfo() {
    const addresses = lanAddresses();
    const { enabled, key } = manager.settings.remote;
    const params = new URLSearchParams({
      h: addresses.map((a) => a.address).join(','),
      p: String(current.port),
      k: key,
      n: os.hostname(),
    });
    const pairingUrl = `polipo://pair?${params.toString()}`;
    const qrSvg = await QRCode.toString(pairingUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    return { enabled, key, port: current.port, hostname: os.hostname(), addresses, pairingUrl, qrSvg };
  }

  // ---------------------------------------------------------------------------
  // HTTP

  /**
   * Chi sta chiamando?
   * - local: richiesta dal PC stesso verso localhost (l'interfaccia di Polipo);
   *   il controllo dell'Host blocca gli attacchi di DNS rebinding;
   * - tokenOk: interfaccia locale con il token della sessione;
   * - keyOk: app del telefono (o altro client) con la chiave di accesso remoto.
   */
  function authenticate(req, url) {
    const local = isLoopback(req.socket.remoteAddress) && allowedHost(req.headers.host);
    const tokenVal = req.headers['x-polipo-token'] || (req.method === 'GET' ? url.searchParams.get('token') : null);
    const tokenOk = local && !!tokenVal && safeEqual(String(tokenVal), token);
    const keyVal = req.headers['x-polipo-key'] || (req.method === 'GET' ? url.searchParams.get('key') : null);
    const { enabled, key } = manager.settings.remote;
    const keyOk = enabled && !!keyVal && !tokenOk && safeEqual(String(keyVal), key);
    return { local: tokenOk, tokenOk, keyOk, triedKey: !!keyVal };
  }

  // limita i tentativi con chiavi sbagliate (per indirizzo IP)
  function isBlocked(ip) {
    const f = failedKeys.get(ip);
    return !!(f && f.until > Date.now());
  }
  function noteFailure(ip) {
    const f = failedKeys.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 20) { f.until = Date.now() + 10 * 60 * 1000; f.count = 0; }
    failedKeys.set(ip, f);
  }

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = req.socket.remoteAddress;
      const isApi = url.pathname.startsWith('/api/');

      // CORS solo per le API: servono all'app del telefono quando gira nel browser (sviluppo).
      // Senza chiave valida la risposta è comunque un 401.
      if (isApi && req.headers.origin) setCors(res, req.headers.origin);
      if (req.method === 'OPTIONS') { res.writeHead(isApi ? 204 : 405); return res.end(); }

      const auth = authenticate(req, url);

      if (isApi) {
        if (isBlocked(ip)) return sendJson(res, 429, { error: 'Troppi tentativi con una chiave sbagliata: riprova tra qualche minuto.' });
        if (!auth.tokenOk && !auth.keyOk) {
          if (auth.triedKey) noteFailure(ip);
          const msg = auth.triedKey
            ? (manager.settings.remote.enabled ? 'Chiave di accesso non valida: abbina di nuovo il telefono.' : 'L\'accesso dal telefono è disattivato in Polipo.')
            : 'Token non valido.';
          return sendJson(res, 401, { error: msg });
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          if (r.options.localOnly && !auth.local) return sendJson(res, 403, { error: 'Questa operazione si può fare solo dal PC.' });
          const result = await r.handler(req, r.options.raw ? url : m, res, auth);
          if (result === STREAMED) return;
          return sendJson(res, 200, result === undefined ? { ok: true } : result);
        }
        return sendJson(res, 404, { error: 'Endpoint non trovato.' });
      }

      // l'interfaccia web si apre solo dal PC (dal telefono si usa l'app)
      if (!(isLoopback(ip) && allowedHost(req.headers.host))) {
        return sendJson(res, 403, { error: 'L\'interfaccia di Polipo si apre solo sul PC. Dal telefono usa l\'app Polipo.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Metodo non consentito.' });
      return serveStatic(url.pathname, res);
    } catch (err) {
      const status = err.status || 400;
      if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
      else res.end();
    }
  }

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

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress;
    const auth = authenticate(req, url);
    // l'interfaccia locale deve anche provenire da una pagina di localhost
    const origin = req.headers.origin;
    const originOk = !origin || allowedHost(origin.replace(/^https?:\/\//, ''));
    const allowed = url.pathname === '/ws' && !isBlocked(ip) && ((auth.tokenOk && originOk) || auth.keyOk);
    if (!allowed) {
      if (auth.triedKey) noteFailure(ip);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.remote = !auth.tokenOk;
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
  }

  function dropRemoteClients() {
    for (const ws of clients) if (ws.remote) ws.terminate();
  }

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
  manager.on('settings-changed', () => {
    broadcast({ type: 'settings', settings: manager.publicSettings() });
    if (!manager.settings.remote.enabled) dropRemoteClients();
  });
  // con una chiave nuova i telefoni abbinati prima devono riabbinarsi
  manager.on('remote-key-changed', dropRemoteClients);
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

  function bind(port, host) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handleRequest);
      s.on('upgrade', handleUpgrade);
      s.once('error', reject);
      s.listen(port, host, () => {
        s.removeListener('error', reject);
        s.on('error', () => {});
        resolve(s);
      });
    });
  }

  function closeServer(s) {
    return new Promise((resolve) => {
      s.close(() => resolve());
      if (s.closeAllConnections) s.closeAllConnections();
      setTimeout(resolve, 1000);
    });
  }

  /**
   * Sposta il server su un'altra porta o interfaccia senza fermare le stampanti.
   * Con una porta nuova la apre prima di chiudere la vecchia (se è occupata non cambia nulla);
   * la vecchia si chiude poco dopo, così la risposta a questa richiesta arriva comunque.
   */
  async function moveListener(port, host) {
    const old = current;
    const portChanged = port !== old.port;
    if (portChanged) {
      let s;
      try {
        s = await bind(port, host);
      } catch (err) {
        throw badRequest(err.code === 'EADDRINUSE'
          ? `La porta ${port} è già usata da un altro programma. Scegline un'altra.`
          : `Impossibile usare la porta ${port}: ${err.message}`);
      }
      current = { server: s, port, host };
      portFallback = false;
      // i client ricevono la nuova porta prima che la vecchia venga chiusa
      broadcast({ type: 'network', network: networkInfo() });
      setTimeout(async () => {
        for (const ws of clients) ws.terminate();
        await closeServer(old.server);
      }, 700);
    } else {
      // stessa porta ma da aprire/chiudere alla rete: bisogna chiudere prima di riaprire
      current = { ...old, host };
      setTimeout(async () => {
        await closeServer(old.server);
        try {
          current = { server: await bind(port, host), port, host };
        } catch (err) {
          current = { server: await bind(port, old.host), port, host: old.host };
          events.emit('notify', { level: 'error', title: 'Polipo', message: 'Impossibile aprire Polipo alla rete: ' + err.message });
        }
        if (current.host === LOCAL_HOST) dropRemoteClients();
        broadcast({ type: 'network', network: networkInfo() });
      }, 400);
    }
    if (portChanged) events.emit('url-changed', localUrl(port));
  }

  await manager.init();
  const startHost = manager.settings.remote.enabled ? ANY_HOST : LOCAL_HOST;
  const startPort = options.port ?? manager.settings.port;
  try {
    const s = await bind(startPort, startHost);
    current = { server: s, port: s.address().port, host: startHost };
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    // porta occupata (es. un'altra copia di Polipo): usa una porta libera e avvisa nelle impostazioni
    const s = await bind(0, startHost);
    current = { server: s, port: s.address().port, host: startHost };
    portFallback = true;
  }

  return {
    get url() { return localUrl(); },
    get port() { return current.port; },
    token,
    manager,
    events,
    async close() {
      clearInterval(logTimer);
      for (const ws of clients) ws.terminate();
      await manager.shutdown();
      await closeServer(current.server);
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

function allowedHost(h) {
  if (!h) return false;
  const hostOnly = h.replace(/:\d+$/, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostOnly);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function validPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'X-Polipo-Key, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Max-Age', '600');
}

// schede di rete virtuali (macchine virtuali, WSL, Docker) che il telefono non può raggiungere
const VIRTUAL_NICS = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|Loopback/i;
const KIND_ORDER = { lan: 0, tailscale: 1, vpn: 2 };

/** Indirizzi IPv4 del PC raggiungibili dal telefono (Wi-Fi/Ethernet, Tailscale, altre VPN). */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_NICS.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const [x, y] = a.address.split('.').map(Number);
      const cgnat = x === 100 && y >= 64 && y <= 127; // usato da Tailscale ma anche da altre VPN
      const kind = /tailscale/i.test(name) ? 'tailscale' : (cgnat || /vpn|wireguard|nordlynx|zerotier|wintun/i.test(name) ? 'vpn' : 'lan');
      out.push({ address: a.address, name, kind });
    }
  }
  // prima la rete di casa, poi Tailscale, poi le altre VPN
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
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
