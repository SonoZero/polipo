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
const { lanAddresses } = require('./netinfo');
const { discoverPrinters, probeHost } = require('./discovery');
const { requestOctoPrintKey } = require('./printers/octoprint');
const { listRemovableDrives } = require('./firmware/drives');
const { pipeline } = require('stream/promises');
const { summarizeFirmware } = require('./printers/base');

const UPDATE_CHECK_EVERY = 6 * 60 * 60 * 1000;

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
  route('PUT', /^\/api\/printers\/([\w-]+)$/, async (req, m) => (await manager.update(m[1], await readJsonBody(req))).snapshot());
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
    await manager.get(m[1]).sendCommands(body.commands || body.command || []);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/temperature$/, async (req, m) => {
    const body = await readJsonBody(req);
    const p = manager.get(m[1]);
    const targets = body.targets || { [body.heater]: body.target };
    for (const [heater, target] of Object.entries(targets)) await p.setTemperature(heater, target);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/jog$/, async (req, m) => {
    const body = await readJsonBody(req);
    await manager.get(m[1]).jog(body, body.speed);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/home$/, async (req, m) => {
    await manager.get(m[1]).home((await readJsonBody(req)).axes);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/extrude$/, async (req, m) => {
    const body = await readJsonBody(req);
    await manager.get(m[1]).extrude(body.amount, body.speed, body.tool);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/fan$/, async (req, m) => {
    await manager.get(m[1]).setFan((await readJsonBody(req)).speed);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/rates$/, async (req, m) => {
    const body = await readJsonBody(req);
    const p = manager.get(m[1]);
    if (body.feed !== undefined) await p.setFeedRate(body.feed);
    if (body.flow !== undefined) await p.setFlowRate(body.flow);
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/motors-off$/, async (req, m) => { await manager.get(m[1]).motorsOff(); return { ok: true }; });
  route('POST', /^\/api\/printers\/([\w-]+)\/emergency$/, async (req, m) => { await manager.get(m[1]).emergencyStop(); return { ok: true }; });
  route('POST', /^\/api\/printers\/([\w-]+)\/light$/, async (req, m) => { await manager.get(m[1]).setLight(!!(await readJsonBody(req)).on); return { ok: true }; });
  route('POST', /^\/api\/printers\/([\w-]+)\/speed-level$/, async (req, m) => { await manager.get(m[1]).setSpeedLevel((await readJsonBody(req)).level); return { ok: true }; });
  route('POST', /^\/api\/printers\/([\w-]+)\/job$/, async (req, m) => {
    const body = await readJsonBody(req);
    const p = manager.get(m[1]);
    switch (body.action) {
      case 'start': manager.startPrint(m[1], body.file); break;
      case 'pause': await p.pause(); break;
      case 'resume': await p.resume(); break;
      case 'cancel': await p.cancel(); break;
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
    if (!f || !f.gcodePath) throw notFound();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=latin1', 'Content-Length': fs.statSync(f.gcodePath).size });
    fs.createReadStream(f.gcodePath).pipe(res);
    return STREAMED;
  });

  route('GET', /^\/api\/files\/(.+)\/download$/, (req, m, res) => {
    const f = manager.files.get(decodeURIComponent(m[1]));
    if (!f) throw notFound();
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': f.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    fs.createReadStream(f.path).pipe(res);
    return STREAMED;
  });

  // --- stampanti in rete ------------------------------------------------------------

  route('POST', /^\/api\/discovery$/, async () => {
    const found = await discoverPrinters();
    return found.map((r) => ({ ...r, addedAs: alreadyAdded(r) }));
  }, { localOnly: true });
  route('POST', /^\/api\/discovery\/probe$/, async (req) => {
    const host = String((await readJsonBody(req)).host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
    if (!/^[\w.-]+$/.test(host)) throw badRequest('Indirizzo non valido.');
    const found = await probeHost(host);
    return found.map((r) => ({ ...r, addedAs: alreadyAdded(r) }));
  }, { localOnly: true });
  route('POST', /^\/api\/octoprint\/appkey$/, async (req) => {
    const body = await readJsonBody(req);
    const key = await requestOctoPrintKey(String(body.host || ''), parseInt(body.port, 10) || null);
    if (!key) throw badRequest('La richiesta è stata rifiutata in OctoPrint.');
    return { apiKey: key };
  }, { localOnly: true });

  function alreadyAdded(r) {
    for (const p of manager.list()) {
      if (p.type !== r.type) continue;
      const n = p.config.net;
      if ((r.serial && n.serial === r.serial) || (n.host === r.host && (n.port || null) === (r.port || null))) return p.config.name;
    }
    return null;
  }

  // telecamera integrata (Bambu Lab P1 e A1): immagini JPEG come flusso MJPEG
  route('GET', /^\/api\/printers\/([\w-]+)\/camera$/, (req, m, res) => {
    const p = manager.get(m[1]);
    if (p.capabilities.webcam !== 'builtin' || typeof p.watchCamera !== 'function') throw badRequest('Questa stampante non ha una telecamera integrata che SonoPrint sa leggere.');
    if (!p.isConnected) throw badRequest('Connetti prima la stampante.');
    const boundary = 'sonoprintframe';
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    let stop = null;
    try {
      stop = p.watchCamera((jpeg) => {
        res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
      });
    } catch (_) {
      res.end();
      return STREAMED;
    }
    req.on('close', () => { if (stop) stop(); });
    return STREAMED;
  });

  // --- firmware e software delle stampanti --------------------------------------------

  route('GET', /^\/api\/printers\/([\w-]+)\/firmware$/, async (req, url) => {
    const id = /^\/api\/printers\/([\w-]+)\//.exec(url.pathname)[1];
    const p = manager.get(id);
    if (typeof p.firmwareInfo !== 'function') throw badRequest('Per questa stampante non ci sono aggiornamenti gestiti da SonoPrint.');
    const info = await p.firmwareInfo(url.searchParams.get('refresh') === '1');
    p.setUpdateSummary(summarizeFirmware(info));
    return info;
  }, { raw: true });
  // centro aggiornamenti: ricontrolla l'app e tutte le stampanti connesse
  route('POST', /^\/api\/updates\/check$/, async () => {
    const app = appInfo.getState().status === 'unsupported' ? null : appInfo.check().catch(() => null);
    await Promise.all(manager.list().filter((p) => p.isConnected).map((p) => p.checkUpdates(true)));
    await app;
    return { app: appInfo.getState(), printers: manager.snapshots() };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/firmware\/install$/, async (req, m) => {
    const p = manager.get(m[1]);
    const body = await readJsonBody(req);
    if (!['klipper', 'octoprint'].includes(p.type)) throw badRequest('Per questa stampante carica il file del firmware.');
    p.installFirmware(body.name || 'full').catch(() => { /* errore mostrato nell'operazione */ });
    return { ok: true };
  });
  route('POST', /^\/api\/printers\/([\w-]+)\/firmware\/upload$/, async (req, url) => {
    const id = /^\/api\/printers\/([\w-]+)\//.exec(url.pathname)[1];
    const p = manager.get(id);
    const name = String(url.searchParams.get('name') || '').replace(/^.*[\\/]/, '');
    const ext = path.extname(name).toLowerCase();
    const tmp = path.join(dataDir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const dest = path.join(tmp, 'fw-' + crypto.randomBytes(6).toString('hex') + ext);
    await saveUpload(req, dest, 1024 * 1024 * 1024);
    const cleanup = () => fs.promises.unlink(dest).catch(() => {});
    try {
      if (p.type === 'usb' && ext === '.hex') {
        const hex = fs.readFileSync(dest, 'latin1');
        cleanup();
        p.flashHex(hex).catch(() => { /* errore mostrato nell'operazione */ });
        return { ok: true };
      }
      if (p.type === 'usb' && ext === '.bin') {
        const drive = String(url.searchParams.get('drive') || '');
        const naming = url.searchParams.get('naming') === 'unique' ? 'unique' : 'firmware';
        const r = await p.copyFirmwareToDrive(drive, dest, naming);
        cleanup();
        return r;
      }
      if (p.type === 'bambu') {
        p.installFirmware(dest, name).finally(cleanup).catch(() => { /* errore mostrato nell'operazione */ });
        return { ok: true };
      }
      cleanup();
      throw badRequest('Tipo di file non adatto a questa stampante.');
    } catch (err) {
      cleanup();
      throw err;
    }
  }, { raw: true, localOnly: true });
  route('POST', /^\/api\/printers\/([\w-]+)\/task\/clear$/, (req, m) => {
    const p = manager.get(m[1]);
    if (p.task && p.task.status !== 'running') p._setTask(null);
    return { ok: true };
  });
  route('GET', /^\/api\/drives$/, () => listRemovableDrives(), { localOnly: true });

  route('GET', /^\/api\/app$/, () => appInfo.getState());
  route('POST', /^\/api\/app\/update\/check$/, () => appInfo.check());
  route('POST', /^\/api\/app\/update\/install$/, () => {
    const active = manager.activeLocalPrints();
    if (active.length) throw badRequest(`Aspetta la fine delle stampe in corso (${active.join(', ')}) prima di aggiornare.`);
    return appInfo.install();
  }, { localOnly: true });

  route('GET', /^\/api\/settings$/, () => manager.publicSettings());
  route('PUT', /^\/api\/settings$/, async (req, m, res, auth) => {
    const body = await readJsonBody(req);
    // porta, accesso remoto e modalità sviluppatore si cambiano solo dal PC
    if (!auth.local) { delete body.port; delete body.remote; delete body.developer; }
    if ('port' in body) {
      const port = validPort(body.port);
      if (!port) throw badRequest('La porta deve essere un numero tra 1024 e 65535.');
      // solo se l'utente l'ha davvero cambiata (o se all'avvio era occupata)
      if ((port !== manager.settings.port || portFallback) && port !== desired.port) await changePort(port);
    }
    const result = manager.updateSettings(body);
    const host = manager.settings.remote.enabled ? ANY_HOST : LOCAL_HOST;
    if (host !== desired.host) changeHost(host);
    return result;
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
    const pairingUrl = `sonoprint://pair?${params.toString()}`;
    const qrSvg = await QRCode.toString(pairingUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    return { enabled, key, port: current.port, hostname: os.hostname(), addresses, pairingUrl, qrSvg };
  }

  // ---------------------------------------------------------------------------
  // HTTP

  /**
   * Chi sta chiamando?
   * - local: richiesta dal PC stesso verso localhost (l'interfaccia di SonoPrint);
   *   il controllo dell'Host blocca gli attacchi di DNS rebinding;
   * - tokenOk: interfaccia locale con il token della sessione;
   * - keyOk: app del telefono (o altro client) con la chiave di accesso remoto.
   */
  function authenticate(req, url) {
    const local = isLoopback(req.socket.remoteAddress) && allowedHost(req.headers.host);
    const tokenVal = req.headers['x-sonoprint-token'] || (req.method === 'GET' ? url.searchParams.get('token') : null);
    const tokenOk = local && !!tokenVal && safeEqual(String(tokenVal), token);
    const keyVal = req.headers['x-sonoprint-key'] || (req.method === 'GET' ? url.searchParams.get('key') : null);
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
            ? (manager.settings.remote.enabled ? 'Chiave di accesso non valida: abbina di nuovo il telefono.' : 'L\'accesso dal telefono è disattivato in SonoPrint.')
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
        return sendJson(res, 403, { error: 'L\'interfaccia di SonoPrint si apre solo sul PC. Dal telefono usa l\'app SonoPrint.' });
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
      if (ext === '.html') data = Buffer.from(data.toString('utf8').replace('%%SONOPRINT_TOKEN%%', token));
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
  // aggiornamenti di firmware e software: ricontrollati ogni 6 ore (e a ogni connessione)
  const updatesTimer = setInterval(() => {
    for (const p of manager.list()) if (p.isConnected) p.checkUpdates(false).catch(() => {});
  }, UPDATE_CHECK_EVERY);
  if (updatesTimer.unref) updatesTimer.unref();

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

  // I cambi di porta/interfaccia vengono eseguiti uno alla volta, ciascuno sullo stato
  // più recente: così cambi rapidi (es. accesso remoto acceso e spento subito) non
  // lasciano server "orfani" in ascolto.
  let queue = Promise.resolve();
  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * Nuova porta: la apre subito (se è occupata risponde con un errore e non cambia nulla);
   * la vecchia si chiude poco dopo, così la risposta a questa richiesta arriva comunque.
   */
  function changePort(port) {
    return serial(async () => {
      const old = current;
      if (old.port === port) return;
      let s;
      try {
        s = await bind(port, old.host);
      } catch (err) {
        throw badRequest(err.code === 'EADDRINUSE'
          ? `La porta ${port} è già usata da un altro programma. Scegline un'altra.`
          : `Impossibile usare la porta ${port}: ${err.message}`);
      }
      current = { server: s, port, host: old.host };
      desired.port = port;
      portFallback = false;
      // i client ricevono la nuova porta prima che la vecchia venga chiusa
      broadcast({ type: 'network', network: networkInfo() });
      events.emit('url-changed', localUrl(port));
      serial(async () => {
        await sleep(700);
        for (const ws of clients) ws.terminate();
        await closeServer(old.server);
      });
    });
  }

  /** Apre o chiude SonoPrint alla rete (stessa porta: bisogna chiudere prima di riaprire). */
  function changeHost(host) {
    desired.host = host;
    serial(async () => {
      await sleep(400); // lascia partire la risposta a questa richiesta
      if (current.host === host) return;
      const old = current;
      await closeServer(old.server);
      try {
        current = { server: await bind(old.port, host), port: old.port, host };
      } catch (err) {
        current = { server: await bind(old.port, old.host), port: old.port, host: old.host };
        desired.host = old.host;
        events.emit('notify', { level: 'error', title: 'SonoPrint', message: 'Impossibile aprire SonoPrint alla rete: ' + err.message });
      }
      if (current.host === LOCAL_HOST) dropRemoteClients();
      broadcast({ type: 'network', network: networkInfo() });
    });
  }

  await manager.init();
  const startHost = manager.settings.remote.enabled ? ANY_HOST : LOCAL_HOST;
  const startPort = options.port ?? manager.settings.port;
  try {
    const s = await bind(startPort, startHost);
    current = { server: s, port: s.address().port, host: startHost };
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    // porta occupata (es. un'altra copia di SonoPrint): usa una porta libera e avvisa nelle impostazioni
    const s = await bind(0, startHost);
    current = { server: s, port: s.address().port, host: startHost };
    portFallback = true;
  }
  // dove il server sta andando (può essere avanti rispetto a "current" se ci sono cambi in coda)
  const desired = { port: current.port, host: current.host };

  return {
    get url() { return localUrl(); },
    get port() { return current.port; },
    get host() { return current.host; },
    token,
    manager,
    events,
    async close() {
      clearInterval(logTimer);
      clearInterval(updatesTimer);
      await queue;
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
  const unsupported = () => { throw badRequest('Gli aggiornamenti automatici funzionano solo nella versione installata di SonoPrint.'); };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'X-SonoPrint-Key, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Max-Age', '600');
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

function saveUpload(req, dest, limit) {
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) req.destroy(badRequest('File troppo grande.'));
  });
  return pipeline(req, fs.createWriteStream(dest)).catch((err) => {
    fs.promises.unlink(dest).catch(() => {});
    throw err;
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
