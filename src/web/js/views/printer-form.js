// Aggiunta e modifica di una stampante: scelta del tipo, ricerca in rete e dati di collegamento.

import { h, icon, clear, PRINTER_TYPES } from '../util.js';
import { api, store } from '../api.js';
import { openModal, run, toast } from '../ui.js';
import { portSelect, baudSelect } from '../actions.js';

export const COLORS = ['#ff6a1f', '#3ccf6e', '#4db5ff', '#ffb224', '#b894ff', '#ff4f7b', '#2cc9b4', '#e8e8e8', '#8b93a1'];

// Modelli USB comuni: volume di stampa e baudrate tipico
export const MODELS = [
  { name: 'Creality Ender-3 / Pro', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Creality Ender-3 V2', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Creality Ender-3 V3 SE', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Creality Ender-3 S1 / S1 Pro', x: 220, y: 220, z: 270, baud: 115200 },
  { name: 'Creality Ender-5 / Pro', x: 220, y: 220, z: 300, baud: 115200 },
  { name: 'Creality CR-10', x: 300, y: 300, z: 400, baud: 115200 },
  { name: 'Prusa i3 MK3S+', x: 250, y: 210, z: 210, baud: 115200 },
  { name: 'Anycubic i3 Mega', x: 210, y: 210, z: 205, baud: 250000 },
  { name: 'Anycubic Kobra 2', x: 220, y: 220, z: 250, baud: 115200 },
  { name: 'Artillery Sidewinder X1/X2', x: 300, y: 300, z: 400, baud: 115200 },
  { name: 'Elegoo Neptune 3 Pro', x: 225, y: 225, z: 280, baud: 115200 },
  { name: 'Sovol SV06', x: 220, y: 220, z: 250, baud: 115200 },
];

const BAMBU_MODELS = ['Bambu Lab X1 Carbon', 'Bambu Lab X1E', 'Bambu Lab P1S', 'Bambu Lab P1P', 'Bambu Lab A1', 'Bambu Lab A1 mini', 'Bambu Lab H2D'];

const DEFAULT_NAMES = { usb: 'Stampante', bambu: 'Bambu Lab', klipper: 'Klipper', prusalink: 'Prusa', octoprint: 'OctoPrint' };

/** Finestra "Aggiungi stampante": ricerca in rete oppure scelta del tipo. */
export function openAddPrinter(opts = {}) {
  let close = null;
  const body = h('div');
  const foot = h('div', { class: 'row', style: { width: '100%' } });

  const showChooser = () => {
    clear(foot).append(h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => close() }, 'Annulla'));
    clear(body).append(chooser({
      autoScan: !!opts.discover,
      onPick: (type, preset) => showForm(type, preset),
    }));
  };
  const showForm = (type, preset = {}) => {
    const form = printerForm({ type, preset, onDone: () => close() });
    clear(body).append(form.el);
    clear(foot).append(
      h('button', { class: 'btn ghost', onclick: showChooser }, icon('left', 'sm'), 'Indietro'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => close() }, 'Annulla'),
      h('button', { class: 'btn primary', onclick: (e) => form.save(e.currentTarget, true) }, icon('plug'), 'Aggiungi e connetti'));
  };

  close = openModal({ title: 'Aggiungi stampante', size: 'wide', body, footer: foot });
  if (opts.type) showForm(opts.type, opts.virtual ? { port: 'VIRTUAL', name: 'Stampante virtuale' } : {});
  else showChooser();
}

/** Modifica di una stampante esistente. */
export function openPrinterForm(existing) {
  if (!existing) return openAddPrinter();
  let close = null;
  const form = printerForm({ type: existing.type || 'usb', existing, onDone: () => close() });
  close = openModal({
    title: `Modifica "${existing.config.name}"`,
    size: 'wide',
    body: form.el,
    footer: (c) => [
      h('button', { class: 'btn', onclick: c }, 'Annulla'),
      h('button', { class: 'btn primary', onclick: (e) => form.save(e.currentTarget, false) }, icon('check'), 'Salva'),
    ],
  });
}

