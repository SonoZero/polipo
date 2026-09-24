// Cronologia delle stampe con qualche statistica.

import { h, icon, clear, setText, fmtDuration, fmtDate } from '../util.js';
import { api, store, on } from '../api.js';
import { run, confirmDialog } from '../ui.js';

const RESULT = { done: 'Completata', cancelled: 'Annullata', failed: 'Interrotta' };

export function mountHistory(container) {
  let filter = '';
  const statRefs = {};
  const stat = (key, label, ic) => h('div', { class: 'card stat' },
    h('div', { class: 'row', style: { justifyContent: 'space-between' } }, statRefs[key] = h('div', { class: 'v' }), icon(ic, 'lg faint')),
    h('div', { class: 'l' }, label));
  const printerSel = h('select', { class: 'select', style: { width: '200px' }, onchange: (e) => { filter = e.target.value; render(); } });
  const tableWrap = h('div', { class: 'card', style: { overflow: 'auto' } });

  container.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, 'Cronologia'),
        h('div', { class: 'page-sub' }, 'Le ultime stampe di tutte le stampanti.')),
      printerSel,
      h('button', {
        class: 'btn ghost',
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Svuotare la cronologia?', message: 'Tutte le voci della cronologia verranno cancellate.', confirmLabel: 'Svuota', danger: true });
          if (ok) run(() => api('DELETE', '/history'));
        },
      }, icon('trash'), 'Svuota')),
    h('div', { class: 'dash-stats' },
      stat('count', 'stampe totali', 'printer'),
      stat('rate', 'percentuale di successo', 'check'),
      stat('time', 'tempo totale di stampa', 'clock'),
      stat('failed', 'stampe interrotte', 'alert')),
    tableWrap);

  function render() {
    const names = [...new Set(store.history.map((x) => x.printer))];
    clear(printerSel).appendChild(h('option', { value: '' }, 'Tutte le stampanti'));
    for (const n of names) printerSel.appendChild(h('option', { value: n }, n));
    printerSel.value = names.includes(filter) ? filter : '';

    const rows = store.history.filter((x) => !filter || x.printer === filter);
    const done = rows.filter((x) => x.result === 'done').length;
    const finished = rows.filter((x) => x.result !== 'cancelled').length;
    setText(statRefs.count, String(rows.length));
    setText(statRefs.rate, finished ? Math.round((done / finished) * 100) + '%' : '—');
    setText(statRefs.time, fmtDuration(rows.reduce((s, x) => s + (x.duration || 0), 0), { short: true }));
    setText(statRefs.failed, String(rows.filter((x) => x.result === 'failed').length));

    clear(tableWrap);
    if (!rows.length) {
      tableWrap.appendChild(h('div', { class: 'empty' }, icon('history'), h('h3', null, 'Nessuna stampa registrata'), h('p', null, 'Qui compariranno le stampe completate, annullate o interrotte.')));
      return;
    }
    tableWrap.appendChild(h('table', { class: 'table' },
      h('thead', null, h('tr', null, ...['Data', 'Stampante', 'File', 'Durata', 'Esito'].map((t) => h('th', null, t)))),
      h('tbody', null, ...rows.map((x) => h('tr', null,
        h('td', { class: 'num dim' }, fmtDate(x.finishedAt)),
        h('td', null, x.printer),
        h('td', { style: { maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.file }, x.file),
        h('td', { class: 'num' }, fmtDuration(x.duration, { short: true })),
        h('td', { class: 'r-' + x.result, style: { fontWeight: 600 }, title: x.reason || '' }, RESULT[x.result] || x.result, x.reason ? h('span', { class: 'faint', style: { fontWeight: 400 } }, ` · ${x.reason}`) : null))))));
  }

  render();
  const off = on('history', render);
  return { destroy() { off(); } };
}
