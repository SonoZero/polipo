// Azioni sulle stampanti condivise tra le varie pagine.

import { h, icon, clear, fmtDuration, fmtSize, fmtFilament, fmtRelative, STATE_LABELS } from './util.js';
import { api, store, fileUrl, printerList, uploadFile, on } from './api.js';
import { openModal, confirmDialog, openMenu, run, toast } from './ui.js';

export async function connectPrinter(p, button) {
  if ((p.type || 'usb') === 'usb' && !p.config.port) return choosePortAndConnect(p);
  return run(() => api('POST', `/printers/${p.id}/connect`, {}), { button });
}

export function disconnectPrinter(p, button) {
  if (p.job) {
    return confirmDialog({
      title: 'Disconnettere durante la stampa?',
      message: `"${p.config.name}" sta stampando. Disconnettendola la stampa si interromperà.`,
      confirmLabel: 'Disconnetti', danger: true,
    }).then((ok) => ok && run(() => api('POST', `/printers/${p.id}/disconnect`), { button }));
  }
  return run(() => api('POST', `/printers/${p.id}/disconnect`), { button });
}

export async function choosePortAndConnect(p) {
  const ports = await run(() => api('GET', '/ports'));
  if (!ports) return;
  let selected = p.config.port || (ports.find((x) => x.likelyPrinter && !x.usedBy) || ports[0] || {}).path;
  let baud = p.config.baudrate || 'auto';
  openModal({
    title: `Connetti "${p.config.name}"`,
    size: 'narrow',
    body: () => h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', null, 'Porta'), portSelect(ports, selected, (v) => { selected = v; })),
      h('div', { class: 'field' }, h('label', null, 'Baudrate'), baudSelect(baud, (v) => { baud = v; }),
        h('div', { class: 'hint' }, '"Automatico" prova i valori più comuni (115200, 250000…).'))),
    footer: (close) => [
      h('button', { class: 'btn', onclick: close }, 'Annulla'),
      h('button', {
        class: 'btn primary',
        onclick: async (e) => {
          if (!selected) return toast('warn', 'Seleziona una porta');
          close();
          await run(() => api('POST', `/printers/${p.id}/connect`, { port: selected, baudrate: baud }), { button: e.currentTarget });
        },
      }, icon('plug'), 'Connetti'),
    ],
  });
}

export function portSelect(ports, value, onChange) {
  const sel = h('select', { class: 'select', onchange: (e) => onChange(e.target.value) });
  if (!ports.some((p) => p.path === value) && value) {
    sel.appendChild(h('option', { value }, `${value} (non trovata)`));
  }
  for (const port of ports) {
    let label = port.virtual ? port.label : `${port.path}, ${port.label.replace(`(${port.path})`, '').trim() || 'porta seriale'}`;
    if (port.likelyPrinter) label += ' (stampante)';
    if (port.usedBy) label += ` (in uso da ${port.usedBy})`;
    sel.appendChild(h('option', { value: port.path }, label));
  }
  sel.value = value || '';
  if (!value && ports.length) { sel.value = ports[0].path; onChange(ports[0].path); }
  return sel;
}

export function baudSelect(value, onChange) {
  const sel = h('select', { class: 'select', onchange: (e) => onChange(e.target.value === 'auto' ? 'auto' : Number(e.target.value)) },
    h('option', { value: 'auto' }, 'Automatico'),
    ...[250000, 230400, 115200, 57600, 38400, 19200, 9600].map((b) => h('option', { value: String(b) }, String(b))));
  sel.value = String(value || 'auto');
  return sel;
}

export function jobAction(p, action, button) {
  if (action === 'cancel') {
    return confirmDialog({
      title: 'Annullare la stampa?',
      message: `La stampa di "${p.job ? p.job.file : ''}" su "${p.config.name}" verrà interrotta e non potrà essere ripresa.`,
      confirmLabel: 'Annulla stampa', danger: true,
    }).then((ok) => ok && run(() => api('POST', `/printers/${p.id}/job`, { action }), { button }));
  }
  return run(() => api('POST', `/printers/${p.id}/job`, { action }), { button });
}

