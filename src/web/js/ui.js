// Componenti di interfaccia riutilizzabili: modali, conferme, menu, notifiche.

import { h, icon } from './util.js';

const modalRoot = () => document.getElementById('modal-root');

/**
 * Apre una finestra modale. `render(close)` ritorna { body, footer? }.
 * Ritorna una funzione per chiuderla.
 */
export function openModal({ title, size = '', body, footer, onClose, dismissable = true }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  const modal = h('div', { class: 'modal ' + size, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'btn ghost icon-only sm', title: 'Chiudi', onclick: close }, icon('x')),
    ),
    h('div', { class: 'modal-body' }, typeof body === 'function' ? body(close) : body),
    footer ? h('div', { class: 'modal-foot' }, typeof footer === 'function' ? footer(close) : footer) : null,
  );
  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissable) close(); });
  document.addEventListener('keydown', onKey);
  modalRoot().appendChild(backdrop);
  const first = modal.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return close;
}

export function confirmDialog({ title, message, confirmLabel = 'Conferma', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const close = openModal({
      title,
      size: 'narrow',
      body: h('p', { style: { margin: 0, color: 'var(--text-dim)' } }, message),
      footer: (c) => [
        h('button', { class: 'btn', onclick: () => c() }, 'Annulla'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { result = true; c(); } }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
    void close;
  });
}

/** Menu contestuale posizionato sotto un elemento. items: [{label, icon, onClick, disabled, dot}] */
export function openMenu(anchor, items) {
  closeMenus();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.section) { menu.appendChild(h('div', { class: 'menu-label' }, it.section)); continue; }
    menu.appendChild(h('button', {
      class: 'menu-item',
      disabled: !!it.disabled,
      title: it.title || null,
      onclick: () => { closeMenus(); it.onClick(); },
    },
    it.dot ? h('span', { class: 'dot', style: { background: it.dot } }) : (it.icon ? icon(it.icon, 'sm') : null),
    h('span', { class: 'grow' }, it.label),
    it.hint ? h('span', { class: 'faint', style: { fontSize: '12px' } }, it.hint) : null));
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 10);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 10) top = r.top - mh - 6;
  menu.style.left = Math.max(10, left) + 'px';
  menu.style.top = Math.max(10, top) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
  function outside(e) { if (!menu.contains(e.target)) closeMenus(); }
  menu._cleanup = () => document.removeEventListener('mousedown', outside);
}

export function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => { if (m._cleanup) m._cleanup(); m.remove(); });
}

export function toast(level, title, message, timeout = 5000) {
  const root = document.getElementById('toasts');
  const icons = { success: 'checkCircle', error: 'alert', warn: 'alert', info: 'info' };
  const el = h('div', { class: 'toast ' + level },
    icon(icons[level] || 'info'),
    h('div', { class: 'grow' },
      title ? h('div', { class: 't-title' }, title) : null,
      message ? h('div', { class: 't-msg' }, message) : null),
    h('button', { class: 'btn ghost icon-only sm', style: { marginTop: '-4px' }, onclick: () => el.remove() }, icon('x', 'sm')));
  root.appendChild(el);
  while (root.children.length > 5) root.firstChild.remove();
  if (timeout) setTimeout(() => el.remove(), timeout);
}

/** Esegue un'azione asincrona mostrando l'eventuale errore come notifica. */
export async function run(fn, { button, success } = {}) {
  if (button) button.disabled = true;
  try {
    const r = await fn();
    if (success) toast('success', success);
    return r;
  } catch (err) {
    toast('error', 'Operazione non riuscita', err.message || String(err), 7000);
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}
