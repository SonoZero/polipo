'use strict';

// Indirizzi di rete del PC: quelli raggiungibili dal telefono e le reti locali in cui cercare stampanti.

const os = require('os');

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
      out.push({ address: a.address, netmask: a.netmask, name, kind });
    }
  }
  // prima la rete di casa, poi Tailscale, poi le altre VPN
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

function ipToInt(ip) {
  return ip.split('.').reduce((n, p) => (n * 256) + Number(p), 0);
}

function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Indirizzi delle reti di casa in cui cercare le stampanti (al massimo 254 per scheda:
 * con reti più grandi si cerca solo nel blocco /24 del PC).
 */
function localScanTargets() {
  const hosts = new Set();
  const own = new Set();
  for (const a of lanAddresses()) {
    if (a.kind !== 'lan') continue;
    own.add(a.address);
    const ip = ipToInt(a.address);
    let mask = ipToInt(a.netmask || '255.255.255.0');
    if ((~mask >>> 0) > 255) mask = ipToInt('255.255.255.0');
    const net = (ip & mask) >>> 0;
    const broadcast = (net | (~mask >>> 0)) >>> 0;
    for (let h = net + 1; h < broadcast; h++) hosts.add(intToIp(h));
  }
  for (const o of own) hosts.delete(o);
  // anche questo PC: OctoPrint o Klipper possono girare qui
  return ['127.0.0.1', ...hosts];
}

module.exports = { lanAddresses, localScanTargets, VIRTUAL_NICS };
