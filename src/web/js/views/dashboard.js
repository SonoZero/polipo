// Panoramica: tutte le stampanti a colpo d'occhio.

import { h, icon, clear, setText, fmtDuration, fmtClock, fmtPct, fmtTemp, stateBadge, heaterLabel } from '../util.js';
import { store, on, printerList, fileByName } from '../api.js';
import { connectPrinter, jobAction, chooseFileToPrint, fileThumb } from '../actions.js';
import { openPrinterForm } from './printer-form.js';

export function mountDashboard(container) {
  const offs = [];
  const cards = new Map();

  const stats = h('div', { class: 'dash-stats' });
  const grid = h('div', { class: 'printer-grid' });

  container.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, 'Panoramica'),
        h('div', { class: 'page-sub' }, 'Tutte le tue stampanti in un colpo d\'occhio.')),
      h('button', { class: 'btn primary', onclick: () => openPrinterForm() }, icon('plus'), 'Aggiungi stampante')),
    stats,
    grid,
  );

  const statRefs = {};
  const stat = (key, label, ic) => h('div', { class: 'card stat' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      statRefs[key] = h('div', { class: 'v' }, '—'),
      icon(ic, 'lg faint')),
    statRefs[key + 'L'] = h('div', { class: 'l' }, label));
  stats.append(
    stat('connected', 'stampanti connesse', 'plug'),
    stat('printing', 'in stampa ora', 'printer'),
    stat('next', 'prossima stampa finita', 'flag'),
    stat('done', 'stampe riuscite negli ultimi 30 giorni', 'check'),
  );

  function updateStats() {
    const list = printerList();
    const connected = list.filter((p) => p.state !== 'offline').length;
    setText(statRefs.connected, `${connected}/${list.length}`);
    const printing = list.filter((p) => p.job);
    setText(statRefs.printing, String(printing.length));
    const withEta = printing.filter((p) => p.job.remaining !== null && p.state === 'printing')
      .map((p) => ({ p, eta: Date.now() + p.job.remaining * 1000 }))
      .sort((a, b) => a.eta - b.eta);
    if (withEta.length) {
      setText(statRefs.next, fmtClock(withEta[0].eta));
      setText(statRefs.nextL, `fine prevista · ${withEta[0].p.config.name}`);
    } else {
      setText(statRefs.next, '—');
      setText(statRefs.nextL, 'prossima stampa finita');
    }
    const cutoff = Date.now() - 30 * 86400000;
    const recent = store.history.filter((x) => x.finishedAt > cutoff);
    const ok = recent.filter((x) => x.result === 'done').length;
    setText(statRefs.done, String(ok));
    const failed = recent.filter((x) => x.result === 'failed').length;
    setText(statRefs.doneL, failed ? `stampe riuscite (30 giorni) · ${failed} fallite` : 'stampe riuscite negli ultimi 30 giorni');
  }

  function renderGrid() {
    clear(grid);
    cards.clear();
    const list = printerList();
    if (!list.length) {
      grid.style.display = 'block';
      grid.appendChild(h('div', { class: 'card' },
        h('div', { class: 'empty' },
          h('img', { src: 'img/icon.svg', alt: '', style: { width: '64px', height: '64px' } }),
          h('h3', null, 'Benvenuto in Polipo!'),
          h('p', null, 'Aggiungi la tua prima stampante 3D: collegala al PC con il cavo USB e scegli la sua porta. Se vuoi solo provare l\'app, usa la "Stampante virtuale".'),
          h('button', { class: 'btn primary', style: { marginTop: '8px' }, onclick: () => openPrinterForm() }, icon('plus'), 'Aggiungi stampante'))));
      return;
    }
    grid.style.display = '';
    for (const p of list) {
      const card = createCard(p);
      cards.set(p.id, card);
      grid.appendChild(card.el);
    }
    grid.appendChild(h('button', { class: 'add-card', onclick: () => openPrinterForm() }, icon('plus'), 'Aggiungi stampante'));
  }

  renderGrid();
  updateStats();

  offs.push(on('printers', () => { renderGrid(); updateStats(); }));
  offs.push(on('printer', (p) => { const c = cards.get(p.id); if (c) c.update(p); updateStats(); }));
  offs.push(on('files', () => { for (const c of cards.values()) c.update(store.printers.get(c.id), true); }));
  offs.push(on('history', updateStats));
  const clock = setInterval(updateStats, 30000);

  return {
    destroy() { offs.forEach((f) => f()); clearInterval(clock); },
  };
}

