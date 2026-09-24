// Pagina di una stampante: connessione, stato della stampa, temperature, controllo,
// terminale, anteprima G-code, telecamera, firmware e impostazioni.

import {
  h, icon, clear, setText, fmtDuration, fmtClock, fmtPct, fmtTemp, fmtFilament,
  stateBadge, heaterLabel, heaterColor, PRINTER_TYPES, connectionLabel,
} from '../util.js';
import { api, store, on, fileByName, uploadFile } from '../api.js';
import { run, toast, confirmDialog } from '../ui.js';
import {
  disconnectPrinter, jobAction, emergencyStop, chooseFileToPrint,
  portSelect, baudSelect, fileThumb,
} from '../actions.js';
import { createTempChart } from '../components/temp-chart.js';
import { createTerminal } from '../components/terminal.js';
import { createWebcam, listCameras } from '../components/webcam.js';
import { createGcodeViewer } from '../components/gcode-viewer.js';
import { createFirmware } from '../components/firmware.js';
import { openPrinterForm, check, toggle } from './printer-form.js';

const ALL_TABS = [
  { id: 'control', label: 'Controllo', icon: 'target' },
  { id: 'terminal', label: 'Terminale', icon: 'terminal' },
  { id: 'preview', label: 'Anteprima', icon: 'layers' },
  { id: 'webcam', label: 'Telecamera', icon: 'camera' },
  { id: 'firmware', label: 'Firmware', icon: 'chip' },
  { id: 'settings', label: 'Impostazioni', icon: 'settings' },
];

function tabsFor(p) {
  const c = p.capabilities || {};
  const hasControl = c.jog || c.extrude || c.fan || c.feedRate || c.speedLevel || c.light;
  return ALL_TABS.filter((t) => {
    if (t.id === 'control') return hasControl;
    if (t.id === 'terminal') return !!c.terminal;
    if (t.id === 'firmware') return !!c.firmware;
    if (t.id === 'webcam') return !!c.webcam || p.type === 'bambu';
    return true;
  });
}

const connected = (p) => !['offline', 'connecting', 'error'].includes(p.state);