export function emergencyStop(p) {
  return confirmDialog({
    title: 'Arresto di emergenza',
    message: `Invia M112 a "${p.config.name}": motori e riscaldatori si fermano subito. Dopo dovrai riconnettere (o riavviare) la stampante.`,
    confirmLabel: 'Ferma tutto', danger: true,
  }).then((ok) => ok && run(() => api('POST', `/printers/${p.id}/emergency`)));
}

export function startPrint(printerId, fileName) {
  return run(() => api('POST', `/printers/${printerId}/job`, { action: 'start', file: fileName }));
}

/** Menu "Stampa su…" per un file. */
export function printOnMenu(anchor, fileName) {
  const printers = printerList();
  if (!printers.length) return toast('info', 'Nessuna stampante', 'Aggiungi prima una stampante.');
  openMenu(anchor, [
    { section: 'Stampa su' },
    ...printers.map((p) => {
      const kind = /\.3mf$/i.test(fileName) ? '.3mf' : '.gcode';
      const fits = ((p.capabilities && p.capabilities.files) || ['.gcode']).includes(kind);
      return {
        label: p.config.name,
        dot: p.config.color,
        hint: !fits ? 'solo G-code' : p.state === 'operational' ? 'pronta' : (STATE_LABELS[p.state] || p.state).toLowerCase(),
        disabled: !fits || p.state !== 'operational',
        onClick: () => startPrint(p.id, fileName).then((r) => { if (r) location.hash = `#/printer/${p.id}`; }),
      };
    }),
  ]);
}

/** Finestra di scelta del file da stampare su una stampante. */
export function chooseFileToPrint(p) {
  let query = '';
  const list = h('div', { class: 'file-list card', style: { maxHeight: '52vh', overflow: 'auto' } });
  const render = () => {
    clear(list);
    const accepted = (p.capabilities && p.capabilities.files) || ['.gcode'];
    const files = store.files.filter((f) => accepted.includes(f.kind === '3mf' ? '.3mf' : '.gcode') && f.name.toLowerCase().includes(query.toLowerCase()));
    if (!files.length) {
      list.appendChild(h('div', { class: 'empty' }, icon('files'),
        h('p', null, store.files.length ? 'Nessun file adatto a questa stampante corrisponde alla ricerca.' : 'Non hai ancora caricato file da stampare.')));
      return;
    }
    for (const f of files) {
      const m = f.meta || {};
      list.appendChild(h('div', { class: 'file-row', style: { gridTemplateColumns: '56px minmax(0,1fr) auto' } },
        fileThumb(f),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'file-name', title: f.name }, f.name),
          h('div', { class: 'file-sub' },
            h('span', null, f.analyzing ? 'Analisi…' : fmtDuration(m.estimatedTime, { short: true })),
            h('span', null, fmtFilament(m.filamentLength, m.filamentWeight)),
            h('span', null, fmtSize(f.size)),
            h('span', null, fmtRelative(f.addedAt)))),
        h('button', {
          class: 'btn primary sm',
          onclick: async (e) => {
            const r = await run(() => api('POST', `/printers/${p.id}/job`, { action: 'start', file: f.name }), { button: e.currentTarget });
            if (r) close();
          },
        }, icon('play', 'sm'), 'Stampa')));
    }
  };
  const fileInput = h('input', { type: 'file', accept: (p.capabilities && p.capabilities.files || ['.gcode']).includes('.3mf') ? '.gcode,.gco,.g,.3mf' : '.gcode,.gco,.g', hidden: true, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = await run(() => uploadFile(file));
    if (r) toast('success', 'File caricato', r.name);
  } });
  const close = openModal({
    title: `Stampa su "${p.config.name}"`,
    size: 'wide',
    body: () => h('div', { class: 'stack' },
      h('div', { class: 'row' },
        h('div', { class: 'row grow', style: { position: 'relative' } },
          h('input', { class: 'input grow', placeholder: 'Cerca un file…', oninput: (e) => { query = e.target.value; render(); } })),
        fileInput,
        h('button', { class: 'btn', onclick: () => fileInput.click() }, icon('upload'), 'Carica file')),
      list),
    onClose: () => offFiles(),
  });
  const offFiles = on('files', render);
  render();
}

export function fileThumb(f, cls = 'file-thumb') {
  return h('div', { class: cls },
    f && f.hasThumb ? h('img', { src: fileUrl(f.name, 'thumb'), alt: '', loading: 'lazy' }) : icon('cube'));
}
