// Panoramica: tutte le stampanti a colpo d'occhio.

import { h, icon, clear, setText, fmtDuration, fmtClock, fmtPct, fmtTemp, stateBadge, heaterLabel, PRINTER_TYPES, connectionLabel } from '../util.js';
import { store, on, printerList, fileByName } from '../api.js';
import { connectPrinter, jobAction, chooseFileToPrint, fileThumb } from '../actions.js';
import { openAddPrinter } from './printer-form.js';

export function mountDashboard(container) {
  const offs = [];
  const cards = new Map();

  const summary = h('div', { class: 'summary', 'aria-live': 'polite' });
  const grid = h('div', { class: 'printer-grid' });
  const head = h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', { class: 'page-title' }, 'Panoramica')),
    h('div', { class: 'page-actions' },
      h('button', { class: 'btn', onclick: () => openAddPrinter({ discover: true }) }, icon('broadcast'), 'Cerca in rete'),
      h('button', { class: 'btn primary', onclick: () => openAddPrinter() }, icon('plus'), 'Aggiungi stampante')));

  container.append(head, summary, grid);

  function updateSummary() {
    const list = printerList();
    clear(summary);
    summary.hidden = !list.length;
    if (!list.length) return;
    const connected = list.filter((p) => !['offline', 'error'].includes(p.state)).length;
    const printing = list.filter((p) => p.job);
    const next = printing.filter((p) => p.job.remaining !== null && p.state === 'printing')
      .map((p) => ({ p, eta: Date.now() + p.job.remaining * 1000 }))
      .sort((a, b) => a.eta - b.eta)[0];
    const cutoff = Date.now() - 30 * 86400000;
    const recent = store.history.filter((x) => x.finishedAt > cutoff);
    const ok = recent.filter((x) => x.result === 'done').length;
    const item = (...children) => h('span', null, ...children);
    summary.append(...[
      item(h('b', null, `${connected} su ${list.length}`), list.length === 1 ? ' connessa' : ' connesse'),
      item(h('b', null, String(printing.length)), ' in stampa'),
      next ? item('Prossima fine alle ', h('b', null, fmtClock(next.eta)), `, ${next.p.config.name}`) : null,
      item(h('b', null, String(ok)), ok === 1 ? ' stampa riuscita in 30 giorni' : ' stampe riuscite in 30 giorni'),
    ].filter(Boolean));
  }

  function renderGrid() {
    clear(grid);
    cards.clear();
    const list = printerList();
    if (!list.length) {
      grid.style.display = 'block';
      grid.appendChild(welcome());
      return;
    }
    grid.style.display = '';
    list.forEach((p, i) => {
      const card = createCard(p, i);
      cards.set(p.id, card);
      grid.appendChild(card.el);
    });
    grid.appendChild(h('button', { class: 'add-card', onclick: () => openAddPrinter() },
      icon('plus'), 'Aggiungi stampante', h('small', null, 'USB, Bambu Lab, Klipper, PrusaLink, OctoPrint')));
  }

  renderGrid();
  updateSummary();

  offs.push(on('printers', () => { renderGrid(); updateSummary(); }));
  offs.push(on('printer', (p) => { const c = cards.get(p.id); if (c) c.update(p); updateSummary(); }));
  offs.push(on('files', () => { for (const c of cards.values()) c.update(store.printers.get(c.id), true); }));
  offs.push(on('history', updateSummary));
  const clock = setInterval(updateSummary, 30000);

  return {
    destroy() { offs.forEach((f) => f()); clearInterval(clock); },
  };
}

function welcome() {
  const way = (ic, title, text, fn) => h('button', { class: 'way', onclick: fn },
    h('span', { class: 'way-icon' }, icon(ic)), h('span', null, h('b', null, title), h('span', null, text)));
  return h('div', { class: 'card welcome' },
    h('div', null,
      h('img', { src: 'img/icon.svg', alt: '' }),
      h('h2', null, 'Collega la tua prima stampante'),
      h('p', null, 'SonoPrint controlla più stampanti insieme: via cavo USB oppure in rete, come le Bambu Lab e quelle con Klipper, PrusaLink o OctoPrint.')),
    h('div', { class: 'welcome-ways' },
      way('broadcast', 'Cerca in rete', 'Trova da solo le stampanti Wi-Fi e di rete.', () => openAddPrinter({ discover: true })),
      way('usb', 'Collega con il cavo USB', 'Per le stampanti Marlin, Prusa e RepRap.', () => openAddPrinter({ type: 'usb' })),
      way('cube', 'Prova senza stampante', 'Una stampante virtuale per esplorare l\'app.', () => openAddPrinter({ type: 'usb', virtual: true }))));
}

