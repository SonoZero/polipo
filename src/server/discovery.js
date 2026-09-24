'use strict';

// Ricerca delle stampanti in rete:
// - Bambu Lab: annunci SSDP sulle porte UDP 2021 e 1990, più il certificato TLS sulla 8883;
// - OctoPrint e Klipper: annunci mDNS (_octoprint._tcp, _moonraker._tcp);
// - Klipper, PrusaLink e OctoPrint: controllo rapido degli indirizzi della rete di casa.

const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const { HttpClient } = require('./printers/http');
const { modelName, BAMBU_CA } = require('./printers/bambu');
const { lanAddresses, localScanTargets } = require('./netinfo');

const SSDP_ADDR = '239.255.255.250';
const BAMBU_ST = 'urn:bambulab-com:device:3dprinter:1';

/**
 * @param {object} o { timeout (ms), scan (bool), hosts (indirizzi da controllare, per i test), ssdpPorts }
 * @returns {Promise<Array>} [{ type, host, port, name, model, serial, via }]
 */
async function discoverPrinters(o = {}) {
  const timeout = o.timeout || 7000;
  const found = new Map();
  const add = (r) => {
    const key = `${r.type}|${r.host}|${r.port || ''}`;
    const prev = found.get(key);
    found.set(key, prev ? { ...prev, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined)) } : r);
  };
  await Promise.all([
    listenBambu(timeout, add, o.ssdpPorts || [2021, 1990]).catch(() => {}),
    browseMdns(Math.min(timeout, 5000), add).catch(() => {}),
    o.scan === false ? null : scanHosts(o.hosts || localScanTargets(), add).catch(() => {}),
  ]);
  // un Bambu trovato sia via SSDP sia via TLS è la stessa stampante
  const list = [...found.values()];
  return list
    .filter((r, i) => !(r.type === 'bambu' && r.via === 'tls' && list.some((x, j) => j !== i && x.type === 'bambu' && x.host === r.host && x.via === 'ssdp')))
    .sort((a, b) => a.type.localeCompare(b.type) || ipSort(a.host, b.host));
}