export function mountPrinter(container, id, initialTab) {
  const offs = [];
  const P = () => store.printers.get(id);
  let tabs = tabsFor(P());
  let tab = tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0].id;
  let tabComp = null;

  // ---------------------------------------------------------------------------
  // intestazione

  const head = {};
  const headEl = h('div', { class: 'phead' },
    head.color = h('div', { class: 'color' }),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'row' }, head.name = h('h1'), head.badge = h('span'),
        h('button', { class: 'btn ghost icon-only sm', title: 'Modifica stampante', 'aria-label': 'Modifica stampante', onclick: () => openPrinterForm(P()) }, icon('edit', 'sm'))),
      head.sub = h('div', { class: 'sub' })),
    head.conn = h('div', { class: 'conn-bar' }));
  const errorBox = h('div', { class: 'alert error', style: { marginBottom: '18px' }, hidden: true });

  let connKey = '';
  let connPorts = null;
  const connSel = { port: null, baud: null };
  async function loadPorts() {
    connPorts = (await run(() => api('GET', '/ports'))) || [];
    connKey = '';
    updateHeader(P());
  }

  function updateHeader(p) {
    const type = PRINTER_TYPES[p.type || 'usb'] || PRINTER_TYPES.usb;
    head.color.style.background = p.config.color;
    setText(head.name, p.config.name);
    clear(head.badge).appendChild(stateBadge(p.state));
    const bits = [];
    const model = p.config.model || (p.extra && p.extra.model);
    if (model) bits.push(model);
    bits.push(connectionLabel(p));
    if (p.baudrate && p.port !== 'VIRTUAL') bits.push(p.baudrate + ' baud');
    if (p.firmware && p.firmware.name && p.type === 'usb') bits.push(p.firmware.name.split(' (')[0]);
    if (p.firmware && p.firmware.version && p.type !== 'usb') bits.push('firmware ' + p.firmware.version);
    if (p.extra && p.extra.wifi) bits.push('Wi-Fi ' + p.extra.wifi);
    head.sub.replaceChildren(h('span', { class: 'chip' }, icon(type.icon), type.label), h('span', null, bits.join(', ')));

    errorBox.hidden = !p.error;
    if (p.error) errorBox.replaceChildren(icon('alert'), h('div', null, p.error));

    const key = p.state + '|' + (connPorts ? connPorts.length : 'x') + '|' + (p.type || 'usb');
    if (key === connKey) return;
    connKey = key;
    clear(head.conn);
    const usb = (p.type || 'usb') === 'usb';
    if (p.state === 'offline' || p.state === 'error') {
      if (usb) {
        if (!connPorts) { loadPorts(); return; }
        if (connSel.port === null) connSel.port = p.config.port;
        if (connSel.baud === null) connSel.baud = p.config.baudrate;
        head.conn.append(
          h('div', { style: { width: '250px' } }, portSelect(connPorts, connSel.port, (v) => { connSel.port = v; })),
          h('button', { class: 'btn icon-only', title: 'Aggiorna porte', 'aria-label': 'Aggiorna porte', onclick: loadPorts }, icon('refresh')),
          h('div', { style: { width: '130px' } }, baudSelect(connSel.baud, (v) => { connSel.baud = v; })));
      }
      head.conn.append(h('button', {
        class: 'btn primary',
        onclick: (e) => run(() => api('POST', `/printers/${id}/connect`, usb ? { port: connSel.port, baudrate: connSel.baud } : {}), { button: e.currentTarget }),
      }, icon('plug'), p.state === 'error' ? 'Riconnetti' : 'Connetti'));
    } else if (p.state === 'connecting') {
      head.conn.append(h('button', { class: 'btn', onclick: (e) => disconnectPrinter(P(), e.currentTarget) }, icon('x'), 'Annulla'));
    } else {
      if (p.capabilities && p.capabilities.emergency) {
        head.conn.append(h('button', { class: 'btn outline-danger', title: 'Arresto di emergenza (M112)', onclick: () => emergencyStop(P()) }, icon('zap'), 'Emergenza'));
      }
      head.conn.append(h('button', { class: 'btn', onclick: (e) => disconnectPrinter(P(), e.currentTarget) }, icon('unplug'), 'Disconnetti'));
    }
  }

  // ---------------------------------------------------------------------------
  // stato della stampa

  const jobCard = h('section', { class: 'card job-card', 'aria-label': 'Stampa' });
  let jobKey = '';
  const jr = {};

  function updateJob(p) {
    const file = p.job ? fileByName(p.job.file) : null;
    const key = [p.state, p.job ? p.job.file : '', file && file.hasThumb, p.job && p.job.thumbnail, p.lastJob && p.lastJob.finishedAt, p.task && p.task.kind].join('|');
    if (key !== jobKey) {
      jobKey = key;
      renderJob(p, file);
    }
    if (jr.sendFill && p.task) {
      jr.sendFill.style.width = ((p.task.progress || 0) * 100).toFixed(1) + '%';
      setText(jr.sendPct, fmtPct(p.task.progress || 0));
    }
    if (p.job && jr.pct) {
      setText(jr.pct, fmtPct(p.job.progress));
      jr.fill.style.width = (p.job.progress * 100).toFixed(2) + '%';
      setText(jr.layer, p.job.layer ? `Layer ${p.job.layer}${p.job.layerCount ? ' di ' + p.job.layerCount : ''}` : 'Preparazione');
      setText(jr.elapsed, fmtDuration(p.job.elapsed));
      setText(jr.remaining, p.state === 'paused' ? 'in pausa' : (p.job.remaining !== null ? fmtDuration(p.job.remaining) : 'calcolo…'));
      setText(jr.eta, p.state === 'paused' || p.job.remaining === null ? '-' : fmtClock(Date.now() + p.job.remaining * 1000));
      const stage = p.extra && p.extra.stage;
      jr.stage.hidden = !stage;
      if (stage) jr.stage.replaceChildren(icon('info', 'sm'), stage);
    }
  }

  function renderJob(p, file) {
    clear(jobCard);
    for (const k of Object.keys(jr)) delete jr[k];
    const title = h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('printer'), 'Stampa'));
    const body = h('div', { class: 'card-body' });
    jobCard.append(title, body);
    const thumb = () => {
      if (file && file.hasThumb) return fileThumb(file, 'job-thumb');
      if (p.job && p.job.thumbnail) return h('div', { class: 'job-thumb' }, h('img', { src: p.job.thumbnail, alt: '' }));
      return h('div', { class: 'job-thumb' }, icon('cube'));
    };

    if (p.state === 'sending' && p.task) {
      body.append(h('div', { class: 'job-main' }, thumb(),
        h('div', { class: 'grow', style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px', justifyContent: 'center' } },
          h('div', { class: 'job-file', title: p.task.file || '' }, p.task.file || 'File'),
          h('div', { class: 'row between' }, h('span', { class: 'dim', style: { fontSize: '13px' } }, 'Invio del file alla stampante'), jr.sendPct = h('span', { class: 'num dim' })),
          h('div', { class: 'progress' }, jr.sendFill = h('div')))));
      return;
    }

    if (p.job) {
      const m = (file && file.meta) || {};
      const details = [m.slicer, m.material, fmtFilament(m.filamentLength, m.filamentWeight) !== '-' ? fmtFilament(m.filamentLength, m.filamentWeight) : null].filter(Boolean).join(', ');
      body.append(
        h('div', { class: 'job-main' },
          thumb(),
          h('div', { class: 'grow', style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px', justifyContent: 'center' } },
            h('div', { class: 'job-file', title: p.job.file }, p.job.file),
            details ? h('div', { class: 'dim', style: { fontSize: '12.5px' } }, details) : null,
            h('div', { class: 'row between', style: { alignItems: 'baseline' } },
              jr.pct = h('div', { class: 'job-pct' }),
              jr.layer = h('div', { class: 'dim num', style: { fontSize: '13px' } })),
            h('div', { class: 'progress' + (p.state === 'paused' ? ' paused' : '') }, jr.fill = h('div')),
            jr.stage = h('div', { class: 'job-stage', hidden: true }))),
        h('div', { class: 'job-times' },
          h('div', null, jr.elapsed = h('div', { class: 't-v' }), h('div', { class: 't-l' }, 'trascorso')),
          h('div', null, jr.remaining = h('div', { class: 't-v' }), h('div', { class: 't-l' }, 'rimanente')),
          h('div', null, jr.eta = h('div', { class: 't-v' }), h('div', { class: 't-l' }, 'fine prevista'))),
        h('div', { class: 'job-actions' },
          p.state === 'paused'
            ? h('button', { class: 'btn primary grow', onclick: (e) => jobAction(P(), 'resume', e.currentTarget) }, icon('play'), 'Riprendi')
            : h('button', { class: 'btn grow', disabled: p.state !== 'printing', onclick: (e) => jobAction(P(), 'pause', e.currentTarget) }, icon('pause'), p.state === 'pausing' ? 'Pausa in corso…' : 'Pausa'),
          h('button', { class: 'btn outline-danger grow', disabled: p.state === 'cancelling', onclick: (e) => jobAction(P(), 'cancel', e.currentTarget) }, icon('stop'), 'Annulla')));
      return;
    }

    const ready = p.state === 'operational';
    const labels = { done: 'Completata', cancelled: 'Annullata', failed: 'Interrotta' };
    const accepted = (p.capabilities && p.capabilities.files) || ['.gcode'];
    const fileInput = h('input', { type: 'file', accept: accepted.includes('.3mf') ? '.gcode,.gco,.g,.3mf' : '.gcode,.gco,.g', hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      toast('info', 'Caricamento…', f.name, 2500);
      const r = await run(() => uploadFile(f));
      if (r && r.name) await run(() => api('POST', `/printers/${id}/job`, { action: 'start', file: r.name }));
    } });
    body.append(
      h('div', { class: 'job-main' },
        h('div', { class: 'job-thumb' }, icon('cube')),
        h('div', { class: 'grow', style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '6px', minWidth: 0 } },
          h('div', { class: 'job-file' }, p.state === 'cancelling' ? 'Annullamento in corso…' : 'Nessuna stampa in corso'),
          p.lastJob
            ? h('div', { class: 'dim', style: { fontSize: '13px' } },
              h('span', { class: 'r-' + p.lastJob.result, style: { fontWeight: 600 } }, labels[p.lastJob.result] || p.lastJob.result),
              `: ${p.lastJob.file}, ${fmtDuration(p.lastJob.duration, { short: true })}`,
              p.lastJob.reason ? h('div', { class: 'faint' }, p.lastJob.reason) : null)
            : h('div', { class: 'dim', style: { fontSize: '13px' } }, ready ? 'Scegli un file dall\'archivio o caricane uno nuovo.' : 'Connetti la stampante per stampare.'))),
      h('div', { class: 'job-actions' },
        fileInput,
        h('button', { class: 'btn primary grow', disabled: !ready, onclick: () => chooseFileToPrint(P()) }, icon('play'), 'Scegli il file'),
        h('button', { class: 'btn', disabled: !ready, title: 'Carica un file e avvia subito la stampa', onclick: () => fileInput.click() }, icon('upload'), 'Carica e stampa')));
  }

  // ---------------------------------------------------------------------------
  // temperature

  const chart = createTempChart(id);
  const tempRows = h('div', { class: 'temp-rows' });
  const presetsRow = h('div', { class: 'temp-presets' });
  const rangeSeg = h('div', { class: 'seg', style: { marginLeft: 'auto' }, role: 'group', 'aria-label': 'Intervallo del grafico' });
  let rangeMin = 10;
  for (const m of [5, 10, 30]) {
    rangeSeg.appendChild(h('button', {
      class: m === rangeMin ? 'active' : '',
      onclick: (e) => { rangeMin = m; chart.setWindow(m); rangeSeg.querySelectorAll('button').forEach((b) => b.classList.remove('active')); e.currentTarget.classList.add('active'); },
    }, `${m} min`));
  }
  const tempCard = h('section', { class: 'card', 'aria-label': 'Temperature' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('thermo'), 'Temperature'), rangeSeg),
    h('div', { class: 'card-body' }, chart.el, tempRows, presetsRow));

  let heatersKey = '';
  const tr = {};
  function heaterList(p) {
    const list = Object.keys(p.temps.tools).map((k) => ({ key: k, api: k, data: () => P().temps.tools[k] }));
    if (p.config.heatedBed || p.type !== 'usb') list.push({ key: 'B', api: 'bed', data: () => P().temps.bed });
    if ((p.type === 'usb' && p.config.heatedChamber) || p.temps.chamber) list.push({ key: 'C', api: 'chamber', data: () => P().temps.chamber });
    return list;
  }

  function updateTemps(p) {
    const heaters = heaterList(p);
    const isOn = connected(p);
    const canSet = !!(p.capabilities && p.capabilities.temps);
    const key = heaters.map((x) => x.key).join(',') + '|' + isOn + '|' + canSet + '|' + JSON.stringify(store.settings.presets || []);
    if (key !== heatersKey) {
      heatersKey = key;
      clear(tempRows);
      for (const k of Object.keys(tr)) delete tr[k];
      for (const ht of heaters) {
        const settable = canSet && !(p.type === 'bambu' && ht.key === 'C');
        let setBox = null;
        if (settable) {
          const input = h('input', { class: 'input sm num', type: 'number', min: '0', max: '450', placeholder: '°C', disabled: !isOn, 'aria-label': `Temperatura ${heaterLabel(ht.key, p.config.extruders)}` });
          const set = () => {
            const v = Number(input.value);
            if (input.value === '' || isNaN(v)) return;
            run(() => api('POST', `/printers/${id}/temperature`, { heater: ht.api, target: v }));
            input.value = '';
            input.blur();
          };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') set(); });
          setBox = h('div', { class: 'temp-set' }, input,
            h('button', { class: 'btn sm', disabled: !isOn, onclick: set }, 'Imposta'),
            h('button', { class: 'btn sm ghost', disabled: !isOn, title: 'Spegni', onclick: () => run(() => api('POST', `/printers/${id}/temperature`, { heater: ht.api, target: 0 })) }, 'Spegni'));
        }
        tr[ht.key] = { actual: h('span'), target: h('small') };
        tempRows.appendChild(h('div', { class: 'temp-row' },
          h('span', { class: 'swatch', style: { background: heaterColor(ht.key) } }),
          h('span', { class: 't-name' }, heaterLabel(ht.key, p.config.extruders)),
          h('span', { class: 't-actual' }, tr[ht.key].actual, tr[ht.key].target),
          setBox || h('span')));
      }
      clear(presetsRow);
      presetsRow.hidden = !canSet;
      if (canSet) {
        presetsRow.append(h('span', { class: 'faint', style: { fontSize: '12.5px', marginRight: '4px' } }, 'Preriscalda'));
        for (const pr of store.settings.presets || []) {
          presetsRow.appendChild(h('button', {
            class: 'btn sm', disabled: !isOn, title: `Ugello ${pr.hotend}°, piatto ${pr.bed}°`,
            onclick: () => {
              const targets = {};
              for (const k of Object.keys(P().temps.tools)) targets[k] = pr.hotend;
              targets.bed = pr.bed;
              run(() => api('POST', `/printers/${id}/temperature`, { targets }));
            },
          }, `${pr.name} ${pr.hotend}/${pr.bed}`));
        }
        presetsRow.appendChild(h('button', {
          class: 'btn sm ghost', disabled: !isOn,
          onclick: () => {
            const targets = {};
            for (const ht of heaterList(P())) if (!(P().type === 'bambu' && ht.key === 'C')) targets[ht.api] = 0;
            run(() => api('POST', `/printers/${id}/temperature`, { targets }));
          },
        }, icon('power', 'sm'), 'Spegni tutto'));
      }
    }
    for (const ht of heaters) {
      const t = ht.data();
      const r = tr[ht.key];
      if (!r) continue;
      setText(r.actual, isOn && t && t.actual !== null ? fmtTemp(t.actual) : '-');
      setText(r.target, isOn && t && t.target ? `obiettivo ${Math.round(t.target)}°` : (isOn && canSet ? 'spento' : ''));
    }
  }

  // ---------------------------------------------------------------------------
  // schede

  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Sezioni della stampante' });
  const tabBody = h('div', { role: 'tabpanel' });
  const goTab = (t) => { location.hash = `#/printer/${id}/${t}`; };
  function renderTabs() {
    const hadFocus = tabsEl.contains(document.activeElement);
    clear(tabsEl);
    for (const t of tabs) {
      const active = t.id === tab;
      tabsEl.appendChild(h('button', {
        class: 'tab' + (active ? ' active' : ''), role: 'tab', id: `tab-${t.id}`,
        'aria-selected': active ? 'true' : 'false', tabindex: active ? '0' : '-1',
        onclick: () => goTab(t.id),
      }, icon(t.icon, 'sm'), t.label));
    }
    tabBody.setAttribute('aria-labelledby', `tab-${tab}`);
    if (hadFocus) { const el = tabsEl.querySelector('.tab.active'); if (el) el.focus(); }
  }
  // frecce, Home e Fine per cambiare scheda dalla tastiera
  tabsEl.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t.id === tab);
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    goTab(tabs[next].id);
  });

  function setTab(t) {
    if (!tabs.some((x) => x.id === t)) t = tabs[0].id;
    if (t === tab && tabComp) return;
    tab = t;
    renderTabs();
    if (tabComp && tabComp.destroy) tabComp.destroy();
    clear(tabBody);
    const p = P();
    if (tab === 'control') tabComp = createControl(id);
    else if (tab === 'terminal') tabComp = createTerminal(id);
    else if (tab === 'preview') tabComp = createGcodeViewer(id);
    else if (tab === 'webcam') tabComp = createWebcam(p);
    else if (tab === 'firmware') tabComp = createFirmware(id);
    else tabComp = createPrinterSettings(id);
    tabBody.appendChild(tabComp.el);
    if (tabComp.update) tabComp.update(p);
    if (tabComp.setEnabled) tabComp.setEnabled(connected(p));
  }

  container.append(headEl, errorBox, h('div', { class: 'top-grid' }, jobCard, tempCard), tabsEl, tabBody);

  function update() {
    const p = P();
    if (!p) return;
    const next = tabsFor(p);
    if (next.map((t) => t.id).join() !== tabs.map((t) => t.id).join()) {
      tabs = next;
      if (!tabs.some((t) => t.id === tab)) setTab(tabs[0].id);
      else renderTabs();
    }
    updateHeader(p);
    updateJob(p);
    updateTemps(p);
    if (tabComp) {
      if (tabComp.update) tabComp.update(p);
      if (tabComp.setEnabled) tabComp.setEnabled(connected(p));
      if (tabComp.onPrinterUpdate) tabComp.onPrinterUpdate(p);
    }
  }

  update();
  setTab(tab);

  offs.push(on('printer', (p) => { if (p.id === id) update(); }));
  offs.push(on('printers', () => {
    if (!store.printers.has(id)) return;
    connKey = ''; heatersKey = ''; jobKey = '';
    const next = tabsFor(P());
    if (next.map((t) => t.id).join() !== tabs.map((t) => t.id).join()) { tabs = next; renderTabs(); }
    update();
    if (['webcam', 'settings', 'firmware'].includes(tab) || !tabs.some((t) => t.id === tab)) { const t = tab; tab = ''; setTab(t); }
  }));
  offs.push(on('temp', (pid) => { if (pid === id) chart.redraw(); }));
  offs.push(on('settings', () => { heatersKey = ''; update(); }));
  offs.push(on('files', () => { jobKey = ''; update(); if (tabComp && tabComp.onFilesChanged) tabComp.onFilesChanged(); }));
  const ticker = setInterval(() => { const p = P(); if (p && p.job) updateJob(p); }, 1000);

  return {
    setTab,
    destroy() {
      offs.forEach((f) => f());
      clearInterval(ticker);
      chart.destroy();
      if (tabComp && tabComp.destroy) tabComp.destroy();
    },
  };
}

