'use strict';

// Stampanti in rete finte per i test: Moonraker (Klipper), PrusaLink e OctoPrint.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

/** Estrae file e campi da un corpo multipart/form-data. */
function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType || '')[1];
  const parts = body.toString('latin1').split('--' + boundary).slice(1, -1);
  const out = { fields: {}, file: null };
  for (const part of parts) {
    const i = part.indexOf('\r\n\r\n');
    const head = part.slice(0, i);
    const content = part.slice(i + 4, part.length - 2);
    const name = /name="([^"]+)"/.exec(head)[1];
    const filename = /filename="([^"]+)"/.exec(head);
    if (filename) out.file = { field: name, name: filename[1], size: Buffer.byteLength(content, 'latin1') };
    else out.fields[name] = content;
  }
  return out;
}

function closeAll(server, extra = []) {
  if (server.closeAllConnections) server.closeAllConnections();
  return Promise.all([new Promise((r) => server.close(() => r())), ...extra]);
}

// --- Moonraker -------------------------------------------------------------------------

async function startFakeMoonraker(opts = {}) {
  const state = {
    klippy: 'ready',
    files: new Map(),
    gcode: [],
    upgrades: [],
    status: {
      webhooks: { state: 'ready', state_message: '' },
      print_stats: { state: 'standby', filename: '', print_duration: 0, total_duration: 0, message: '', info: { current_layer: null, total_layer: null } },
      virtual_sdcard: { progress: 0, is_active: false },
      display_status: { progress: 0 },
      extruder: { temperature: 24.5, target: 0 },
      heater_bed: { temperature: 23.1, target: 0 },
      fan: { speed: 0 },
      gcode_move: { speed_factor: 1, extrude_factor: 1 },
      toolhead: { position: [0, 0, 0, 0], homed_axes: '' },
    },
  };
  const clients = new Set();
  let timer = null;
  const notify = (method, params) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
  };
  const update = (obj, fields) => {
    Object.assign(state.status[obj], fields);
    notify('notify_status_update', [{ [obj]: fields }, Date.now() / 1000]);
  };
  function runPrint(filename) {
    clearInterval(timer);
    update('print_stats', { state: 'printing', filename, print_duration: 0, total_duration: 0 });
    let p = 0;
    timer = setInterval(() => {
      if (state.status.print_stats.state !== 'printing') return;
      p += 0.25;
      if (p >= 1) {
        clearInterval(timer);
        update('virtual_sdcard', { progress: 1 });
        update('print_stats', { state: 'complete' });
        return;
      }
      update('virtual_sdcard', { progress: p });
      update('print_stats', { print_duration: p * 100, total_duration: p * 110, info: { current_layer: p * 40, total_layer: 40 } });
    }, opts.stepMs || 120);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (opts.apiKey && req.headers['x-api-key'] !== opts.apiKey) return json(res, 401, { error: { message: 'Unauthorized' } });
    if (url.pathname === '/server/info') return json(res, 200, { result: { klippy_connected: true, klippy_state: state.klippy, moonraker_version: 'v0.9.3' } });
    if (url.pathname === '/printer/info') return json(res, 200, { result: { state: state.klippy, hostname: 'voron', software_version: 'v0.12.0-300' } });
    if (url.pathname === '/server/files/upload' && req.method === 'POST') {
      if (opts.onUpload) return opts.onUpload(req, res);
      const mp = parseMultipart(await readBody(req), req.headers['content-type']);
      state.files.set(mp.file.name, mp.file.size);
      return json(res, 201, { result: { item: { path: mp.file.name, root: mp.fields.root } } });
    }
    if (url.pathname === '/server/files/metadata') return json(res, 200, { result: { estimated_time: 400, layer_count: 40, thumbnails: [] } });
    if (url.pathname === '/machine/update/status') {
      return json(res, 200, { result: { busy: false, version_info: {
        system: { package_count: 3, package_list: [] },
        klipper: { version: 'v0.12.0-300', remote_version: 'v0.12.0-310', commits_behind: new Array(10).fill({}), is_valid: true },
        mainsail: { version: 'v2.13.0', remote_version: 'v2.13.0', is_valid: true },
      } } });
    }
    if (url.pathname === '/machine/update/refresh') return json(res, 404, { error: { message: 'Not Found' } });
    if (url.pathname === '/machine/update/upgrade') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      state.upgrades.push(body.name || 'full');
      notify('notify_update_response', [{ application: body.name || 'full', message: 'Updating...', complete: false }]);
      setTimeout(() => notify('notify_update_response', [{ application: body.name || 'full', message: 'Update complete', complete: true }]), 20);
      return setTimeout(() => json(res, 200, { result: 'ok' }), 60);
    }
    json(res, 404, { error: { message: 'Not Found' } });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      const p = msg.params || {};
      switch (msg.method) {
        case 'server.connection.identify': return reply({ connection_id: 1 });
        case 'printer.info': return reply({ state: state.klippy, hostname: 'voron', software_version: 'v0.12.0-300' });
        case 'printer.objects.subscribe': return reply({ eventtime: 1, status: state.status });
        case 'server.webcams.list': return reply({ webcams: [{ name: 'cam', enabled: true, stream_url: '/webcam/?action=stream', snapshot_url: '/webcam/?action=snapshot' }] });
        case 'printer.gcode.script': {
          state.gcode.push(p.script);
          const m = /M104 T0 S(\d+)/.exec(p.script);
          if (m) update('extruder', { target: Number(m[1]) });
          notify('notify_gcode_response', ['ok']);
          return reply('ok');
        }
        case 'printer.print.start':
          if (!state.files.has(p.filename)) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 400, message: 'file non trovato' } }));
          runPrint(p.filename);
          return reply('ok');
        case 'printer.print.pause': update('print_stats', { state: 'paused' }); return reply('ok');
        case 'printer.print.resume': update('print_stats', { state: 'printing' }); return reply('ok');
        case 'printer.print.cancel': clearInterval(timer); update('print_stats', { state: 'cancelled' }); return reply('ok');
        case 'printer.emergency_stop': state.klippy = 'shutdown'; notify('notify_klippy_shutdown', []); return reply('ok');
        default: return ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 404, message: 'Method not found' } }));
      }
    });
  }));
  const port = await listen(server, opts.port);
  return {
    port, state, update,
    close() { clearInterval(timer); for (const ws of clients) ws.terminate(); return closeAll(server); },
  };
}

