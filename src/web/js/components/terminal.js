// Terminale: comunicazione con la stampante e invio di comandi G-code manuali.

import { h, icon, clear } from '../util.js';
import { api, store, on, subscribeLog } from '../api.js';
import { run } from '../ui.js';
import { check } from '../views/printer-form.js';

const MAX_LINES = 1200;
const historyByPrinter = new Map();

export function createTerminal(printerId) {
  const out = h('div', { class: 'term-out' });
  const input = h('input', { class: 'input grow mono', placeholder: 'Scrivi un comando G-code (es. G28, M104 S200) e premi Invio', spellcheck: false, autocomplete: 'off' });
  const sendBtn = h('button', { class: 'btn primary' }, icon('send'), 'Invia');
  const opts = { quiet: false, autoscroll: true, time: false };
  const history = historyByPrinter.get(printerId) || [];
  historyByPrinter.set(printerId, history);
  let histIdx = -1;

  const quick = [
    ['M114', 'Posizione'],
    ['M105', 'Temperature'],
    ['M115', 'Info firmware'],
    ['M503', 'Impostazioni EEPROM'],
    ['M501', 'Ricarica EEPROM'],
    ['M500', 'Salva EEPROM'],
  ];

  const el = h('div', { class: 'term' },
    h('div', { class: 'term-quick' },
      ...quick.map(([cmd, label]) => h('button', { class: 'btn sm', title: cmd, onclick: () => send(cmd) }, label)),
      h('span', { class: 'grow' }),
      check('Righe di stampa e temperature', opts.quiet, (v) => { opts.quiet = v; rerender(); }),
      check('Orario', opts.time, (v) => { opts.time = v; rerender(); }),
      check('Scorri automaticamente', opts.autoscroll, (v) => { opts.autoscroll = v; if (v) out.scrollTop = out.scrollHeight; })),
    out,
    h('div', { class: 'term-bar' }, input, sendBtn,
      h('button', { class: 'btn', title: 'Pulisci', onclick: () => { store.logs[printerId] = []; rerender(); } }, icon('trash'))));

  function lineEl(e) {
    return h('div', { class: 'l-' + e.type },
      opts.time ? h('span', { class: 'ts' }, new Date(e.t).toLocaleTimeString('it-IT')) : null,
      e.text);
  }

  function visible(e) { return opts.quiet || !e.q; }

  function rerender() {
    clear(out);
    const lines = (store.logs[printerId] || []).filter(visible).slice(-MAX_LINES);
    const frag = document.createDocumentFragment();
    for (const e of lines) frag.appendChild(lineEl(e));
    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  }

  function appendLines(lines) {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const e of lines) if (visible(e)) frag.appendChild(lineEl(e));
    out.appendChild(frag);
    while (out.childNodes.length > MAX_LINES) out.removeChild(out.firstChild);
    if (opts.autoscroll && atBottom) out.scrollTop = out.scrollHeight;
  }

  async function send(cmd) {
    const text = (cmd ?? input.value).trim();
    if (!text) return;
    if (cmd === undefined) {
      if (history[history.length - 1] !== text) history.push(text);
      if (history.length > 100) history.shift();
      histIdx = -1;
      input.value = '';
    }
    await run(() => api('POST', `/printers/${printerId}/command`, { commands: text.split(/\r?\n/) }));
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      input.value = history[histIdx];
    } else if (e.key === 'ArrowDown' && histIdx >= 0) {
      e.preventDefault();
      histIdx++;
      if (histIdx >= history.length) { histIdx = -1; input.value = ''; } else input.value = history[histIdx];
    }
  });
  sendBtn.addEventListener('click', () => send());

  const unsub = subscribeLog(printerId);
  const offs = [
    on('log-init', (id) => { if (id === printerId) rerender(); }),
    on('log', (id, lines) => { if (id === printerId) appendLines(lines); }),
  ];
  rerender();

  return {
    el,
    setEnabled(enabled) { input.disabled = !enabled; sendBtn.disabled = !enabled; el.querySelectorAll('.term-quick .btn').forEach((b) => { b.disabled = !enabled; }); },
    destroy() { unsub(); offs.forEach((f) => f()); },
  };
}