function ipSort(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// --- Bambu Lab: SSDP -----------------------------------------------------------------

function parseSsdp(text) {
  const headers = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function bambuFromSsdp(text, fromAddress) {
  if (!/bambulab-com:device:3dprinter/i.test(text)) return null;
  const h = parseSsdp(text);
  const host = (h.location || fromAddress || '').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  if (!host) return null;
  const code = h['devmodel.bambu.com'] || null;
  return {
    type: 'bambu',
    host,
    port: null,
    name: h['devname.bambu.com'] || 'Bambu Lab',
    model: modelName(code) || (code ? `Bambu Lab (${code})` : 'Bambu Lab'),
    serial: h.usn ? h.usn.replace(/^uuid:/i, '').split('::')[0] : null,
    lanMode: h['devconnect.bambu.com'] ? /lan/i.test(h['devconnect.bambu.com']) : null,
    firmware: h['devversion.bambu.com'] || null,
    via: 'ssdp',
  };
}

function listenBambu(timeout, add, ports) {
  const sockets = [];
  const memberships = lanAddresses().filter((a) => a.kind === 'lan').map((a) => a.address);
  const search = Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDR}:1990`,
    'MAN: "ssdp:discover"',
    'MX: 3',
    `ST: ${BAMBU_ST}`,
    '', '',
  ].join('\r\n'));
  return new Promise((resolve) => {
    for (const port of ports) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      s.on('error', () => {});
      s.on('message', (msg, rinfo) => {
        const r = bambuFromSsdp(msg.toString('utf8'), rinfo.address);
        if (r) add(r);
      });
      s.bind(port, () => {
        for (const addr of memberships) { try { s.addMembership(SSDP_ADDR, addr); } catch (_) { /* scheda senza multicast */ } }
        try { s.setBroadcast(true); } catch (_) { /* ignora */ }
        for (const p of [1990, 2021]) s.send(search, p, SSDP_ADDR, () => {});
      });
    }
    setTimeout(() => {
      for (const s of sockets) { try { s.close(); } catch (_) { /* già chiuso */ } }
      resolve();
    }, timeout);
  });
}

// --- mDNS ------------------------------------------------------------------------------

const MDNS_SERVICES = {
  '_octoprint._tcp.local': 'octoprint',
  '_moonraker._tcp.local': 'klipper',
};

function browseMdns(timeout, add) {
  let mdns;
  try { mdns = require('multicast-dns')({ reuseAddr: true }); } catch (_) { return Promise.resolve(); }
  const instances = new Map(); // nome istanza -> tipo
  const srv = new Map(); // nome istanza -> { target, port }
  const addrs = new Map(); // hostname -> ip
  mdns.on('error', () => {});
  mdns.on('response', (res) => {
    for (const r of [...(res.answers || []), ...(res.additionals || [])]) {
      if (r.type === 'PTR' && MDNS_SERVICES[r.name]) instances.set(r.data, MDNS_SERVICES[r.name]);
      else if (r.type === 'SRV') srv.set(r.name, { target: r.data.target, port: r.data.port });
      else if (r.type === 'A') addrs.set(r.name, r.data);
    }
  });
  const ask = () => mdns.query({ questions: Object.keys(MDNS_SERVICES).map((name) => ({ name, type: 'PTR' })) });
  ask();
  const again = setTimeout(ask, 1500);
  return new Promise((resolve) => {
    setTimeout(() => {
      clearTimeout(again);
      for (const [instance, type] of instances) {
        const s = srv.get(instance);
        if (!s) continue;
        const ip = addrs.get(s.target);
        if (!ip) continue;
        const label = instance.split('._')[0];
        add({ type, host: ip, port: type === 'klipper' && s.port === 7125 ? null : (s.port === 80 ? null : s.port), name: label, via: 'mdns' });
      }
      mdns.destroy();
      resolve();
    }, timeout);
  });
}

// --- controllo degli indirizzi -------------------------------------------------------

function portOpen(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function scanHosts(hosts, add) {
  const checks = [];
  for (const host of hosts) for (const port of [7125, 80, 5000, 8883]) checks.push({ host, port });
  const open = [];
  await pool(checks, 160, async (c) => { if (await portOpen(c.host, c.port)) open.push(c); });
  await pool(open, 24, async (c) => {
    const r = await identify(c.host, c.port).catch(() => null);
    if (r) add(r);
  });
}

/** Che stampante c'è a questo indirizzo e porta? */
async function identify(host, port) {
  if (port === 8883) return identifyBambu(host);
  const client = new HttpClient({ base: `http://${host}:${port}` });
  const get = (p) => client.request('GET', p, { timeout: 1800 }).catch(() => null);
  const info = await get('/server/info');
  if (info && info.status === 200 && info.data && info.data.result && 'klippy_state' in info.data.result) {
    const pi = await get('/printer/info');
    const hostname = pi && pi.data && pi.data.result ? pi.data.result.hostname : null;
    return { type: 'klipper', host, port: port === 7125 ? null : port, name: hostname || 'Klipper', via: 'scan' };
  }
  if (port === 7125) return null;
  const ver = await get('/api/version');
  if (ver) {
    const auth = String(ver.headers['www-authenticate'] || '');
    const text = ver.data ? String(ver.data.text || '') : '';
    if (/Printer API/i.test(auth) || /prusalink/i.test(text)) {
      return { type: 'prusalink', host, port: port === 80 ? null : port, name: (ver.data && ver.data.hostname) || 'Prusa', via: 'scan' };
    }
    if (/octoprint/i.test(text) || /octoprint/i.test(ver.text || '')) {
      return { type: 'octoprint', host, port: port === 80 ? null : port, name: 'OctoPrint', via: 'scan' };
    }
  }
  let root = await get('/');
  // OctoPrint senza accesso rimanda alla pagina di login
  if (root && root.status >= 300 && root.status < 400 && root.headers.location) {
    const loc = new URL(root.headers.location, `http://${host}:${port}/`);
    if (loc.host === `${host}:${port}` || loc.hostname === host) root = await get(loc.pathname + loc.search);
  }
  if (root && /octoprint/i.test(root.text || '')) return { type: 'octoprint', host, port: port === 80 ? null : port, name: 'OctoPrint', via: 'scan' };
  if (root && /prusa ?link/i.test(root.text || '')) return { type: 'prusalink', host, port: port === 80 ? null : port, name: 'Prusa', via: 'scan' };
  return null;
}

function identifyBambu(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 8883, ca: BAMBU_CA, rejectUnauthorized: false, checkServerIdentity: () => undefined });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(2500, () => done(null));
    s.once('error', () => done(null));
    s.once('secureConnect', () => {
      const cert = s.getPeerCertificate();
      const issuer = cert && cert.issuer ? `${cert.issuer.O || ''} ${cert.issuer.CN || ''}` : '';
      if (!/BBL|Bambu/i.test(issuer)) return done(null);
      const serial = cert.subject && cert.subject.CN ? String(cert.subject.CN).toUpperCase() : null;
      done({ type: 'bambu', host, port: null, name: 'Bambu Lab', model: null, serial, via: 'tls' });
    });
  });
}

/** Controllo di un indirizzo scritto a mano: prova tutti i tipi conosciuti. */
async function probeHost(host) {
  const results = [];
  for (const port of [7125, 80, 5000, 8883]) {
    if (!(await portOpen(host, port, 1500))) continue;
    const r = await identify(host, port).catch(() => null);
    if (r) results.push(r);
  }
  return results;
}

module.exports = { discoverPrinters, probeHost, identify, bambuFromSsdp, parseSsdp };
