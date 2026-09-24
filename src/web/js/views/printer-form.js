// Finestra per aggiungere o modificare una stampante.

import { h, icon, clear } from '../util.js';
import { api, store } from '../api.js';
import { openModal, run, toast } from '../ui.js';
import { portSelect, baudSelect } from '../actions.js';

export const COLORS = ['#f97316', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#ec4899', '#14b8a6', '#ef4444', '#94a3b8'];

// Modelli comuni: volume di stampa e baudrate tipico
export const MODELS = [
  { name: 'Creality Ender-3 / Pro', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Creality Ender-3 V2', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Creality Ender-3 V3 SE', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Creality Ender-3 S1 / S1 Pro', x: 220, y: 220, z: 270, baud: 115200 },
  { name: 'Creality Ender-5 / Pro', x: 220, y: 220, z: 300, baud: 115200 },
  { name: 'Creality CR-10', x: 300, y: 300, z: 400, baud: 115200 },
  { name: 'Prusa i3 MK3S+', x: 250, y: 210, z: 210, baud: 115200 },
  { name: 'Prusa MK4', x: 250, y: 210, z: 220, baud: 115200 },
  { name: 'Prusa MINI+', x: 180, y: 180, z: 180, baud: 115200 },
  { name: 'Anycubic i3 Mega', x: 210, y: 210, z: 205, baud: 250000 },
  { name: 'Anycubic Kobra 2', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Artillery Sidewinder X1/X2', x: 300, y: 300, z: 400, baud: 115200 },
  { name: 'Elegoo Neptune 3 Pro', x: 225, y: 225, z: 280, baud: 115200 },
  { name: 'Sovol SV06', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Flashforge Adventurer', x: 150, y: 150, z: 150, baud: 115200 },
];

export async function openPrinterForm(existing) {
  const isNew = !existing;
  const base = existing ? existing.config : {
    name: `Stampante ${store.order.length + 1}`,
    model: '',
    color: COLORS[store.order.length % COLORS.length],
    port: '',
    baudrate: 'auto',
    autoConnect: true,
    volume: { x: 220, y: 220, z: 250 },
    extruders: 1,
    heatedBed: true,
    heatedChamber: false,
    originCenter: false,
    virtualSpeed: 4,
  };
  const cfg = JSON.parse(JSON.stringify(base));
  let ports = [];

  const portWrap = h('div', { class: 'row' });
  const virtualRow = h('div', { class: 'field' });
  const refreshPorts = async () => {
    ports = (await run(() => api('GET', '/ports'))) || [];
    if (isNew && !cfg.port) {
      const guess = ports.find((p) => p.likelyPrinter && !p.usedBy);
      cfg.port = guess ? guess.path : (ports[0] ? ports[0].path : '');
    }
    clear(portWrap).append(
      h('div', { class: 'grow' }, portSelect(ports, cfg.port, (v) => { cfg.port = v; updateVirtual(); })),
      h('button', { class: 'btn icon-only', title: 'Aggiorna elenco porte', onclick: refreshPorts }, icon('refresh')));
    updateVirtual();
  };
  const updateVirtual = () => { virtualRow.hidden = cfg.port !== 'VIRTUAL'; };

  const num = (obj, key, attrs = {}) => h('input', {
    class: 'input', type: 'number', value: String(obj[key]), ...attrs,
    oninput: (e) => { obj[key] = e.target.value === '' ? '' : Number(e.target.value); },
  });
  const colorPick = h('div', { class: 'color-pick' });
  const renderColors = () => {
    clear(colorPick);
    for (const c of COLORS) {
      colorPick.appendChild(h('button', {
        type: 'button', class: c === cfg.color ? 'active' : '', style: { background: c }, title: c,
        onclick: () => { cfg.color = c; renderColors(); },
      }));
    }
  };
  renderColors();

  const volX = num(cfg.volume, 'x', { min: 10 });
  const volY = num(cfg.volume, 'y', { min: 10 });
  const volZ = num(cfg.volume, 'z', { min: 10 });
  const baudWrap = h('div');
  const renderBaud = () => clear(baudWrap).appendChild(baudSelect(cfg.baudrate, (v) => { cfg.baudrate = v; }));
  renderBaud();

  const modelInput = h('input', {
    class: 'input', list: 'polipo-models', value: cfg.model || '', placeholder: 'es. Creality Ender-3 V2',
    oninput: (e) => {
      cfg.model = e.target.value;
      const m = MODELS.find((x) => x.name === e.target.value);
      if (m) {
        cfg.volume = { x: m.x, y: m.y, z: m.z };
        volX.value = m.x; volY.value = m.y; volZ.value = m.z;
      }
    },
  });

  const body = h('div', { class: 'stack' },
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', null, 'Nome'),
        h('input', { class: 'input', value: cfg.name, maxlength: '60', oninput: (e) => { cfg.name = e.target.value; } })),
      h('div', { class: 'field' }, h('label', null, 'Modello'), modelInput,
        h('datalist', { id: 'polipo-models' }, MODELS.map((m) => h('option', { value: m.name }))))),
    h('div', { class: 'field' }, h('label', null, 'Colore'), colorPick),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', null, 'Porta USB'), portWrap,
        h('div', { class: 'hint' }, '★ = probabilmente una stampante. Non sai quale? Scollega il cavo, aggiorna e guarda quale sparisce.')),
      h('div', { class: 'field' }, h('label', null, 'Baudrate'), baudWrap)),
    virtualRow,
    h('div', { class: 'field' }, h('label', null, 'Volume di stampa (mm)'),
      h('div', { class: 'grid-3' },
        h('div', { class: 'row' }, h('span', { class: 'faint' }, 'X'), volX),
        h('div', { class: 'row' }, h('span', { class: 'faint' }, 'Y'), volY),
        h('div', { class: 'row' }, h('span', { class: 'faint' }, 'Z'), volZ))),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', null, 'Numero di estrusori'), num(cfg, 'extruders', { min: 1, max: 8 })),
      h('div', { class: 'field' }, h('label', null, 'Opzioni'),
        h('div', { class: 'stack', style: { gap: '8px' } },
          check('Piatto riscaldato', cfg.heatedBed, (v) => { cfg.heatedBed = v; }),
          check('Camera riscaldata', cfg.heatedChamber, (v) => { cfg.heatedChamber = v; }),
          check('Origine al centro del piatto (delta)', cfg.originCenter, (v) => { cfg.originCenter = v; }),
          check('Connetti all\'avvio dell\'app', cfg.autoConnect, (v) => { cfg.autoConnect = v; })))),
  );

  virtualRow.append(h('label', null, 'Velocità della simulazione'),
    h('select', { class: 'select', onchange: (e) => { cfg.virtualSpeed = Number(e.target.value); } },
      [1, 2, 4, 10, 20, 50].map((s) => h('option', { value: String(s), selected: Number(cfg.virtualSpeed) === s }, s === 1 ? 'Tempo reale' : `${s}× più veloce`))),
    h('div', { class: 'hint' }, 'La stampante virtuale simula un firmware Marlin: utile per provare l\'app senza stampante.'));

  refreshPorts();

  const save = async (button, connect) => {
    if (!String(cfg.name).trim()) return toast('warn', 'Inserisci un nome per la stampante');
    const payload = {
      name: cfg.name, model: cfg.model, color: cfg.color, port: cfg.port, baudrate: cfg.baudrate,
      autoConnect: cfg.autoConnect, volume: cfg.volume, extruders: cfg.extruders, heatedBed: cfg.heatedBed,
      heatedChamber: cfg.heatedChamber, originCenter: cfg.originCenter, virtualSpeed: cfg.virtualSpeed,
    };
    const res = await run(() => (isNew ? api('POST', '/printers', payload) : api('PUT', `/printers/${existing.id}`, payload)), { button });
    if (!res) return;
    close();
    if (isNew) {
      location.hash = `#/printer/${res.id}`;
      if (connect && cfg.port) run(() => api('POST', `/printers/${res.id}/connect`, {}));
    } else {
      toast('success', 'Impostazioni salvate');
    }
  };

  const close = openModal({
    title: isNew ? 'Aggiungi stampante' : `Modifica "${existing.config.name}"`,
    body,
    footer: (c) => [
      h('button', { class: 'btn', onclick: c }, 'Annulla'),
      isNew ? h('button', { class: 'btn', onclick: (e) => save(e.currentTarget, false) }, 'Salva') : null,
      h('button', { class: 'btn primary', onclick: (e) => save(e.currentTarget, isNew) }, isNew ? icon('plug') : icon('check'), isNew ? 'Salva e connetti' : 'Salva'),
    ],
  });
}

export function check(label, value, onChange) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) }),
    h('span', null, label));
}