function createCard(initial, index) {
  const refs = {};
  const el = h('article', { class: 'card pcard', style: { '--i': String(index) } },
    h('div', { class: 'pcard-head' },
      refs.color = h('span', { class: 'pcard-color' }),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        refs.name = h('a', { class: 'pcard-name', href: `#/printer/${initial.id}` }),
        refs.model = h('div', { class: 'pcard-model' })),
      refs.badge = h('div')),
    refs.body = h('div', { class: 'pcard-body' }),
    refs.temps = h('div', { class: 'pcard-temps' }),
    refs.foot = h('div', { class: 'pcard-foot' }));

  let layoutKey = '';
  let heatersKey = '';

  function update(p, force) {
    if (!p) return;
    refs.color.style.background = p.config.color;
    setText(refs.name, p.config.name);
    const type = PRINTER_TYPES[p.type || 'usb'] || PRINTER_TYPES.usb;
    const model = p.config.model || (p.extra && p.extra.model) || (p.firmware && (p.firmware.machine || p.firmware.name)) || type.label;
    refs.model.replaceChildren(icon(type.icon), document.createTextNode(`${model}, ${connectionLabel(p)}`));

    const file = p.job ? fileByName(p.job.file) : null;
    const key = [p.state, p.job ? p.job.file : '', file && file.hasThumb, p.job && p.job.thumbnail, p.lastJob && p.lastJob.finishedAt, p.error, p.task && p.task.status].join('|');
    if (key !== layoutKey || force) {
      layoutKey = key;
      clear(refs.badge).appendChild(stateBadge(p.state));
      renderBody(p, file);
      renderFoot(p);
    }
    patchBody(p);

    const heaters = [...Object.keys(p.temps.tools), ...(p.config.heatedBed || p.type !== 'usb' ? ['B'] : []), ...(p.temps.chamber ? ['C'] : [])];
    const hk = heaters.join(',');
    if (hk !== heatersKey) {
      heatersKey = hk;
      clear(refs.temps);
      refs.tempVals = {};
      for (const k of heaters) {
        refs.tempVals[k] = h('b');
        refs.temps.appendChild(h('div', { class: 'pcard-temp' },
          icon(k === 'B' ? 'bed' : 'thermo', 'sm'),
          h('span', null, heaterLabel(k, p.config.extruders)),
          h('span', { class: 'grow' }),
          refs.tempVals[k]));
      }
    }
    for (const k of heaters) {
      const t = k === 'B' ? p.temps.bed : k === 'C' ? p.temps.chamber : p.temps.tools[k];
      const offline = ['offline', 'error'].includes(p.state);
      const r = refs.tempVals[k];
      if (!r.actual) r.append(r.actual = h('span'), r.target = h('small'));
      setText(r.actual, offline || !t || t.actual === null ? '-' : fmtTemp(t.actual));
      setText(r.target, !offline && t && t.target ? ` / ${Math.round(t.target)}°` : '');
    }
  }

  function renderBody(p, file) {
    clear(refs.body);
    refs.job = null;
    const thumb = () => {
      if (file && file.hasThumb) return fileThumb(file, 'pcard-thumb');
      if (p.job && p.job.thumbnail) return h('div', { class: 'pcard-thumb' }, h('img', { src: p.job.thumbnail, alt: '', loading: 'lazy' }));
      return h('div', { class: 'pcard-thumb' }, icon('cube'));
    };
    if (p.state === 'sending' && p.task) {
      const j = {};
      refs.job = null;
      refs.send = j;
      refs.body.append(thumb(), h('div', { class: 'pcard-job' },
        h('div', { class: 'pcard-file', title: p.task.file || '' }, p.task.file || 'File'),
        h('div', { class: 'dim', style: { fontSize: '12.5px' } }, 'Invio alla stampante'),
        j.bar = h('div', { class: 'progress' }, j.fill = h('div'))));
      return;
    }
    refs.send = null;
    if (p.job) {
      const j = {};
      refs.job = j;
      refs.body.append(
        thumb(),
        h('div', { class: 'pcard-job' },
          j.file = h('div', { class: 'pcard-file', title: p.job.file }, p.job.file),
          h('div', { class: 'row between', style: { alignItems: 'baseline' } },
            j.pct = h('div', { class: 'pcard-pct' }),
            j.layer = h('div', { class: 'dim num', style: { fontSize: '12.5px' } })),
          j.bar = h('div', { class: 'progress' + (p.state === 'paused' ? ' paused' : '') }, j.fill = h('div')),
          j.stage = h('div', { class: 'pcard-stage' }),
          h('div', { class: 'pcard-meta' },
            j.elapsed = h('span'),
            j.remaining = h('span'))));
      return;
    }
    const info = h('div', { class: 'pcard-job' });
    refs.body.append(h('div', { class: 'pcard-thumb' }, icon(p.state === 'error' ? 'alert' : p.state === 'offline' ? 'unplug' : 'printer')), info);
    const line = (text) => h('div', { class: 'dim', style: { fontSize: '13px' } }, text);
    if (p.state === 'error') {
      info.append(h('div', { class: 'pcard-file', style: { color: 'var(--danger)' } }, 'Serve attenzione'), h('div', { class: 'err' }, p.error || ''));
    } else if (p.state === 'offline') {
      info.append(h('div', { class: 'pcard-file' }, 'Non connessa'), line(`Pronta a collegarsi a ${connectionLabel(p)}.`));
    } else if (p.state === 'connecting') {
      info.append(h('div', { class: 'pcard-file' }, 'Connessione in corso…'), line(p.error || 'Attendo la risposta della stampante.'));
    } else {
      info.append(h('div', { class: 'pcard-file' }, p.state === 'cancelling' ? 'Annullamento in corso…' : 'Nessuna stampa in corso'));
      if (p.lastJob) {
        const labels = { done: 'Completata', cancelled: 'Annullata', failed: 'Interrotta' };
        info.append(
          h('div', { class: 'dim', style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: p.lastJob.file }, `Ultima: ${p.lastJob.file}`),
          h('div', { class: 'r-' + p.lastJob.result, style: { fontSize: '12.5px', fontWeight: 600 } },
            `${labels[p.lastJob.result] || p.lastJob.result} in ${fmtDuration(p.lastJob.duration, { short: true })}`));
      } else {
        info.append(line('Scegli un file da stampare.'));
      }
    }
  }

  function patchBody(p) {
    if (refs.send && p.task) {
      refs.send.fill.style.width = ((p.task.progress || 0) * 100).toFixed(1) + '%';
      return;
    }
    const j = refs.job;
    if (!j || !p.job) return;
    setText(j.pct, fmtPct(p.job.progress));
    j.fill.style.width = (p.job.progress * 100).toFixed(2) + '%';
    setText(j.layer, p.job.layer ? `layer ${p.job.layer}${p.job.layerCount ? ' di ' + p.job.layerCount : ''}` : '');
    setText(j.stage, p.extra && p.extra.stage ? p.extra.stage : '');
    j.stage.hidden = !(p.extra && p.extra.stage);
    setText(j.elapsed, fmtDuration(p.job.elapsed, { short: true }));
    if (p.state === 'paused') setText(j.remaining, 'in pausa');
    else setText(j.remaining, p.job.remaining !== null ? `fine ${fmtClock(Date.now() + p.job.remaining * 1000)}, mancano ${fmtDuration(p.job.remaining, { short: true })}` : 'calcolo del tempo…');
  }

  function renderFoot(p) {
    clear(refs.foot);
    const btn = (label, ic, cls, fn) => h('button', { class: 'btn sm ' + cls, onclick: (e) => fn(e.currentTarget) }, icon(ic, 'sm'), label);
    const cur = () => store.printers.get(p.id);
    if (p.state === 'offline' || p.state === 'error') {
      refs.foot.append(btn(p.state === 'error' ? 'Riconnetti' : 'Connetti', 'plug', 'primary', (b) => connectPrinter(cur(), b)));
    } else if (p.state === 'printing') {
      refs.foot.append(btn('Pausa', 'pause', '', (b) => jobAction(cur(), 'pause', b)), btn('Annulla', 'stop', 'outline-danger', (b) => jobAction(cur(), 'cancel', b)));
    } else if (p.state === 'paused') {
      refs.foot.append(btn('Riprendi', 'play', 'primary', (b) => jobAction(cur(), 'resume', b)), btn('Annulla', 'stop', 'outline-danger', (b) => jobAction(cur(), 'cancel', b)));
    } else if (p.state === 'operational') {
      refs.foot.append(btn('Stampa un file', 'play', 'primary', () => chooseFileToPrint(cur())));
    }
    refs.foot.append(h('span', { class: 'spacer' }),
      h('a', { class: 'btn sm ghost', href: `#/printer/${p.id}` }, 'Apri', icon('right', 'sm')));
  }

  update(initial);
  return { el, id: initial.id, update };
}
