// Centro aggiornamenti: SonoPrint e il firmware o il software di ogni stampante in un posto solo.
// Per ogni voce: versione installata e nuova, novità, avanzamento passo per passo e registro.
// "Aggiorna tutto" installa da solo quello che si può (Klipper, OctoPrint e l'app);
// il firmware da file (USB, Bambu Lab, Prusa) resta da fare a mano, con le istruzioni nei dettagli.

import { h, icon, clear, setText, fmtRelative, fmtSize, PRINTER_TYPES } from '../util.js';
import { api, store, on, printerList } from '../api.js';
import { run, toast, confirmDialog } from '../ui.js';
import { installUpdate, openReleases } from '../updates.js';
import { createFirmware } from '../components/firmware.js';

const TASK_TIMEOUT = 30 * 60 * 1000;

/** Quanti aggiornamenti ci sono in tutto (per il numero accanto alla voce del menu). */
export function updatesCount() {
  const a = store.app || {};
  const app = ['downloading', 'downloaded', 'available'].includes(a.status) ? 1 : 0;
  return app + printerList().reduce((n, p) => n + ((p.updates && p.updates.available) || 0), 0);
}

const connected = (p) => !['offline', 'connecting', 'error'].includes(p.state);
const hasFirmware = (p) => !!(p.capabilities && p.capabilities.firmware);
const printing = (p) => !!p.job || ['sending', 'printing', 'pausing', 'paused'].includes(p.state);
const usbPrinting = () => printerList().filter((p) => (p.type || 'usb') === 'usb' && printing(p));