// --- PrusaLink ---------------------------------------------------------------------------

async function startFakePrusaLink(opts = {}) {
  const user = 'maker';
  const password = opts.password || 'segreta';
  const realm = 'Printer API';
  const state = { files: new Map(), job: null, printer: 'IDLE', uploads: 0 };
  let timer = null;
  const nonce = crypto.randomBytes(8).toString('hex');
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const authorized = (req) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) return false;
    const f = {};
    h.slice(7).replace(/(\w+)="?([^",]*)"?/g, (_, k, v) => { f[k] = v; });
    const ha1 = md5(`${user}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${f.uri}`);
    return f.username === user && f.nonce === nonce && f.response === md5(`${ha1}:${nonce}:${ha2}`);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!authorized(req)) {
      await readBody(req);
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", stale=false` });
      return res.end();
    }
    if (url.pathname === '/api/version') return json(res, 200, { api: '2.0.0', server: '2.1.2', text: 'PrusaLink', hostname: 'prusa-mk4', firmware: '6.1.3+8103' });
    if (url.pathname === '/api/v1/info') return json(res, 200, { hostname: 'prusa-mk4', serial: 'SN123' });
    if (url.pathname === '/api/v1/storage') return json(res, 200, { storage_list: [{ path: '/usb/', name: 'usb', available: true, read_only: false }] });
    if (url.pathname === '/api/v1/status') {
      const j = state.job;
      return json(res, 200, {
        printer: { state: state.printer, temp_nozzle: 215.2, target_nozzle: 215, temp_bed: 60.1, target_bed: 60, axis_z: 1.2, flow: 100, speed: 100 },
        ...(j ? { job: { id: j.id, progress: j.progress, time_remaining: j.remaining, time_printing: j.printing } } : {}),
      });
    }
    if (url.pathname === '/api/v1/job') {
      if (!state.job) { res.writeHead(204); return res.end(); }
      return json(res, 200, { id: state.job.id, state: state.printer, progress: state.job.progress, file: { name: state.job.file, display_name: state.job.file, size: 1234 } });
    }
    let m;
    if ((m = /^\/api\/v1\/files\/usb\/(.+)$/.exec(url.pathname)) && req.method === 'PUT') {
      const body = await readBody(req);
      const name = decodeURIComponent(m[1]);
      state.files.set(name, body.length);
      state.uploads++;
      if (req.headers['print-after-upload'] === '?1') {
        state.job = { id: 7 + state.uploads, file: name, progress: 0, remaining: 300, printing: 0 };
        state.printer = 'PRINTING';
        clearInterval(timer);
        timer = setInterval(() => {
          if (state.printer !== 'PRINTING') return;
          state.job.progress += 25;
          state.job.printing += 30;
          state.job.remaining = Math.max(0, state.job.remaining - 75);
          if (state.job.progress >= 100) { clearInterval(timer); state.printer = 'FINISHED'; state.job = null; }
        }, opts.stepMs || 400);
      }
      res.writeHead(201);
      return res.end();
    }
    if ((m = /^\/api\/v1\/job\/(\d+)\/(pause|resume)$/.exec(url.pathname)) && req.method === 'PUT') {
      state.printer = m[2] === 'pause' ? 'PAUSED' : 'PRINTING';
      res.writeHead(204);
      return res.end();
    }
    if (/^\/api\/v1\/job\/\d+$/.test(url.pathname) && req.method === 'DELETE') {
      clearInterval(timer);
      state.printer = 'STOPPED';
      state.job = null;
      res.writeHead(204);
      return res.end();
    }
    json(res, 404, {});
  });
  const port = await listen(server, opts.port);
  return { port, password, state, close() { clearInterval(timer); return closeAll(server); } };
}