// --- scelta: ricerca in rete e tipi --------------------------------------------------

function chooser({ autoScan, onPick }) {
  const results = h('div', { class: 'found-list' });
  const scanBtn = h('button', { class: 'btn', onclick: () => scan() }, icon('broadcast'), 'Cerca in rete');
  const ipInput = h('input', { class: 'input', placeholder: 'Indirizzo IP, es. 192.168.1.40', 'aria-label': 'Indirizzo IP della stampante' });
  const probeBtn = h('button', { class: 'btn', onclick: () => probe() }, icon('search'), 'Controlla');
  ipInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') probe(); });

  const showList = (list, emptyText) => {
    clear(results);
    if (!list.length) {
      results.append(h('div', { class: 'scan-status' }, icon('info'), h('span', null, emptyText)));
      return;
    }
    list.forEach((r, i) => {
      const t = PRINTER_TYPES[r.type];
      const where = r.host + (r.port ? ':' + r.port : '');
      results.append(h('div', { class: 'found', style: { animationDelay: `${i * 40}ms` } },
        h('span', { class: 'f-icon' }, icon(t.icon)),
        h('div', { style: { minWidth: 0 } },
          h('b', null, r.name && r.name !== t.label ? `${r.name}` : (r.model || t.label)),
          h('span', null, [r.model && r.model !== r.name ? r.model : t.label, where].join(', '))),
        r.addedAs
          ? h('span', { class: 'chip' }, icon('check'), 'Già aggiunta')
          : h('button', { class: 'btn sm primary', onclick: () => onPick(r.type, { name: r.name && !/^(Bambu Lab|Klipper|Prusa|OctoPrint)$/.test(r.name) ? r.name : '', model: r.model || '', host: r.host, port: r.port || null, serial: r.serial || '' }) }, icon('plus', 'sm'), 'Aggiungi')));
    });
  };

  const scanning = (text) => {
    clear(results).append(h('div', { class: 'scan-status' }, h('span', { class: 'spinner' }), h('span', null, text)));
  };

  async function scan() {
    scanBtn.disabled = true;
    scanning('Cerco stampanti nella rete di casa: ci vogliono circa 8 secondi.');
    const list = await run(() => api('POST', '/discovery'));
    scanBtn.disabled = false;
    if (!list) { clear(results); return; }
    showList(list, 'Nessuna stampante trovata. Controlla che sia accesa e nella stessa rete del computer; per le Bambu Lab attiva la modalità LAN. Puoi anche scrivere il suo indirizzo IP qui sotto.');
  }

  async function probe() {
    const host = ipInput.value.trim();
    if (!host) return ipInput.focus();
    probeBtn.disabled = true;
    scanning(`Controllo ${host}…`);
    const list = await run(() => api('POST', '/discovery/probe', { host }));
    probeBtn.disabled = false;
    if (!list) { clear(results); return; }
    showList(list, `A ${host} non ho trovato Bambu Lab, Klipper, PrusaLink né OctoPrint. Se è una stampante USB, scegli "USB" qui sotto.`);
  }

  const typeCards = h('div', { class: 'type-grid' },
    ...Object.entries(PRINTER_TYPES).map(([type, t]) => h('button', { class: 'type-card', onclick: () => onPick(type, {}) },
      icon(t.icon), h('b', null, t.label), h('span', null, t.desc))));

  const el = h('div', { class: 'stack' },
    h('div', { class: 'stack tight' },
      h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'card-title' }, 'Stampanti in rete'), h('div', { class: 'card-sub' }, 'Bambu Lab, Klipper, PrusaLink e OctoPrint nella stessa rete del computer.')),
        scanBtn),
      results,
      h('div', { class: 'input-group' }, ipInput, probeBtn)),
    h('div', { class: 'stack tight' },
      h('div', { class: 'card-title' }, 'Oppure scegli il tipo'),
      typeCards));
  if (autoScan) setTimeout(scan, 50);
  else showList([], 'Premi "Cerca in rete" per trovare le stampanti Wi-Fi e di rete, oppure scegli il tipo qui sotto.');
  return el;
}