export function mountUpdates(container) {
  const offs = [];
  const rows = new Map();
  let checking = false;
  let runner = null; // "Aggiorna tutto" in corso: { steps, el }

  const summary = h('div', { class: 'page-sub', 'aria-live': 'polite' });
  const checkBtn = h('button', { class: 'btn', onclick: () => checkAll() }, icon('refresh'), 'Controlla tutto');
  const allBtn = h('button', { class: 'btn primary', onclick: () => updateAll() }, icon('download'), 'Aggiorna tutto');
  const runBox = h('div');
  const appCard = h('section', { class: 'card upd-app' });
  const list = h('div', { class: 'upd-list' });

  container.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', { class: 'page-title' }, 'Aggiornamenti'), summary),
      h('div', { class: 'page-actions' }, checkBtn, allBtn)),
    runBox,
    h('div', { class: 'stack' },
      appCard,
      h('div', { class: 'upd-section' }, 'Stampanti'),
      list));

  // --- riepilogo in alto ------------------------------------------------------------------

  function plan() {
    const a = store.app || {};
    const auto = [];
    const manual = [];
    for (const p of printerList()) {
      const u = p.updates;
      if (!u || !u.available) continue;
      if (u.automatic && !printing(p)) auto.push(p);
      else manual.push(p);
    }
    const appReady = a.status === 'downloaded';
    return { auto, manual, appReady, appBlocked: appReady && usbPrinting().length > 0 };
  }

  function renderSummary() {
    const n = updatesCount();
    const times = printerList().map((p) => p.updates && p.updates.checkedAt).concat([store.app && store.app.checkedAt]).filter(Boolean);
    const last = times.length ? Math.max(...times) : null;
    const text = n === 0 ? 'Tutto aggiornato.' : n === 1 ? 'C\'è 1 aggiornamento.' : `Ci sono ${n} aggiornamenti.`;
    setText(summary, text + (last ? ` Ultimo controllo ${fmtRelative(last)}.` : ''));
    const pl = plan();
    const count = pl.auto.length + (pl.appReady && !pl.appBlocked ? 1 : 0);
    allBtn.disabled = !!runner || count === 0;
    allBtn.replaceChildren(icon('download'), count > 1 ? `Aggiorna tutto (${count})` : 'Aggiorna tutto');
    allBtn.title = count === 0 ? 'Niente da aggiornare in automatico' : '';
    checkBtn.disabled = checking || !!runner;
  }

  async function checkAll() {
    checking = true;
    renderSummary();
    checkBtn.replaceChildren(h('span', { class: 'spinner' }), 'Controllo...');
    for (const r of rows.values()) r.setChecking(true);
    const res = await run(() => api('POST', '/updates/check'));
    checking = false;
    checkBtn.replaceChildren(icon('refresh'), 'Controlla tutto');
    for (const r of rows.values()) r.setChecking(false);
    if (res) toast('success', 'Controllo completato', updatesCount() ? 'Trovati aggiornamenti da installare.' : 'È tutto aggiornato.');
    renderAll();
  }

  // --- SonoPrint ----------------------------------------------------------------------------

  let appKey = '';
  let notesOpen = false;
  function renderApp() {
    const a = store.app || {};
    const blocked = usbPrinting().map((p) => p.config.name);
    const key = JSON.stringify([a.status, a.version, a.percent, a.error, a.notes && a.notes.length, a.transferred, blocked, notesOpen, a.checkedAt]);
    if (key === appKey) return;
    appKey = key;
    clear(appCard);

    const status = (() => {
      switch (a.status) {
        case 'unsupported': return { chip: null, text: 'Gli aggiornamenti automatici funzionano nella versione installata di SonoPrint.' };
        case 'checking': return { chip: h('span', { class: 'chip' }, h('span', { class: 'spinner' }), 'Controllo'), text: 'Cerco una nuova versione su GitHub...' };
        case 'latest': return { chip: h('span', { class: 'chip ok' }, icon('check'), 'Aggiornata'), text: 'Hai l\'ultima versione.' };
        case 'downloading': return { chip: h('span', { class: 'chip accent' }, icon('download'), 'Download'), text: `Scarico la versione ${a.version}.` };
        case 'downloaded': return { chip: h('span', { class: 'chip accent' }, icon('zap'), 'Pronta'), text: `La versione ${a.version} è pronta: si installa riavviando SonoPrint.` };
        case 'available': return { chip: h('span', { class: 'chip accent' }, icon('zap'), 'Nuova versione'), text: `È uscita la versione ${a.version}. La versione portable non si aggiorna da sola: scarica quella nuova.` };
        case 'error': return { chip: h('span', { class: 'chip warn' }, icon('alert'), 'Errore'), text: `Controllo non riuscito: ${a.error}` };
        default: return { chip: null, text: 'Controllo automatico all\'avvio e ogni 6 ore.' };
      }
    })();

    let action = null;
    if (a.status === 'downloaded') {
      action = h('button', { class: 'btn primary', disabled: blocked.length > 0, onclick: (e) => installUpdate(e.currentTarget) }, icon('refresh'), 'Riavvia e aggiorna');
    } else if (a.status === 'available') {
      action = h('button', { class: 'btn primary', onclick: openReleases }, icon('download'), 'Scarica');
    } else if (a.status !== 'unsupported') {
      action = h('button', {
        class: 'btn',
        disabled: ['checking', 'downloading'].includes(a.status),
        onclick: (e) => run(() => api('POST', '/app/update/check'), { button: e.currentTarget }),
      }, icon('refresh'), 'Controlla');
    }

    appCard.append(
      h('div', { class: 'upd-head' },
        h('img', { class: 'upd-logo', src: 'img/icon.svg', alt: '' }),
        h('div', { class: 'upd-main' },
          h('div', { class: 'upd-title' }, h('b', null, 'SonoPrint'), status.chip),
          h('div', { class: 'upd-sub' },
            h('span', null, `Installata ${a.current || '-'}`),
            a.version && a.status !== 'latest' ? h('span', null, `Nuova ${a.version}`) : null,
            a.checkedAt ? h('span', null, `controllato ${fmtRelative(a.checkedAt)}`) : null)),
        action),
      h('div', { class: 'upd-body stack tight' },
        h('div', { class: a.status === 'error' ? 'r-failed' : 'dim', style: { fontSize: '13px' } }, status.text),
        a.status === 'downloading' ? downloadProgress(a) : null,
        a.status === 'downloaded' && blocked.length ? h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, `Stanno stampando via USB: ${blocked.join(', ')}. Riavvia a fine stampa, oppure l'aggiornamento si installa quando chiudi SonoPrint.`)) : null,
        a.notes && a.notes.length ? releaseNotes(a) : null,
        a.releaseUrl ? h('div', null, h('a', { href: a.releaseUrl, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'Tutte le versioni su GitHub')) : null));
  }

  function downloadProgress(a) {
    const bits = [];
    if (a.total) bits.push(`${fmtSize(a.transferred || 0)} di ${fmtSize(a.total)}`);
    if (a.bytesPerSecond) bits.push(`${fmtSize(a.bytesPerSecond)}/s`);
    return h('div', { class: 'stack tight' },
      h('div', { class: 'progress' }, h('div', { style: { width: (a.percent || 0) + '%' } })),
      h('div', { class: 'faint num', style: { fontSize: '12.5px' } }, `${a.percent || 0}%` + (bits.length ? `, ${bits.join(', ')}` : '')));
  }

  function releaseNotes(a) {
    const blocks = a.notes;
    const LIMIT = 8;
    const shown = notesOpen ? blocks : blocks.slice(0, LIMIT);
    const out = h('div', { class: 'notes' }, h('div', { class: 'notes-title' }, `Novità della versione ${a.version}`));
    let ul = null;
    for (const b of shown) {
      if (b.type === 'li') {
        if (!ul) { ul = h('ul'); out.append(ul); }
        ul.append(h('li', null, b.text));
        continue;
      }
      ul = null;
      out.append(b.type === 'h' ? h('h4', null, b.text) : h('p', null, b.text));
    }
    if (blocks.length > LIMIT) {
      out.append(h('button', { class: 'btn sm ghost', onclick: () => { notesOpen = !notesOpen; renderApp(); } }, notesOpen ? 'Mostra meno' : `Mostra tutto (${blocks.length})`));
    }
    return out;
  }

  // --- stampanti ----------------------------------------------------------------------------

  function renderList() {
    const ps = printerList();
    const ids = ps.map((p) => p.id).join(',');
    if (ids !== [...rows.keys()].join(',')) {
      for (const r of rows.values()) r.destroy();
      rows.clear();
      clear(list);
      if (!ps.length) {
        list.append(h('div', { class: 'card' }, h('div', { class: 'card-body dim' }, 'Nessuna stampante ancora: aggiungine una per controllarne il firmware.')));
      }
      for (const p of ps) {
        const r = createRow(p.id);
        rows.set(p.id, r);
        list.append(r.el);
      }
    }
    for (const p of ps) rows.get(p.id).update(p);
  }

  function renderAll() {
    renderApp();
    renderList();
    renderSummary();
    if (runner) renderRunner();
  }

  // --- aggiorna tutto -------------------------------------------------------------------------

  async function updateAll() {
    const pl = plan();
    const skippedPrinting = printerList().filter((p) => p.updates && p.updates.available && p.updates.automatic && printing(p));
    const lines = [];
    for (const p of pl.auto) lines.push(h('li', null, h('b', null, p.config.name), `: ${(p.updates.items || []).join(', ') || 'software'}`));
    if (pl.appReady && !pl.appBlocked) lines.push(h('li', null, h('b', null, `SonoPrint ${store.app.version}`), ': alla fine si riavvia.'));
    const extra = [];
    if (skippedPrinting.length) extra.push(h('p', { class: 'dim' }, `Saltate perché stanno stampando: ${skippedPrinting.map((p) => p.config.name).join(', ')}.`));
    const manual = pl.manual.filter((p) => !skippedPrinting.includes(p));
    if (manual.length) extra.push(h('p', { class: 'dim' }, `Da fare a mano (istruzioni nei dettagli): ${manual.map((p) => p.config.name).join(', ')}.`));
    if (pl.appBlocked) extra.push(h('p', { class: 'dim' }, 'SonoPrint si aggiornerà a fine stampa: ci sono stampe USB in corso.'));
    const ok = await confirmDialog({
      title: 'Aggiornare tutto?',
      message: h('div', { class: 'stack tight' },
        h('p', { style: { margin: 0 } }, 'Uno alla volta, in quest\'ordine:'),
        h('ol', { class: 'confirm-list' }, ...lines),
        ...extra,
        h('p', { class: 'dim', style: { margin: 0 } }, 'Il software delle stampanti può riavviarsi: non avviare stampe finché non ha finito.')),
      confirmLabel: 'Aggiorna tutto',
    });
    if (!ok) return;

    runner = { steps: [] };
    for (const p of pl.auto) runner.steps.push({ id: p.id, label: p.config.name, status: 'wait', message: (p.updates.items || []).join(', ') });
    if (pl.appReady && !pl.appBlocked) runner.steps.push({ id: 'app', label: `SonoPrint ${store.app.version}`, status: 'wait', message: 'Riavvio e installazione' });
    renderAll();

    for (const step of runner.steps) {
      step.status = 'run';
      renderRunner();
      try {
        if (step.id === 'app') {
          if (usbPrinting().length) throw new Error('È partita una stampa USB: SonoPrint si aggiornerà alla chiusura.');
          step.message = 'SonoPrint si chiude e si riapre aggiornato...';
          renderRunner();
          await api('POST', '/app/update/install');
        } else {
          await api('POST', `/printers/${step.id}/firmware/install`, { name: 'full' });
          const t = await waitTask(step.id);
          if (t && t.status === 'error') throw new Error(t.message || 'Aggiornamento non riuscito.');
          step.message = (t && t.message) || 'Aggiornamento completato.';
        }
        step.status = 'done';
      } catch (err) {
        step.status = 'error';
        step.message = err.message || String(err);
      }
      renderRunner();
    }
    runner.finished = true;
    renderAll();
  }

  /** Aspetta la fine dell'operazione di aggiornamento della stampante. */
  function waitTask(id) {
    return new Promise((resolve) => {
      let seenRunning = false;
      const started = Date.now();
      const check = () => {
        const p = store.printers.get(id);
        const t = p && p.task;
        if (t && t.kind === 'firmware' && t.status === 'running') seenRunning = true;
        if (t && t.kind === 'firmware' && t.status !== 'running' && (seenRunning || Date.now() - started > 3000)) return finish(t);
        if (!p) return finish({ status: 'error', message: 'Stampante rimossa.' });
        if (Date.now() - started > TASK_TIMEOUT) return finish({ status: 'error', message: 'L\'aggiornamento sta durando troppo: controlla la stampante.' });
        if (seenRunning && !t) return finish({ status: 'done', message: 'Aggiornamento completato.' });
        return null;
      };
      const off = on('printer', check);
      const timer = setInterval(check, 1000);
      function finish(t) { off(); clearInterval(timer); resolve(t); }
      check();
    });
  }

  function renderRunner() {
    clear(runBox);
    if (!runner) return;
    const done = runner.steps.filter((s) => s.status === 'done').length;
    const failed = runner.steps.filter((s) => s.status === 'error').length;
    const title = runner.finished
      ? (failed ? `Finito con ${failed === 1 ? 'un errore' : failed + ' errori'}` : 'Aggiornamenti completati')
      : `Aggiornamento in corso: ${done + 1} di ${runner.steps.length}`;
    const stepIcon = (s) => s.status === 'run' ? h('span', { class: 'spinner' })
      : s.status === 'done' ? icon('checkCircle', 'sm') : s.status === 'error' ? icon('alert', 'sm') : h('span', { class: 'step-dot' });
    runBox.append(h('section', { class: 'card upd-runner' },
      h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon('download'), title),
        runner.finished ? h('button', { class: 'btn sm ghost', style: { marginLeft: 'auto' }, onclick: () => { runner = null; renderAll(); } }, 'Chiudi') : null),
      h('div', { class: 'card-body' },
        h('ol', { class: 'steps' }, ...runner.steps.map((s) => h('li', { class: 'step s-' + s.status },
          stepIcon(s),
          h('div', { style: { minWidth: 0 } }, h('b', null, s.label), h('div', { class: 'dim' }, s.message || ''))))))));
  }

  // --- avvio ----------------------------------------------------------------------------------

  renderAll();
  offs.push(on('app', () => { renderApp(); renderSummary(); }));
  offs.push(on('printer', (p) => { const r = rows.get(p.id); if (r) r.update(p); renderSummary(); renderApp(); }));
  offs.push(on('printers', renderAll));
  const clock = setInterval(renderSummary, 30000);

  return {
    destroy() {
      offs.forEach((f) => f());
      clearInterval(clock);
      for (const r of rows.values()) r.destroy();
    },
  };
}

