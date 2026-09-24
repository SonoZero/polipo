// Avvio dell'interfaccia: tema, barra laterale, navigazione tra le pagine.

import { h, icon, clear, setText, STATE_LABELS, fmtPct } from './util.js';
import { store, on, connectSocket, printerList } from './api.js';
import { toast } from './ui.js';
import { mountDashboard } from './views/dashboard.js';
import { mountPrinter } from './views/printer.js';
import { mountFiles } from './views/files.js';
import { mountHistory } from './views/history.js';
import { mountSettings } from './views/settings.js';
import { openPrinterForm } from './views/printer-form.js';
import { applyTheme } from './theme.js';
import { createUpdateBanner } from './updates.js';

applyTheme();
const updateBanner = createUpdateBanner();

// --- barra laterale ----------------------------------------------------------------

const sidebar = document.getElementById('sidebar');
const main = document.getElementById('main');
let sideRefs = new Map();

function renderSidebar() {
  clear(sidebar);
  const route = parseRoute();
  const navItem = (href, ic, label, active, count) => h('a', { class: 'nav-item' + (active ? ' active' : ''), href },
    icon(ic), h('span', null, label), count !== undefined ? h('span', { class: 'nav-count' }, count) : null);

  sidebar.append(
    h('div', { class: 'brand' },
      h('img', { src: 'img/icon.svg', alt: '' }),
      h('div', null, h('div', { class: 'brand-name' }, 'Polipo'), h('div', { class: 'brand-sub' }, 'Controllo stampanti 3D'))),
    h('nav', { class: 'nav' },
      navItem('#/', 'grid', 'Panoramica', route.name === 'dashboard'),
      navItem('#/files', 'files', 'File G-code', route.name === 'files', store.files.length || undefined),
      navItem('#/history', 'history', 'Cronologia', route.name === 'history'),
      navItem('#/settings', 'settings', 'Impostazioni', route.name === 'settings')),
    h('div', { class: 'side-section' }, 'Stampanti',
      h('button', { class: 'btn ghost icon-only sm', title: 'Aggiungi stampante', onclick: () => openPrinterForm() }, icon('plus', 'sm'))),
  );

  const list = h('div', { class: 'side-printers' });
  sideRefs = new Map();
  for (const p of printerList()) {
    const refs = {};
    const el = h('a', { class: 'side-printer' + (route.name === 'printer' && route.id === p.id ? ' active' : ''), href: `#/printer/${p.id}` },
      refs.dot = h('span', { class: 'dot' }),
      refs.name = h('span', { class: 'name' }),
      refs.pct = h('span', { class: 'faint num', style: { fontSize: '12px' } }),
      refs.sub = h('span', { class: 'sub' }),
      refs.bar = h('div', { class: 'mini-bar' }, refs.fill = h('div')));
    refs.el = el;
    sideRefs.set(p.id, refs);
    list.appendChild(el);
    updateSidePrinter(p);
  }
  if (!store.order.length) {
    list.appendChild(h('div', { class: 'faint', style: { padding: '8px 10px', fontSize: '13px' } }, 'Nessuna stampante configurata.'));
  }
  sidebar.appendChild(list);
  sidebar.appendChild(h('div', { class: 'side-footer' },
    updateBanner.el,
    h('button', { class: 'btn block', onclick: () => openPrinterForm() }, icon('plus'), 'Aggiungi stampante')));
}

function updateSidePrinter(p) {
  const r = sideRefs.get(p.id);
  if (!r) return;
  setText(r.name, p.config.name);
  r.dot.style.background = p.config.color;
  r.dot.style.boxShadow = p.state === 'offline' ? 'none' : `0 0 0 3px color-mix(in srgb, ${p.config.color} 30%, transparent)`;
  r.dot.style.opacity = p.state === 'offline' ? 0.45 : 1;
  const printing = !!p.job;
  let sub = STATE_LABELS[p.state] || p.state;
  const t0 = p.temps && p.temps.tools && p.temps.tools.T0;
  if (p.state !== 'offline' && t0 && t0.actual !== null) sub += ` · ${Math.round(t0.actual)}°`;
  setText(r.sub, sub);
  r.sub.style.color = p.state === 'error' ? 'var(--danger)' : '';
  setText(r.pct, printing ? fmtPct(p.job.progress) : '');
  r.bar.hidden = !printing;
  if (printing) r.fill.style.width = (p.job.progress * 100).toFixed(1) + '%';
}

// --- navigazione -----------------------------------------------------------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return { name: 'dashboard' };
  if (parts[0] === 'printer' && parts[1]) return { name: 'printer', id: parts[1], tab: parts[2] || 'control' };
  if (['files', 'history', 'settings'].includes(parts[0])) return { name: parts[0] };
  return { name: 'dashboard' };
}

let current = null;
let currentKey = '';

function renderRoute() {
  const route = parseRoute();
  const key = route.name + ':' + (route.id || '');
  if (current && key === currentKey && current.setTab && route.tab) {
    current.setTab(route.tab);
    renderSidebar();
    return;
  }
  if (current && current.destroy) current.destroy();
  current = null;
  clear(main);
  main.scrollTop = 0;
  currentKey = key;
  const container = h('div', { class: 'page' });
  main.appendChild(container);
  if (!store.ready) {
    container.appendChild(h('div', { class: 'empty' }, h('p', null, 'Caricamento…')));
  } else if (route.name === 'printer') {
    if (!store.printers.has(route.id)) { location.hash = '#/'; return; }
    current = mountPrinter(container, route.id, route.tab);
  } else if (route.name === 'files') current = mountFiles(container);
  else if (route.name === 'history') current = mountHistory(container);
  else if (route.name === 'settings') current = mountSettings(container);
  else current = mountDashboard(container);
  renderSidebar();
}

window.addEventListener('hashchange', renderRoute);

// --- eventi dal servizio ------------------------------------------------------------

on('ready', () => { currentKey = ''; renderRoute(); });
on('printers', () => {
  const route = parseRoute();
  if (route.name === 'printer' && !store.printers.has(route.id)) location.hash = '#/';
  renderSidebar();
});
on('printer', (p) => updateSidePrinter(p));
on('files', () => renderSidebar());
on('connection', (ok) => { document.getElementById('conn-banner').hidden = ok; });

let toastedUpdate = null;
on('app', () => {
  const a = store.app;
  if (a.status === 'downloaded' && toastedUpdate !== a.version) {
    toastedUpdate = a.version;
    toast('success', 'Aggiornamento pronto', `Polipo ${a.version} è stato scaricato: si installa al riavvio.`, 8000);
  }
});

const isElectron = navigator.userAgent.includes('Electron');
on('notify', (n) => {
  if (n.quiet && n.level === 'info') return;
  toast(n.level, n.title, n.message, n.level === 'error' ? 12000 : 6000);
  // nell'app desktop le notifiche di sistema le mostra il processo principale
  if (!isElectron && store.settings.notifications && !n.quiet && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(n.title || 'Polipo', { body: n.message, icon: 'img/icon.svg' });
  }
});

connectSocket();
renderRoute();
