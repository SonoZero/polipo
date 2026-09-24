'use strict';

// Stampante Bambu Lab finta per i test: broker MQTT su TLS, FTPS implicito
// (quanto basta per caricare un file) e telecamera JPEG delle serie P1/A1.

const tls = require('tls');
const fs = require('fs');
const path = require('path');

const KEY = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'fake-printer-key.pem'));
const CERT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'fake-printer-cert.pem'));
const SERIAL = '01P00A123456789';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function startFakeBambu(opts = {}) {
  const accessCode = opts.accessCode || '12345678';
  const { Aedes } = await import('aedes');
  const broker = await Aedes.createBroker();
  const state = {
    requests: [],
    files: new Map(),
    report: {
      gcode_state: 'IDLE', mc_percent: 0, mc_remaining_time: 0, layer_num: 0, total_layer_num: 0,
      nozzle_temper: 25, nozzle_target_temper: 0, bed_temper: 24, bed_target_temper: 0,
      cooling_fan_speed: '0', spd_lvl: 2, spd_mag: 100, subtask_name: '', wifi_signal: '-50dBm',
      lights_report: [{ node: 'chamber_light', mode: 'off' }], stg_cur: -1, print_error: 0,
      ams: { ams: [{ id: '0', humidity: '4', tray: [{ id: '0', tray_type: 'PLA', tray_color: 'FF6A00FF', remain: 80 }] }], tray_now: '255' },
    },
    refuse: false,
    printTimer: null,
  };
  broker.authenticate = (client, username, password, cb) => {
    const ok = username === 'bblp' && password && password.toString() === accessCode;
    if (ok) return cb(null, true);
    const err = new Error('Not authorized');
    err.returnCode = 5;
    cb(err, null);
  };
  const reportTopic = `device/${SERIAL}/report`;
  const publish = (obj) => broker.publish({ topic: reportTopic, payload: Buffer.from(JSON.stringify(obj)), qos: 0, retain: false }, () => {});
  const pushStatus = (fields) => {
    Object.assign(state.report, fields || {});
    publish({ print: { command: 'push_status', sequence_id: '0', ...(fields || state.report) } });
  };

  function runPrint(name) {
    clearInterval(state.printTimer);
    pushStatus({ gcode_state: 'PREPARE', subtask_name: name.replace(/(\.gcode)?\.3mf$/i, ''), mc_percent: 0, mc_remaining_time: 10, total_layer_num: 20, layer_num: 0, gcode_start_time: String(Math.floor(Date.now() / 1000)) });
    let pct = 0;
    state.printTimer = setInterval(() => {
      if (state.report.gcode_state === 'PAUSE') return;
      pct += 25;
      if (pct >= 100) {
        clearInterval(state.printTimer);
        pushStatus({ gcode_state: 'FINISH', mc_percent: 100, mc_remaining_time: 0, layer_num: 20 });
        return;
      }
      pushStatus({ gcode_state: 'RUNNING', mc_percent: pct, mc_remaining_time: Math.round((100 - pct) / 10), layer_num: pct / 5 });
    }, opts.stepMs || 150);
  }

  broker.subscribe(`device/${SERIAL}/request`, (packet, cb) => {
    let msg = null;
    try { msg = JSON.parse(packet.payload.toString()); } catch (_) { /* ignora */ }
    cb();
    if (!msg) return;
    state.requests.push(msg);
    const p = msg.print || {};
    if (msg.pushing && msg.pushing.command === 'pushall') return pushStatus();
    if (msg.info && msg.info.command === 'get_version') {
      return publish({ info: { command: 'get_version', sequence_id: msg.info.sequence_id, module: [
        { name: 'ota', sw_ver: '01.08.02.00', hw_ver: 'OTA', product_name: 'Bambu Lab P1S', sn: SERIAL },
        { name: 'mc', sw_ver: '00.00.25.44', hw_ver: 'MC04', sn: SERIAL },
      ] } });
    }
    if (state.refuse && p.command) {
      return publish({ print: { command: p.command, sequence_id: p.sequence_id, result: 'failed', reason: 'auth', err_code: 84033543 } });
    }
    if (msg.system && msg.system.command === 'ledctrl') return pushStatus({ lights_report: [{ node: 'chamber_light', mode: msg.system.led_mode }] });
    switch (p.command) {
      case 'project_file': {
        const file = String(p.url).replace(/^(file:\/\/\/sdcard\/|ftp:\/\/\/)/, '');
        if (!state.files.has(file)) return publish({ print: { command: 'project_file', result: 'failed', reason: 'file not found' } });
        return runPrint(file);
      }
      case 'gcode_file': {
        const file = String(p.param).replace(/^\/sdcard\//, '');
        return state.files.has(file) ? runPrint(file) : null;
      }
      case 'pause': return pushStatus({ gcode_state: 'PAUSE' });
      case 'resume': return pushStatus({ gcode_state: 'RUNNING' });
      case 'stop':
        clearInterval(state.printTimer);
        return pushStatus({ gcode_state: 'FAILED', print_error: 50348044 });
      case 'gcode_line': {
        const m = /M104 S(\d+)/.exec(p.param);
        if (m) pushStatus({ nozzle_target_temper: Number(m[1]) });
        const b = /M140 S(\d+)/.exec(p.param);
        if (b) pushStatus({ bed_target_temper: Number(b[1]) });
        return null;
      }
      case 'print_speed': return pushStatus({ spd_lvl: Number(p.param) });
      default: return null;
    }
  }, () => {});

  const mqttServer = tls.createServer({ key: KEY, cert: CERT }, broker.handle);
  const mqttPort = await listen(mqttServer, opts.mqttPort);

  // --- FTPS implicito ------------------------------------------------------------------
  const sockets = new Set();
  const ftpServer = tls.createServer({ key: KEY, cert: CERT }, (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let user = null;
    let authed = false;
    let pasv = null;
    let buf = '';
    const say = (line) => sock.write(line + '\r\n');
    say('220 Fake Bambu FTP');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : line.slice(sp + 1);
        if (cmd === 'USER') { user = arg; say('331 Password required'); }
        else if (cmd === 'PASS') {
          authed = user === 'bblp' && arg === accessCode;
          say(authed ? '230 Logged in' : '530 Login incorrect');
        } else if (!authed) say('530 Not logged in');
        else if (cmd === 'FEAT') { sock.write('211-Features:\r\n EPSV\r\n PASV\r\n SIZE\r\n211 End\r\n'); }
        else if (['TYPE', 'STRU', 'OPTS', 'PBSZ', 'PROT'].includes(cmd)) say('200 OK');
        else if (cmd === 'PWD') say('257 "/"');
        else if (cmd === 'EPSV' || cmd === 'PASV') {
          const data = { chunks: [], socket: null, done: null };
          const srv = tls.createServer({ key: KEY, cert: CERT }, (ds) => {
            data.socket = ds;
            ds.on('data', (c) => data.chunks.push(c));
            ds.on('end', () => { if (data.done) data.done(); });
            ds.on('error', () => {});
          });
          srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            pasv = { srv, data };
            if (cmd === 'EPSV') say(`229 Entering Extended Passive Mode (|||${port}|)`);
            else say(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
          });
        } else if (cmd === 'STOR') {
          const p = pasv;
          pasv = null;
          if (!p) { say('425 Use PASV first'); continue; }
          say('150 Ok to send data');
          const finish = () => {
            state.files.set(arg.replace(/^\//, ''), Buffer.concat(p.data.chunks));
            p.srv.close();
            say('226 Transfer complete');
          };
          if (p.data.socket && p.data.socket.readableEnded) finish();
          else p.data.done = finish;
        } else if (cmd === 'SIZE') {
          const f = state.files.get(arg.replace(/^\//, ''));
          say(f ? `213 ${f.length}` : '550 No such file');
        } else if (cmd === 'QUIT') { say('221 Bye'); sock.end(); }
        else say('502 Not implemented');
      }
    });
  });
  const ftpPort = await listen(ftpServer, opts.ftpPort);

  // --- telecamera JPEG -----------------------------------------------------------------
  const camServer = tls.createServer({ key: KEY, cert: CERT }, (sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.once('data', (auth) => {
      const pass = auth.subarray(48, 80).toString('ascii').replace(/\0+$/, '');
      if (pass !== accessCode) return sock.destroy();
      const frame = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'camera.jpg'));
      const send = () => {
        const head = Buffer.alloc(16);
        head.writeUInt32LE(frame.length, 0);
        head.writeUInt32LE(1, 8);
        sock.write(Buffer.concat([head, frame]));
      };
      send();
      const t = setInterval(send, 100);
      sock.on('close', () => { clearInterval(t); sockets.delete(sock); });
    });
  });
  const cameraPort = await listen(camServer, opts.cameraPort);

  return {
    serial: SERIAL,
    accessCode,
    mqttPort,
    ftpPort,
    cameraPort,
    state,
    pushStatus,
    async close() {
      clearInterval(state.printTimer);
      for (const s of sockets) s.destroy();
      await new Promise((r) => broker.close(() => r()));
      await Promise.all([mqttServer, ftpServer, camServer].map((s) => new Promise((r) => s.close(() => r()))));
    },
  };
}

module.exports = { startFakeBambu, SERIAL };