// --- modulo con i dati della stampante ---------------------------------------------

function printerForm({ type, preset = {}, existing = null, onDone }) {
  const isNew = !existing;
  const base = existing ? existing.config : {
    name: preset.name || `${DEFAULT_NAMES[type]} ${store.order.length + 1}`,
    model: preset.model || '',
    color: COLORS[store.order.length % COLORS.length],
    port: preset.port || '',
    baudrate: 'auto',
    autoConnect: true,
    volume: { x: 220, y: 220, z: 250 },
    extruders: 1,
    heatedBed: true,
    heatedChamber: false,
    originCenter: false,
    virtualSpeed: 4,
    net: { host: preset.host || '', port: preset.port && type !== 'usb' ? preset.port : null, serial: preset.serial || '', username: type === 'prusalink' ? 'maker' : '' },
    bambu: { useAms: false, bedLeveling: true, timelapse: false },
  };
  const cfg = JSON.parse(JSON.stringify(base));
  cfg.net = { host: '', port: null, serial: '', username: '', ...(cfg.net || {}) };
  if (type === 'prusalink' && !cfg.net.username) cfg.net.username = 'maker';
  cfg.bambu = { useAms: false, bedLeveling: true, timelapse: false, ...(cfg.bambu || {}) };
  const secrets = (existing && existing.config.net && existing.config.net.secrets) || {};
  const newSecrets = {};

  const text = (obj, key, attrs = {}) => h('input', { class: 'input', value: obj[key] ?? '', ...attrs, oninput: (e) => { obj[key] = e.target.value; } });
  const num = (obj, key, attrs = {}) => h('input', {
    class: 'input num', type: 'number', value: obj[key] ?? '', ...attrs,
    oninput: (e) => { obj[key] = e.target.value === '' ? null : Number(e.target.value); },
  });
  const secret = (key, placeholder) => {
    const input = h('input', {
      class: 'input', type: 'password', autocomplete: 'off', spellcheck: false, 'data-key': key,
      placeholder: secrets[key] ? 'Salvato: lascia vuoto per non cambiarlo' : placeholder,
      oninput: (e) => { newSecrets[key] = e.target.value.trim(); },
    });
    const eye = h('button', { class: 'btn icon-only', type: 'button', title: 'Mostra o nascondi', 'aria-label': 'Mostra o nascondi', onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.replaceChildren(icon(input.type === 'password' ? 'eye' : 'eyeOff'));
    } }, icon('eye'));
    return { input, el: h('div', { class: 'input-group' }, input, eye) };
  };
  let uid = 0;
  const field = (label, control, hint) => {
    const input = control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea');
    if (input && !input.id) input.id = `pf-${++uid}`;
    return h('div', { class: 'field' }, h('label', { for: input ? input.id : null }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
  };
  // errore sotto il campo, come chiedono le linee guida sui moduli
  const fieldError = (key, message) => {
    const input = el.querySelector(`[data-key="${key}"]`);
    if (!input) return toast('warn', message);
    const box = input.closest('.field');
    let err = box.querySelector('.field-error');
    if (!err) {
      err = h('div', { class: 'field-error', id: input.id + '-err', role: 'alert' });
      box.append(err);
    }
    err.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', err.id);
    input.focus();
    input.addEventListener('input', () => {
      err.remove();
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }, { once: true });
  };

  const colorPick = h('div', { class: 'color-pick', role: 'radiogroup', 'aria-label': 'Colore' });
  const renderColors = () => {
    clear(colorPick);
    for (const c of COLORS) {
      colorPick.appendChild(h('button', {
        type: 'button', class: c === cfg.color ? 'active' : '', style: { background: c }, title: c, 'aria-label': 'Colore ' + c, role: 'radio', 'aria-checked': c === cfg.color ? 'true' : 'false',
        onclick: () => { cfg.color = c; renderColors(); },
      }));
    }
  };
  renderColors();

  const t = PRINTER_TYPES[type];
  const typeLine = h('div', { class: 'row' }, h('span', { class: 'chip accent' }, icon(t.icon), t.label), h('span', { class: 'faint', style: { fontSize: '12.5px' } }, t.desc));

  const modelList = type === 'usb' ? MODELS.map((m) => m.name) : type === 'bambu' ? BAMBU_MODELS : [];
  const listId = 'sonoprint-models-' + type;
  const volX = num(cfg.volume, 'x', { min: 10 });
  const volY = num(cfg.volume, 'y', { min: 10 });
  const volZ = num(cfg.volume, 'z', { min: 10 });
  const modelInput = h('input', {
    class: 'input', list: listId, value: cfg.model || '', placeholder: type === 'usb' ? 'es. Creality Ender-3 V2' : type === 'bambu' ? 'es. Bambu Lab P1S' : 'facoltativo',
    oninput: (e) => {
      cfg.model = e.target.value;
      const m = MODELS.find((x) => x.name === e.target.value);
      if (m && type === 'usb') {
        cfg.volume = { x: m.x, y: m.y, z: m.z };
        volX.value = m.x; volY.value = m.y; volZ.value = m.z;
      }
    },
  });

  const common = h('div', { class: 'stack' },
    typeLine,
    h('div', { class: 'grid-2' },
      field('Nome', text(cfg, 'name', { maxlength: '60', 'data-key': 'name' })),
      field('Modello', h('div', null, modelInput, h('datalist', { id: listId }, modelList.map((m) => h('option', { value: m })))))),
    field('Colore', colorPick));

  let specific;
  if (type === 'usb') {
    let ports = [];
    const portWrap = h('div', { class: 'input-group' });
    const virtualRow = h('div', { class: 'field' });
    const baudWrap = h('div');
    const updateVirtual = () => { virtualRow.hidden = cfg.port !== 'VIRTUAL'; };
    const refreshPorts = async () => {
      ports = (await run(() => api('GET', '/ports'))) || [];
      if (isNew && !cfg.port) {
        const guess = ports.find((p) => p.likelyPrinter && !p.usedBy);
        cfg.port = guess ? guess.path : (ports[0] ? ports[0].path : '');
      }
      clear(portWrap).append(
        h('div', { class: 'grow' }, portSelect(ports, cfg.port, (v) => { cfg.port = v; updateVirtual(); })),
        h('button', { class: 'btn icon-only', type: 'button', title: 'Aggiorna elenco porte', 'aria-label': 'Aggiorna elenco porte', onclick: refreshPorts }, icon('refresh')));
      updateVirtual();
    };
    clear(baudWrap).appendChild(baudSelect(cfg.baudrate, (v) => { cfg.baudrate = v; }));
    virtualRow.append(h('label', null, 'Velocità della simulazione'),
      h('select', { class: 'select', onchange: (e) => { cfg.virtualSpeed = Number(e.target.value); } },
        [1, 2, 4, 10, 20, 50].map((s) => h('option', { value: String(s), selected: Number(cfg.virtualSpeed) === s }, s === 1 ? 'Tempo reale' : `${s} volte più veloce`))),
      h('div', { class: 'hint' }, 'La stampante virtuale simula un firmware Marlin: serve a provare l\'app senza stampante.'));
    refreshPorts();
    specific = h('div', { class: 'stack' },
      h('div', { class: 'grid-2' },
        field('Porta USB', portWrap, 'Le porte che sembrano stampanti sono in cima. Non sai quale? Scollega il cavo, aggiorna e guarda quale sparisce.'),
        field('Baudrate', baudWrap)),
      virtualRow,
      field('Volume di stampa (mm)', h('div', { class: 'grid-3' },
        h('div', { class: 'row' }, h('span', { class: 'faint' }, 'X'), volX),
        h('div', { class: 'row' }, h('span', { class: 'faint' }, 'Y'), volY),
        h('div', { class: 'row' }, h('span', { class: 'faint' }, 'Z'), volZ))),
      h('div', { class: 'grid-2' },
        field('Numero di estrusori', num(cfg, 'extruders', { min: 1, max: 8 })),
        field('Opzioni', h('div', { class: 'stack tight' },
          check('Piatto riscaldato', cfg.heatedBed, (v) => { cfg.heatedBed = v; }),
          check('Camera riscaldata', cfg.heatedChamber, (v) => { cfg.heatedChamber = v; }),
          check('Origine al centro del piatto (delta)', cfg.originCenter, (v) => { cfg.originCenter = v; })))));
  } else if (type === 'bambu') {
    const code = secret('accessCode', '8 cifre, es. 12345678');
    specific = h('div', { class: 'stack' },
      h('div', { class: 'alert info' }, icon('info', 'sm'), h('div', null,
        h('b', null, 'Sulla stampante: '), 'Impostazioni > WLAN (o Rete). Attiva ', h('b', null, 'Modalità solo LAN'), ' e ', h('b', null, 'Modalità sviluppatore'),
        ': senza quest\'ultima la stampante accetta solo la lettura dello stato. Nella stessa pagina trovi indirizzo IP e codice di accesso.')),
      h('div', { class: 'grid-2' },
        field('Indirizzo IP', text(cfg.net, 'host', { 'data-key': 'host', placeholder: 'es. 192.168.1.40' })),
        field('Codice di accesso LAN', code.el, 'Cambia quando si riattiva la modalità LAN.')),
      field('Numero di serie', text(cfg.net, 'serial', { placeholder: 'Facoltativo: SonoPrint lo legge dalla stampante' })),
      field('Quando avvii una stampa', h('div', { class: 'stack tight' },
        check('Usa l\'AMS (i filamenti usano gli slot in ordine: 1, 2, 3, 4)', cfg.bambu.useAms, (v) => { cfg.bambu.useAms = v; }),
        check('Livellamento del piatto', cfg.bambu.bedLeveling, (v) => { cfg.bambu.bedLeveling = v; }),
        check('Timelapse', cfg.bambu.timelapse, (v) => { cfg.bambu.timelapse = v; }))));
  } else if (type === 'klipper') {
    const key = secret('apiKey', 'Solo se Moonraker la richiede');
    specific = h('div', { class: 'stack' },
      h('div', { class: 'grid-2' },
        field('Indirizzo IP o nome', text(cfg.net, 'host', { 'data-key': 'host', placeholder: 'es. 192.168.1.50 oppure voron.local' })),
        field('Porta di Moonraker', num(cfg.net, 'port', { placeholder: '7125', min: 1, max: 65535 }), 'Di solito 7125. Se non risponde prova 80.')),
      field('Chiave API', key.el, 'Serve solo se in Moonraker è attiva l\'autenticazione: la trovi in Mainsail o Fluidd.'));
  } else if (type === 'prusalink') {
    const pass = secret('password', 'Password di PrusaLink');
    specific = h('div', { class: 'stack' },
      h('div', { class: 'alert info' }, icon('info', 'sm'), h('div', null,
        'Sullo schermo della stampante apri ', h('b', null, 'Impostazioni > Rete > PrusaLink'), ': lì trovi indirizzo, nome utente e password.')),
      field('Indirizzo IP', text(cfg.net, 'host', { 'data-key': 'host', placeholder: 'es. 192.168.1.60' })),
      h('div', { class: 'grid-2' },
        field('Nome utente', text(cfg.net, 'username', { placeholder: 'maker' })),
        field('Password', pass.el)),
      h('div', { class: 'hint' }, 'Con PrusaLink puoi inviare file, seguire la stampa, metterla in pausa o annullarla. Movimenti e temperature si comandano dalla stampante.'));
  } else {
    const key = secret('apiKey', 'Chiave API di OctoPrint');
    const askBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
      if (!cfg.net.host) return toast('warn', 'Scrivi prima l\'indirizzo di OctoPrint');
      askBtn.disabled = true;
      const old = askBtn.textContent;
      askBtn.replaceChildren(h('span', { class: 'spinner' }), 'Conferma in OctoPrint…');
      toast('info', 'Apri OctoPrint', 'Nella pagina di OctoPrint conferma l\'accesso per SonoPrint.', 10000);
      const port = /:(\d+)$/.exec(cfg.net.host);
      const r = await run(() => api('POST', '/octoprint/appkey', { host: cfg.net.host.replace(/:\d+$/, ''), port: port ? port[1] : cfg.net.port }));
      askBtn.disabled = false;
      askBtn.replaceChildren(icon('key'), old);
      if (r && r.apiKey) {
        newSecrets.apiKey = r.apiKey;
        key.input.value = r.apiKey;
        toast('success', 'Accesso concesso', 'OctoPrint ha creato una chiave per SonoPrint.');
      }
    } }, icon('key'), 'Chiedi l\'accesso');
    specific = h('div', { class: 'stack' },
      field('Indirizzo di OctoPrint', text(cfg.net, 'host', { 'data-key': 'host', placeholder: 'es. 192.168.1.70 oppure octopi.local:5000' })),
      field('Chiave API', h('div', { class: 'input-group' }, h('div', { class: 'grow' }, key.el), askBtn),
        'Premi "Chiedi l\'accesso" e conferma nella pagina di OctoPrint, oppure crea una chiave in Impostazioni > Application Keys.'));
  }

  const el = h('div', { class: 'stack' }, common, specific,
    check('Connetti all\'avvio di SonoPrint', cfg.autoConnect, (v) => { cfg.autoConnect = v; }));

  async function save(button, connect) {
    if (!String(cfg.name).trim()) return fieldError('name', 'Scrivi un nome per la stampante.');
    if (type !== 'usb' && !String(cfg.net.host || '').trim()) return fieldError('host', 'Scrivi l\'indirizzo della stampante.');
    if (type === 'bambu' && !secrets.accessCode && !newSecrets.accessCode) return fieldError('accessCode', 'Scrivi il codice di accesso LAN della stampante.');
    const payload = { type, name: cfg.name, model: cfg.model, color: cfg.color, autoConnect: cfg.autoConnect };
    if (type === 'usb') {
      Object.assign(payload, {
        port: cfg.port, baudrate: cfg.baudrate, volume: cfg.volume, extruders: cfg.extruders, heatedBed: cfg.heatedBed,
        heatedChamber: cfg.heatedChamber, originCenter: cfg.originCenter, virtualSpeed: cfg.virtualSpeed,
      });
    } else {
      payload.net = { host: cfg.net.host, port: cfg.net.port || null, serial: cfg.net.serial || '', username: cfg.net.username || '', ...newSecrets };
      if (type === 'bambu') payload.bambu = cfg.bambu;
      payload.heatedBed = true;
    }
    const res = await run(() => (isNew ? api('POST', '/printers', payload) : api('PUT', `/printers/${existing.id}`, payload)), { button });
    if (!res) return;
    onDone();
    if (isNew) {
      location.hash = `#/printer/${res.id}`;
      if (connect) run(() => api('POST', `/printers/${res.id}/connect`, {}));
    } else {
      toast('success', 'Impostazioni salvate', cfg.name);
    }
  }

  return { el, save };
}

export function check(label, value, onChange) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) }),
    h('span', null, label));
}

export function toggle(label, value, onChange) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: !!value, onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', null, label));
}
