// Utility per DOM, formattazione e icone.

import { ICONS } from './icons.js';

/** Crea un elemento: h('div', {class: 'x', onclick: fn}, 'testo', figlio) */
export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function setText(el, text) {
  const s = text === null || text === undefined ? '' : String(text);
  if (el && el.textContent !== s) el.textContent = s;
}

// --- icone (Phosphor, generate da scripts/build-assets.js) -------------------------

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('class', 'icon ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// --- formattazione --------------------------------------------------------------

export function fmtDuration(sec, { short = false } = {}) {
  if (sec === null || sec === undefined || !isFinite(sec)) return '-';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  if (d) return `${d}g ${hh}h`;
  if (hh) return `${hh}h ${String(mm).padStart(2, '0')}m`;
  if (mm) return short ? `${mm}m` : `${mm}m ${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return 'domani ' + time;
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }) + ' ' + time;
}

export function fmtDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(ts) {
  if (!ts) return '-';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'adesso';
  if (diff < 3600) return `${Math.floor(diff / 60)} min fa`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h fa`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} g fa`;
  return new Date(ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

export function fmtFilament(mm, g) {
  if (!mm && !g) return '-';
  const parts = [];
  if (mm) parts.push((mm / 1000).toFixed(2).replace('.', ',') + ' m');
  if (g) parts.push(Math.round(g) + ' g');
  return parts.join(' · ');
}

export function fmtTemp(v) {
  if (v === null || v === undefined || !isFinite(v)) return '-';
  return v.toFixed(1).replace('.', ',') + '°';
}

export function fmtPct(p) {
  if (p === null || p === undefined) return '-';
  return (Math.floor(p * 1000) / 10).toFixed(1).replace('.', ',') + '%';
}

export const STATE_LABELS = {
  offline: 'Non connessa',
  connecting: 'Connessione…',
  sending: 'Invio del file…',
  operational: 'Pronta',
  printing: 'In stampa',
  pausing: 'Pausa in corso…',
  paused: 'In pausa',
  cancelling: 'Annullamento…',
  error: 'Errore',
};

export function stateBadge(state) {
  return h('span', { class: 'badge s-' + state }, STATE_LABELS[state] || state);
}

export function heaterLabel(key, extruders) {
  if (key === 'B' || key === 'bed') return 'Piatto';
  if (key === 'C' || key === 'chamber') return 'Camera';
  if (extruders > 1) return 'Ugello ' + (parseInt(key.slice(1), 10) + 1);
  return 'Ugello';
}

export function heaterColor(key) {
  if (key === 'B' || key === 'bed') return 'var(--bed)';
  if (key === 'C' || key === 'chamber') return 'var(--chamber)';
  return key === 'T0' ? 'var(--hotend)' : 'var(--hotend-2)';
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// --- tipi di stampante ------------------------------------------------------------

export const PRINTER_TYPES = {
  usb: { label: 'USB', icon: 'usb', desc: 'Marlin, Prusa, RepRap: collegata al PC con il cavo.' },
  bambu: { label: 'Bambu Lab', icon: 'wifi', desc: 'X1, P1, A1 e H2 in rete locale.' },
  klipper: { label: 'Klipper', icon: 'chip', desc: 'Moonraker, Mainsail o Fluidd: Creality K1, Sovol SV08, Voron.' },
  prusalink: { label: 'PrusaLink', icon: 'network', desc: 'Prusa MK4, Core One, MINI+ e XL in rete.' },
  octoprint: { label: 'OctoPrint', icon: 'broadcast', desc: 'Stampanti già collegate a un OctoPrint.' },
};

/** Dove si trova la stampante: porta USB oppure indirizzo di rete. */
export function connectionLabel(p) {
  if ((p.type || 'usb') === 'usb') {
    const port = p.port || p.config.port;
    if (port === 'VIRTUAL') return 'Stampante virtuale';
    return port || 'Porta non impostata';
  }
  const net = p.config.net || {};
  return p.host || (net.host ? net.host + (net.port ? ':' + net.port : '') : 'Indirizzo non impostato');
}