function createCard(initial) {
  const refs = {};
  const el = h('div', { class: 'card pcard' },
    refs.strip = h('div', { class: 'strip' }),
    h('div', { class: 'pcard-head' },
      h('div', { class: 'grow', style: { minWidth: 0 } },
        refs.name = h('div', { class: 'pcard-name', onclick: () => { location.hash = `#/printer/${initial.id}`; } }),
        refs.model = h('div', { class: 'pcard-model' })),
      refs.badge = h('div')),
    refs.body = h('div', { class: 'pcard-body' }),
    refs.temps = h('div', { class: 'pcard-temps' }),
    refs.foot = h('div', { class: 'pcard-foot' }));

  let layoutKey = '';
  let heatersKey = '';

  function update(p, force) {
    if (!p) return;
    refs.strip.style.background = p.config.color;
    setText(refs.name, p.config.name);
    const sub = p.config.model || (p.firmware && p.firmware.machine) || '';
    setText(refs.model, sub || (p.port === 'VIRTUAL' || p.config.port === 'VIRTUAL' ? 'Stampante virtuale' : (p.config.port || 'Porta non impostata')));

    const file = p.job ? fileByName(p.job.file) : null;
    const key = [p.state, p.job ? p.job.file : '', file && file.hasThumb, p.lastJob && p.lastJob.finishedAt, p.error].join('|');
    if (key !== layoutKey || force) {
      layoutKey = key;
      clear(refs.badge).appendChild(stateBadge(p.state));
      renderBody(p, file);
      renderFoot(p);
    }
    patchBody(p);

    const heaters = [...Object.keys(p.temps.tools), ...(p.config.heatedBed ? ['B'] : []), ...(p.temps.chamber ? ['C'] : [])];
    const hk = heaters.join(',');
    if (hk !== heatersKey) {
      heatersKey = hk;
      clear(refs.temps);
      refs.tempVals = {};
      for (const k of heaters) {
        refs.tempVals[k] = h('b');
        refs.temps.appendChild(h('div', { class: 'pcard-temp' },
          icon(k === 'B' ? 'bed' : 'thermo', 'sm'),
          h('span', { class: 'dim' }, heaterLabel(k, p.config.extruders)),
          h('span', { class: 'grow' }),
          refs.tempVals[k]));
      }
    }
    for (const k of heaters) {
      const t = k === 'B' ? p.temps.bed : k === 'C' ? p.temps.chamber : p.temps.tools[k];
      const offline = p.state === 'offline';
      const r = refs.tempVals[k];
      if (!r.actual) r.append(r.actual = h('span'), r.target = h('small'));
      setText(r.actual, offline || !t || t.actual === null ? '—' : fmtTemp(t.actual));
      setText(r.target, !offline && t && t.target ? ` / ${Math.round(t.target)}°` : '');
    }
  }

  function renderBody(p, file) {
    clear(refs.body);
    refs.job = null;
    if (p.job) {
      const j = {};
      refs.job = j;
      refs.body.append(
        fileThumb(file, 'pcard-thumb'),
        h('div', { class: 'pcard-job' },
          j.file = h('div', { class: 'pcard-file', title: p.job.file }, p.job.file),
          h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'baseline' } },
            j.pct = h('div', { class: 'pcard-pct' }),
            j.layer = h('div', { class: 'dim num', style: { fontSize: '12.5px' } })),
          j.bar = h('div', { class: 'progress' + (p.state === 'paused' ? ' paused' : '') }, j.fill = h('div')),
          h('div', { class: 'pcard-meta' },
            j.elapsed = h('span', { class: 'num' }),
            j.remaining = h('span', { class: 'num' }))));
      return;
    }
    const info = h('div', { class: 'pcard-job' });
    refs.body.append(h('div', { class: 'pcard-thumb' }, icon(p.state === 'error' ? 'alert' : p.state === 'offline' ? 'unplug' : 'printer')), info);
    if (p.state === 'error') {
      info.append(h('div', { class: 'pcard-file', style: { color: 'var(--danger)' } }, 'Si è verificato un errore'), h('div', { class: 'err' }, p.error || ''));
    } else if (p.state === 'offline') {
      info.append(h('div', { class: 'pcard-file' }, 'Non connessa'),
        h('div', { class: 'dim', style: { fontSize: '13px' } }, p.config.port ? `Pronta a connettersi su ${p.config.port === 'VIRTUAL' ? 'stampante virtuale' : p.config.port}.` : 'Imposta la porta per connetterla.'));
    } else if (p.state === 'connecting') {
      info.append(h('div', { class: 'pcard-file' }, 'Connessione in corso…'), h('div', { class: 'dim', style: { fontSize: '13px' } }, 'Attendo la risposta della stampante.'));
    } else {
      info.append(h('div', { class: 'pcard-file' }, p.state === 'cancelling' ? 'Annullamento in corso…' : 'Pronta a stampare'));
      if (p.lastJob) {
        const labels = { done: 'completata', cancelled: 'annullata', failed: 'interrotta' };
        info.append(h('div', { class: 'dim', style: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: p.lastJob.file },
          `Ultima: ${p.lastJob.file}`),
        h('div', { class: 'r-' + p.lastJob.result, style: { fontSize: '12.5px', fontWeight: 600 } },
          `${labels[p.lastJob.result] || p.lastJob.result} · ${fmtDuration(p.lastJob.duration, { short: true })}`));
      } else {
        info.append(h('div', { class: 'dim', style: { fontSize: '13px' } }, 'Scegli un file G-code da stampare.'));
      }
    }
  }

  function patchBody(p) {
    const j = refs.job;
    if (!j || !p.job) return;
    setText(j.pct, fmtPct(p.job.progress));
    j.fill.style.width = (p.job.progress * 100).toFixed(2) + '%';
    setText(j.layer, p.job.layer ? `layer ${p.job.layer}${p.job.layerCount ? '/' + p.job.layerCount : ''}` : '');
    setText(j.elapsed, `⏱ ${fmtDuration(p.job.elapsed, { short: true })}`);
    if (p.state === 'paused') setText(j.remaining, 'in pausa');
    else setText(j.remaining, p.job.remaining !== null ? `mancano ${fmtDuration(p.job.remaining, { short: true })} · fine ${fmtClock(Date.now() + p.job.remaining * 1000)}` : 'calcolo tempo…');
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