// -----------------------------------------------------------------------------
// Scheda "Controllo": movimento, estrusore, ventola, velocità, luce e AMS

function createControl(id) {
  const P = () => store.printers.get(id);
  const caps = P().capabilities || {};
  let step = 10;
  let extrudeAmount = 5;
  const post = (path, body, button) => run(() => api('POST', `/printers/${id}/${path}`, body || {}), { button });
  const jog = (axes) => post('jog', axes);
  const cards = [];

  const jogBtn = (ic, axes, title) => h('button', { class: 'btn', title, 'aria-label': title, dataset: { jog: '1' }, onclick: () => jog(scaleAxes(axes)) }, icon(ic));
  const scaleAxes = (a) => ({ x: (a.x || 0) * step, y: (a.y || 0) * step, z: (a.z || 0) * step });

  const posEl = h('div', { class: 'pos' });
  if (caps.jog) {
    const stepSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Passo' });
    for (const s of [0.1, 1, 10, 100]) {
      stepSeg.appendChild(h('button', {
        class: s === step ? 'active' : '',
        onclick: (e) => { step = s; stepSeg.querySelectorAll('button').forEach((b) => b.classList.remove('active')); e.currentTarget.classList.add('active'); },
      }, String(s).replace('.', ',') + ' mm'));
    }
    cards.push(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('target'), 'Movimento')),
      h('div', { class: 'card-body' },
        h('div', { class: 'jog' },
          h('div'), jogBtn('up', { y: 1 }, 'Y+'), h('div'), h('div', { class: 'lbl' }), jogBtn('up', { z: 1 }, 'Z+ (su)'),
          jogBtn('left', { x: -1 }, 'X-'),
          h('button', { class: 'btn', title: 'Home X e Y', 'aria-label': 'Home X e Y', dataset: { jog: '1' }, onclick: () => post('home', { axes: ['x', 'y'] }) }, icon('home')),
          jogBtn('right', { x: 1 }, 'X+'), h('div', { class: 'lbl' }), h('div', { class: 'lbl' }, 'Z'),
          h('div'), jogBtn('down', { y: -1 }, 'Y-'), h('div'), h('div', { class: 'lbl' }), jogBtn('down', { z: -1 }, 'Z- (giù)')),
        h('div', { class: 'steps' }, stepSeg),
        h('div', { class: 'home-row' },
          h('button', { class: 'btn sm', dataset: { jog: '1' }, onclick: (e) => post('home', { axes: ['x', 'y', 'z'] }, e.currentTarget) }, icon('home', 'sm'), 'Home tutti'),
          P().type === 'bambu' ? null : h('button', { class: 'btn sm', dataset: { jog: '1' }, onclick: (e) => post('home', { axes: ['z'] }, e.currentTarget) }, 'Home Z'),
          caps.motorsOff ? h('button', { class: 'btn sm', dataset: { jog: '1' }, onclick: (e) => post('motors-off', {}, e.currentTarget) }, icon('motor', 'sm'), 'Motori off') : null,
          P().type === 'usb' ? h('button', { class: 'btn sm', dataset: { conn: '1' }, onclick: () => post('command', { commands: ['M114'] }) }, 'Leggi posizione') : null),
        posEl)));
  }

  const extruderSel = h('select', { class: 'select sm', style: { width: '130px' }, 'aria-label': 'Estrusore' });
  const hotWarn = h('div', { class: 'alert warn', hidden: true }, icon('alert', 'sm'), h('div', null, 'L\'ugello è freddo: scaldalo ad almeno 170° prima di estrudere.'));
  const tool = () => (P().config.extruders > 1 ? Number(extruderSel.value) : undefined);
  if (caps.extrude) {
    cards.push(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('droplet'), 'Estrusore')),
      h('div', { class: 'card-body stack' },
        h('div', { class: 'row' },
          h('span', { class: 'label' }, 'Quantità'),
          h('input', { class: 'input sm num', type: 'number', value: String(extrudeAmount), min: '0.1', step: '1', style: { width: '90px' }, 'aria-label': 'Quantità in millimetri', oninput: (e) => { extrudeAmount = Number(e.target.value) || 0; } }),
          h('span', { class: 'faint' }, 'mm'),
          extruderSel),
        h('div', { class: 'row' },
          h('button', { class: 'btn grow', dataset: { jog: '1' }, onclick: (e) => post('extrude', { amount: extrudeAmount, tool: tool() }, e.currentTarget) }, icon('down', 'sm'), 'Estrudi'),
          h('button', { class: 'btn grow', dataset: { jog: '1' }, onclick: (e) => post('extrude', { amount: -extrudeAmount, tool: tool() }, e.currentTarget) }, icon('up', 'sm'), 'Ritrai')),
        hotWarn,
        P().type === 'usb' ? h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', dataset: { jog: '1' }, title: 'Cambio filamento guidato dal firmware (M600)', onclick: () => post('command', { commands: ['M600'] }) }, icon('spool', 'sm'), 'Cambio filamento (M600)')) : null)));
  }

  const slider = (label, min, max, def, unit, onCommit) => {
    const val = h('span', { class: 'val' });
    const input = h('input', { type: 'range', min: String(min), max: String(max), value: String(def), dataset: { conn: '1' }, 'aria-label': label });
    const show = () => setText(val, input.value + unit);
    input.addEventListener('input', show);
    input.addEventListener('change', () => onCommit(Number(input.value)));
    show();
    return { el: h('div', { class: 'slider-row' }, h('span', { class: 'label' }, label), input, val), input, show };
  };
  const fan = slider('Ventola', 0, 100, 0, '%', (v) => post('fan', { speed: v }));
  const feed = slider('Velocità', 50, 200, 100, '%', (v) => post('rates', { feed: v }));
  const flow = slider('Flusso', 75, 125, 100, '%', (v) => post('rates', { flow: v }));
  const speedSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Modalità di velocità' });
  const lightSwitch = h('span');
  if (caps.fan || caps.feedRate || caps.speedLevel || caps.light) {
    const levels = [[1, 'Silenziosa'], [2, 'Standard'], [3, 'Sport'], [4, 'Ludicrous']];
    for (const [lvl, label] of levels) {
      speedSeg.appendChild(h('button', { dataset: { level: String(lvl), conn: '1' }, onclick: () => post('speed-level', { level: lvl }) }, label));
    }
    cards.push(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('fan'), caps.speedLevel ? 'Ventola, velocità e luce' : 'Ventola e velocità')),
      h('div', { class: 'card-body stack' },
        caps.fan ? fan.el : null,
        caps.fan ? h('div', { class: 'row' },
          h('button', { class: 'btn sm', dataset: { conn: '1' }, onclick: () => post('fan', { speed: 100 }) }, 'Ventola al massimo'),
          h('button', { class: 'btn sm', dataset: { conn: '1' }, onclick: () => post('fan', { speed: 0 }) }, 'Ventola spenta')) : null,
        caps.speedLevel ? h('div', { class: 'field' }, h('label', null, 'Velocità di stampa'), speedSeg) : null,
        caps.light ? lightSwitch : null,
        caps.feedRate ? feed.el : null,
        caps.flowRate ? flow.el : null,
        caps.feedRate ? h('div', { class: 'row' },
          h('button', { class: 'btn sm', dataset: { conn: '1' }, onclick: () => post('rates', { feed: 100, flow: 100 }) }, 'Ripristina 100%'),
          h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Si cambiano anche durante la stampa.')) : null)));
  }

  const amsBox = h('div', { class: 'stack tight' });
  const amsCard = h('section', { class: 'card', hidden: true },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('spool'), 'Filamenti')),
    h('div', { class: 'card-body' }, amsBox));
  if (P().type === 'bambu') cards.push(amsCard);

  const el = h('div', { class: 'control-grid' }, ...cards);
  let extKey = '';
  let amsKey = '';
  let lightKey = null;

  return {
    el,
    update(p) {
      const n = p.config.extruders || 1;
      if (String(n) !== extKey) {
        extKey = String(n);
        clear(extruderSel);
        for (let i = 0; i < n; i++) extruderSel.appendChild(h('option', { value: String(i) }, `Estrusore ${i + 1}`));
        extruderSel.hidden = n <= 1;
      }
      const canMove = ['operational', 'paused'].includes(p.state);
      const isOn = connected(p);
      el.querySelectorAll('[data-jog]').forEach((b) => { b.disabled = !canMove; });
      el.querySelectorAll('[data-conn]').forEach((b) => { b.disabled = !isOn; });
      const t = p.temps.tools[tool() !== undefined ? 'T' + tool() : 'T0'];
      hotWarn.hidden = !canMove || !t || t.actual === null || t.actual >= 170;
      if (p.position && p.position.z !== null && p.position.z !== undefined) {
        const pos = p.position;
        posEl.replaceChildren(...['x', 'y', 'z'].filter((a) => typeof pos[a] === 'number').map((a) => h('span', null, `${a.toUpperCase()} ${pos[a].toFixed(2)}`)));
      } else posEl.replaceChildren(h('span', { class: 'faint' }, 'Posizione sconosciuta'));
      if (document.activeElement !== fan.input && p.fanSpeed !== null && p.fanSpeed !== undefined) { fan.input.value = String(p.fanSpeed); fan.show(); }
      if (document.activeElement !== feed.input && p.feedRate) { feed.input.value = String(p.feedRate); feed.show(); }
      if (document.activeElement !== flow.input && p.flowRate) { flow.input.value = String(p.flowRate); flow.show(); }
      const extra = p.extra || {};
      speedSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.level) === extra.speedLevel));
      const lk = String(extra.light) + isOn;
      if (lk !== lightKey) {
        lightKey = lk;
        lightSwitch.replaceChildren(toggle('Luce della camera', !!extra.light, (v) => post('light', { on: v })));
        const inp = lightSwitch.querySelector('input');
        if (inp) inp.disabled = !isOn;
      }
      const ams = extra.ams || [];
      const ext = extra.externalSpool;
      const key = JSON.stringify([ams, ext]);
      if (key !== amsKey) {
        amsKey = key;
        clear(amsBox);
        amsCard.hidden = !ams.length && !ext;
        const slot = (tray, label, active) => h('div', { class: 'ams-slot' + (active ? ' active' : ''), title: tray && tray.type ? `${tray.type}${tray.remain !== null && tray.remain >= 0 ? `, ${tray.remain}% rimasto` : ''}` : 'Vuoto' },
          h('span', { class: 'spool' + (tray && tray.color ? '' : ' none'), style: tray && tray.color ? { background: tray.color } : {} }),
          h('span', null, label),
          h('span', { class: 'faint' }, tray && tray.type ? tray.type : 'vuoto'));
        for (const unit of ams) {
          amsBox.append(h('div', { class: 'row between' }, h('span', { class: 'label' }, `AMS ${unit.id + 1}`), unit.humidity !== null ? h('span', { class: 'faint', style: { fontSize: '12px' } }, `umidità ${unit.humidity}`) : null),
            h('div', { class: 'ams' }, ...unit.trays.map((tr) => slot(tr, `Slot ${tr.slot + 1}`, tr.active))));
        }
        if (ext && ext.type) amsBox.append(h('span', { class: 'label' }, 'Bobina esterna'), h('div', { class: 'ams' }, slot(ext, 'Esterna', false)));
      }
    },
  };
}