// --- OctoPrint ---------------------------------------------------------------------------

async function startFakeOctoPrint(opts = {}) {
  const apiKey = opts.apiKey || 'CHIAVE-OCTO';
  const state = { files: new Map(), commands: [], targets: {}, flags: { operational: true, printing: false, paused: false, cancelling: false, pausing: false, error: false, closedOrError: false, ready: true }, job: null, updates: [], appkeyRequests: 0 };
  let timer = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/plugin/appkeys/probe') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/plugin/appkeys/request' && req.method === 'POST') {
      await readBody(req);
      state.appkeyRequests++;
      return json(res, 201, { app_token: 'tok123' });
    }
    if (url.pathname === '/plugin/appkeys/request/tok123') {
      return state.appkeyRequests >= 1 && opts.approve !== false ? json(res, 200, { api_key: apiKey }) : json(res, 404, {});
    }
    if (url.pathname === '/') { res.writeHead(302, { Location: '/login/?redirect=%2F' }); return res.end(); }
    if (url.pathname === '/login/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>OctoPrint Login</title></head></html>'); }
    if (req.headers['x-api-key'] !== apiKey) { await readBody(req); return json(res, 403, { error: 'Forbidden' }); }
    if (url.pathname === '/api/version') return json(res, 200, { api: '0.1', server: '1.10.3', text: 'OctoPrint 1.10.3' });
    if (url.pathname === '/api/connection') return json(res, 200, { current: { state: 'Operational' } });
    if (url.pathname === '/api/settings') return json(res, 200, { webcam: { webcamEnabled: true, streamUrl: '/webcam/?action=stream', snapshotUrl: '' } });
    if (url.pathname === '/api/printer' && req.method === 'GET') {
      return json(res, 200, { temperature: { tool0: { actual: 200.5, target: state.targets.tool0 || 0 }, bed: { actual: 59.9, target: state.targets.bed || 0 } }, state: { text: 'Operational', flags: state.flags } });
    }
    if (url.pathname === '/api/job' && req.method === 'GET') {
      const j = state.job;
      return json(res, 200, { job: { file: { name: j ? j.file : null, size: j ? 100 : null }, estimatedPrintTime: 400 }, progress: { completion: j ? j.completion : null, printTime: j ? j.time : null, printTimeLeft: j ? 400 - j.time : null }, state: state.flags.printing ? 'Printing' : 'Operational' });
    }
    if (url.pathname === '/api/job' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString());
      if (b.command === 'pause') { state.flags.paused = b.action === 'pause'; state.flags.printing = b.action !== 'pause'; }
      if (b.command === 'cancel') { clearInterval(timer); state.flags.printing = false; state.flags.paused = false; state.job = null; state.lastCancel = true; }
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/api/files/local' && req.method === 'POST') {
      const mp = parseMultipart(await readBody(req), req.headers['content-type']);
      state.files.set(mp.file.name, mp.file.size);
      if (mp.fields.print === 'true') {
        state.job = { file: mp.file.name, completion: 0, time: 0 };
        state.flags.printing = true;
        clearInterval(timer);
        timer = setInterval(() => {
          if (!state.flags.printing) return;
          state.job.completion += 25;
          state.job.time += 100;
          if (state.job.completion >= 100) { clearInterval(timer); state.flags.printing = false; state.job.completion = 100; }
        }, opts.stepMs || 400);
      }
      return json(res, 201, { done: true });
    }
    if (url.pathname === '/api/printer/tool' || url.pathname === '/api/printer/bed') {
      const b = JSON.parse((await readBody(req)).toString());
      if (b.targets) Object.assign(state.targets, b.targets);
      if (url.pathname.endsWith('/bed') && b.target !== undefined) state.targets.bed = b.target;
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/api/printer/command' || url.pathname === '/api/printer/printhead') {
      state.commands.push(JSON.parse((await readBody(req)).toString()));
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/plugin/softwareupdate/check') {
      return json(res, 200, { status: 'updateAvailable', information: { octoprint: { displayName: 'OctoPrint', updateAvailable: true, updatePossible: true, information: { local: { name: '1.10.3', value: '1.10.3' }, remote: { name: '1.11.0', value: '1.11.0' } } } } });
    }
    if (url.pathname === '/plugin/softwareupdate/update') {
      state.updates.push(JSON.parse((await readBody(req)).toString()).targets);
      return json(res, 200, { order: ['octoprint'] });
    }
    json(res, 404, { error: 'Not found' });
  });
  const port = await listen(server, opts.port);
  return { port, apiKey, state, close() { clearInterval(timer); return closeAll(server); } };
}

module.exports = { startFakeMoonraker, startFakePrusaLink, startFakeOctoPrint, parseMultipart };