// --- riga di una stampante ----------------------------------------------------------------------

function createRow(id) {
  const P = () => store.printers.get(id);
  const el = h('section', { class: 'card upd-row' });
  const head = h('div', { class: 'upd-head' });
  const taskBox = h('div', { class: 'upd-task' });
  const detailBox = h('div', { class: 'upd-detail', hidden: true });
  el.append(head, taskBox, detailBox);
  let key = '';
  let open = false;
  let detail = null;
  let checking = false;

  function update(p) {
    if (!p) return;
    const u = p.updates;
    const t = p.task && p.task.kind === 'firmware' ? p.task : null;
    const k = JSON.stringify([p.config.name, p.config.color, p.state, u, t && [t.status, t.message, Math.round((t.progress || 0) * 100), t.lines && t.lines.length], open, checking, printing(p)]);
    if (k === key) { if (detail && detail.onPrinterUpdate) detail.onPrinterUpdate(p); return; }
    key = k;
    renderHead(p, u);
    renderTask(t);
    if (detail && detail.onPrinterUpdate) detail.onPrinterUpdate(p);
  }

  function status(p, u) {
    if (!hasFirmware(p)) return { chip: h('span', { class: 'chip' }, 'Non gestito'), text: p.type === 'usb' ? 'Stampante virtuale: niente da aggiornare.' : 'Aggiornamenti non gestiti da SonoPrint.' };
    if (!connected(p)) return { chip: h('span', { class: 'chip' }, icon('unplug'), 'Non connessa'), text: u && u.current ? `Ultima versione letta: ${u.current}. Connetti la stampante per ricontrollare.` : 'Connetti la stampante per controllare gli aggiornamenti.' };
    if (checking) return { chip: h('span', { class: 'chip' }, h('span', { class: 'spinner' }), 'Controllo'), text: 'Controllo degli aggiornamenti...' };
    if (!u) return { chip: h('span', { class: 'chip' }, h('span', { class: 'spinner' }), 'In attesa'), text: 'Il controllo parte da solo pochi secondi dopo la connessione.' };
    if (u.error && !u.available) return { chip: h('span', { class: 'chip warn' }, icon('alert'), 'Da controllare'), text: u.error };
    if (u.available) {
      const what = (u.items && u.items.length) ? u.items.join(', ') : u.latest ? `Firmware ${u.latest}` : 'Aggiornamento disponibile';
      return {
        chip: h('span', { class: 'chip accent' }, icon('download'), u.available === 1 ? '1 aggiornamento' : `${u.available} aggiornamenti`),
        text: what + (u.automatic ? '' : '. Da installare a mano: apri i dettagli per le istruzioni.'),
      };
    }
    if (u.advisory) return { chip: h('span', { class: 'chip ok' }, icon('check'), 'Aggiornata'), text: `È uscito Marlin ${u.latest}: usa il firmware preparato per la tua stampante (dettagli).` };
    return { chip: h('span', { class: 'chip ok' }, icon('check'), 'Aggiornata'), text: p.type === 'bambu' ? 'SonoPrint non può sapere quale sia l\'ultimo firmware Bambu Lab: nei dettagli trovi il link al sito e l\'aggiornamento offline.' : 'Nessun aggiornamento.' };
  }

  function renderHead(p, u) {
    const type = PRINTER_TYPES[p.type || 'usb'] || PRINTER_TYPES.usb;
    const s = status(p, u);
    const busy = printing(p);
    const canAuto = u && u.available && u.automatic && connected(p);
    clear(head).append(
      h('span', { class: 'upd-dot', style: { background: p.config.color } }),
      h('div', { class: 'upd-main' },
        h('div', { class: 'upd-title' }, h('a', { href: `#/printer/${p.id}` }, h('b', null, p.config.name)), s.chip),
        h('div', { class: 'upd-sub' },
          h('span', { class: 'upd-type' }, icon(type.icon, 'sm'), type.label),
          u && u.current ? h('span', null, `Installato ${u.current}`) : null,
          u && u.latest && u.available ? h('span', null, `Nuovo ${u.latest}`) : null,
          u && u.checkedAt ? h('span', null, `controllato ${fmtRelative(u.checkedAt)}`) : null),
        h('div', { class: 'upd-text' }, s.text)),
      h('div', { class: 'upd-actions' },
        canAuto ? h('button', { class: 'btn sm primary', disabled: busy, title: busy ? 'Aspetta la fine della stampa' : '', onclick: (e) => installAll(p, e.currentTarget) }, icon('download', 'sm'), 'Aggiorna') : null,
        hasFirmware(p) && connected(p) ? h('button', { class: 'btn sm icon-only ghost', title: 'Controlla di nuovo', 'aria-label': `Controlla di nuovo ${p.config.name}`, disabled: checking, onclick: () => recheck() }, icon('refresh', 'sm')) : null,
        hasFirmware(p) ? h('button', { class: 'btn sm ghost', 'aria-expanded': open ? 'true' : 'false', onclick: () => toggle() }, open ? 'Chiudi' : 'Dettagli', icon(open ? 'up' : 'down', 'sm')) : null));
  }

  function renderTask(t) {
    clear(taskBox);
    taskBox.hidden = !t || open; // nei dettagli c'è già il riquadro completo
    if (!t || open) return;
    const running = t.status === 'running';
    const cls = t.status === 'error' ? 'alert error' : t.status === 'done' ? 'alert success' : 'alert info';
    taskBox.append(...[
      h('div', { class: cls }, running ? h('span', { class: 'spinner' }) : icon(t.status === 'error' ? 'alert' : 'checkCircle', 'sm'),
        h('div', { class: 'grow' }, t.message || 'Aggiornamento in corso...'),
        running ? null : h('button', { class: 'btn sm ghost', onclick: () => run(() => api('POST', `/printers/${id}/task/clear`)) }, 'Chiudi')),
      running ? h('div', { class: 'progress' + (t.progress === null || t.progress === undefined ? ' indeterminate' : '') }, h('div', { style: { width: ((t.progress || 0) * 100).toFixed(1) + '%' } })) : null,
      t.lines && t.lines.length ? h('div', { class: 'task-log' }, t.lines.slice(-8).join('\n')) : null,
    ].filter(Boolean));
  }

  async function installAll(p, button) {
    const u = p.updates;
    const ok = await confirmDialog({
      title: `Aggiornare ${p.config.name}?`,
      message: `Verranno installati: ${(u.items || []).join(', ') || 'gli aggiornamenti disponibili'}. Può durare qualche minuto e il software della stampante può riavviarsi.`,
      confirmLabel: 'Aggiorna',
    });
    if (!ok) return;
    await run(() => api('POST', `/printers/${p.id}/firmware/install`, { name: 'full' }), { button });
  }

  async function recheck() {
    checking = true;
    update(P());
    await run(() => api('GET', `/printers/${id}/firmware?refresh=1`));
    checking = false;
    key = '';
    update(P());
  }

  function toggle() {
    open = !open;
    if (open) {
      detail = createFirmware(id);
      detailBox.replaceChildren(detail.el);
    } else {
      if (detail && detail.destroy) detail.destroy();
      detail = null;
      clear(detailBox);
    }
    detailBox.hidden = !open;
    key = '';
    update(P());
  }

  return {
    el,
    update,
    setChecking(v) { checking = v; key = ''; update(P()); },
    destroy() { if (detail && detail.destroy) detail.destroy(); },
  };
}