// -----------------------------------------------------------------------------
// Scheda "Impostazioni" della stampante

function createPrinterSettings(id) {
  const p = store.printers.get(id);
  const cfg = JSON.parse(JSON.stringify(p.config));
  const usb = (p.type || 'usb') === 'usb';
  const caps = p.capabilities || {};

  const numField = (label, obj, key, unit, attrs = {}) => h('div', { class: 'field' },
    h('label', null, label),
    h('div', { class: 'row' },
      h('input', { class: 'input grow num', type: 'number', value: String(obj[key]), ...attrs, oninput: (e) => { obj[key] = e.target.value === '' ? '' : Number(e.target.value); } }),
      unit ? h('span', { class: 'faint' }, unit) : null));
  const script = (label, key, hint) => h('div', { class: 'field' },
    h('label', null, label),
    h('textarea', { class: 'textarea', rows: '4', spellcheck: false, oninput: (e) => { cfg.scripts[key] = e.target.value; } }, cfg.scripts[key] || ''),
    hint ? h('div', { class: 'hint' }, hint) : null);

  const sections = [];
  const type = PRINTER_TYPES[p.type || 'usb'];
  sections.push(h('div', { class: 'card' }, h('div', { class: 'card-body row' },
    h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, 'Dati e collegamento'),
      h('div', { class: 'dim', style: { fontSize: '13px' } }, usb
        ? 'Nome, modello, colore, porta, baudrate, volume di stampa, estrusori.'
        : `Nome, modello, colore e collegamento ${type.label} (indirizzo e credenziali).`)),
    h('button', { class: 'btn', onclick: () => openPrinterForm(store.printers.get(id)) }, icon('edit'), 'Modifica'))));

  if (caps.jog) {
    sections.push(section('Movimento manuale',
      h('div', { class: 'grid-3' },
        numField('Velocità X/Y', cfg.jog, 'xySpeed', 'mm/min', { min: '60' }),
        numField('Velocità Z', cfg.jog, 'zSpeed', 'mm/min', { min: '30' }),
        numField('Velocità estrusione', cfg, 'extrudeSpeed', 'mm/min', { min: '10' }))));
  }

  // webcam configurabile solo per le stampanti USB (le altre hanno quella della stampante)
  const camDevice = h('select', { class: 'select', onchange: (e) => { cfg.webcam.deviceId = e.target.value; } }, h('option', { value: '' }, 'Telecamera predefinita'));
  const loadCams = async () => {
    const cams = await listCameras();
    clear(camDevice).appendChild(h('option', { value: '' }, 'Telecamera predefinita'));
    for (const c of cams) camDevice.appendChild(h('option', { value: c.id }, c.label));
    camDevice.value = cfg.webcam.deviceId || '';
  };
  const camLocal = h('div', { class: 'field' }, h('label', null, 'Telecamera'),
    h('div', { class: 'input-group' }, h('div', { class: 'grow' }, camDevice), h('button', { class: 'btn icon-only', title: 'Cerca telecamere', 'aria-label': 'Cerca telecamere', onclick: loadCams }, icon('refresh'))));
  const camUrl = h('div', { class: 'field' }, h('label', null, 'Indirizzo del flusso'),
    h('input', { class: 'input', value: cfg.webcam.url, placeholder: 'http://192.168.1.50:8080/?action=stream', oninput: (e) => { cfg.webcam.url = e.target.value; } }),
    h('div', { class: 'hint' }, 'Flusso MJPEG (mjpg-streamer, app "IP Webcam") oppure immagine aggiornata ogni secondo.'));
  const updateCam = () => { camLocal.hidden = cfg.webcam.type !== 'local'; camUrl.hidden = cfg.webcam.type !== 'url'; if (cfg.webcam.type === 'local') loadCams(); };
  const camType = h('select', { class: 'select', onchange: (e) => { cfg.webcam.type = e.target.value; updateCam(); } },
    h('option', { value: 'none' }, 'Nessuna'),
    h('option', { value: 'local' }, 'Webcam USB collegata al PC'),
    h('option', { value: 'url' }, 'Flusso di rete (URL)'));
  camType.value = cfg.webcam.type;
  const rotate = h('select', { class: 'select', onchange: (e) => { cfg.webcam.rotate = Number(e.target.value); } },
    ...[0, 90, 180, 270].map((r) => h('option', { value: String(r) }, r + '°')));
  rotate.value = String(cfg.webcam.rotate || 0);

  if (usb) {
    const park = h('div', { class: 'grid-2' },
      numField('Parcheggio X', cfg.pause, 'parkX', 'mm'),
      numField('Parcheggio Y', cfg.pause, 'parkY', 'mm'));
    park.hidden = !cfg.pause.park;
    sections.push(
      section('Pausa',
        h('div', { class: 'grid-2' },
          numField('Retrazione in pausa', cfg.pause, 'retract', 'mm', { min: '0', step: '0.5' }),
          numField('Sollevamento Z in pausa', cfg.pause, 'lift', 'mm', { min: '0' })),
        check('Sposta la testina in un punto di parcheggio durante la pausa', cfg.pause.park, (v) => { cfg.pause.park = v; park.hidden = !v; }),
        park,
        h('div', { class: 'hint' }, 'Alla ripresa SonoPrint riporta la testina, riabbassa Z, recupera la retrazione e ripristina le modalità di posizionamento.')),
      section('Script G-code',
        h('div', { class: 'grid-2' },
          script('Dopo la connessione', 'afterConnect'),
          script('Prima di ogni stampa', 'beforePrint', 'Eseguito prima del file (lo start G-code dello slicer resta nel file).'),
          script('Dopo una stampa completata', 'afterPrint'),
          script('Dopo l\'annullamento', 'afterCancel', 'Di solito spegne riscaldatori e ventola e alza l\'ugello.'),
          script('In pausa (aggiuntivo)', 'pause'),
          script('Alla ripresa (aggiuntivo)', 'resume'))),
      section('Webcam',
        h('div', { class: 'grid-2' },
          h('div', { class: 'field' }, h('label', null, 'Tipo'), camType),
          h('div', { class: 'field' }, h('label', null, 'Rotazione'), rotate)),
        camLocal, camUrl,
        h('div', { class: 'row' },
          check('Specchia orizzontalmente', cfg.webcam.flipH, (v) => { cfg.webcam.flipH = v; }),
          check('Capovolgi verticalmente', cfg.webcam.flipV, (v) => { cfg.webcam.flipV = v; }))));
  }

  if (p.type === 'bambu') {
    sections.push(section('Quando avvii una stampa',
      check('Usa l\'AMS (i filamenti usano gli slot in ordine: 1, 2, 3, 4)', cfg.bambu.useAms, (v) => { cfg.bambu.useAms = v; }),
      check('Livellamento del piatto', cfg.bambu.bedLeveling, (v) => { cfg.bambu.bedLeveling = v; }),
      check('Timelapse', cfg.bambu.timelapse, (v) => { cfg.bambu.timelapse = v; })));
  }

  const save = async (button) => {
    const payload = usb
      ? { jog: cfg.jog, extrudeSpeed: cfg.extrudeSpeed, pause: cfg.pause, scripts: cfg.scripts, webcam: cfg.webcam }
      : { jog: cfg.jog, extrudeSpeed: cfg.extrudeSpeed, ...(p.type === 'bambu' ? { bambu: cfg.bambu } : {}) };
    const r = await run(() => api('PUT', `/printers/${id}`, payload), { button });
    if (r) toast('success', 'Impostazioni salvate', p.config.name);
  };

  const el = h('div', { class: 'settings-form stack' },
    ...sections,
    h('div', { class: 'row' },
      sections.length > 1 ? h('button', { class: 'btn primary', onclick: (e) => save(e.currentTarget) }, icon('check'), 'Salva impostazioni') : null,
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn outline-danger',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Rimuovere la stampante?',
            message: `"${p.config.name}" verrà tolta da SonoPrint. I file e la cronologia restano.`,
            confirmLabel: 'Rimuovi', danger: true,
          });
          if (ok && await run(() => api('DELETE', `/printers/${id}`))) location.hash = '#/';
        },
      }, icon('trash'), 'Rimuovi stampante')));

  if (usb) updateCam();
  return { el };
}

function section(title, ...children) {
  return h('section', { class: 'card settings-section' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title)),
    h('div', { class: 'card-body stack' }, ...children));
}
