// Interfaccia degli aggiornamenti: avviso nella barra laterale e scheda nelle Impostazioni.

import { h, icon, clear, fmtRelative } from './util.js';
import { api, store, on, printerList } from './api.js';
import { run, toast } from './ui.js';

function activePrints() {
  return printerList().filter((p) => p.job).map((p) => p.config.name);
}

export function installUpdate(button) {
  const active = activePrints();
  if (active.length) {
    toast('warn', 'Stampa in corso', `Aspetta che finisca la stampa su ${active.join(', ')} prima di aggiornare.`);
    return;
  }
  return run(() => api('POST', '/app/update/install'), { button });
}

export function openReleases() {
  if (store.app.releaseUrl) window.open(store.app.releaseUrl, '_blank');
}

/** Riquadro nella barra laterale, visibile solo quando c'è una nuova versione. */
export function createUpdateBanner() {
  const el = h('div', { class: 'update-banner', hidden: true });
  let lastKey = '';

  function render() {
    const a = store.app;
    const printing = activePrints().length > 0;
    const key = [a.status, a.version, a.percent, printing].join('|');
    if (key === lastKey) return;
    lastKey = key;
    clear(el);
    el.hidden = !['downloading', 'downloaded', 'available'].includes(a.status);
    if (el.hidden) return;
    if (a.status === 'downloading') {
      el.append(
        h('div', { class: 'ub-title' }, icon('download', 'sm'), `Scarico la versione ${a.version}…`),
        h('div', { class: 'progress', style: { height: '5px' } }, h('div', { style: { width: (a.percent || 0) + '%' } })));
    } else if (a.status === 'downloaded') {
      el.append(
        h('div', { class: 'ub-title' }, icon('zap', 'sm'), `Versione ${a.version} pronta`),
        h('div', { class: 'ub-text' }, printing ? 'Si installerà quando chiudi Polipo, oppure riavvia a fine stampa.' : 'Riavvia Polipo per aggiornarlo.'),
        h('button', { class: 'btn primary sm block', disabled: printing, onclick: (e) => installUpdate(e.currentTarget) }, icon('refresh', 'sm'), 'Riavvia e aggiorna'));
    } else {
      el.append(
        h('div', { class: 'ub-title' }, icon('zap', 'sm'), `Nuova versione ${a.version}`),
        h('div', { class: 'ub-text' }, 'La versione portable non si aggiorna da sola: scarica quella nuova.'),
        h('button', { class: 'btn primary sm block', onclick: openReleases }, icon('download', 'sm'), 'Scarica'));
    }
  }

  const offs = [on('app', render), on('printer', render), on('printers', render)];
  render();
  return { el, destroy() { offs.forEach((f) => f()); } };
}

/** Scheda "Aggiornamenti" della pagina Impostazioni. */
export function createUpdateSettings() {
  const body = h('div', { class: 'stack' });

  function statusText(a) {
    switch (a.status) {
      case 'unsupported': return 'Gli aggiornamenti automatici funzionano solo nella versione installata (non avviando da codice sorgente).';
      case 'idle': return 'Controllo automatico all\'avvio e ogni 6 ore.';
      case 'checking': return 'Controllo in corso…';
      case 'latest': return `Hai l'ultima versione.${a.checkedAt ? ' Ultimo controllo: ' + fmtRelative(a.checkedAt) + '.' : ''}`;
      case 'downloading': return `Scarico la versione ${a.version}… ${a.percent || 0}%`;
      case 'downloaded': return `La versione ${a.version} è pronta: verrà installata al riavvio.`;
      case 'available': return `È disponibile la versione ${a.version}.`;
      case 'error': return `Controllo non riuscito: ${a.error}`;
      default: return '';
    }
  }

  function render() {
    const a = store.app;
    clear(body);
    body.append(...[
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: 650 } }, `Versione installata: ${a.current || '—'}`),
          h('div', { class: a.status === 'error' ? 'dim r-failed' : 'dim', style: { fontSize: '13px' } }, statusText(a))),
        a.status === 'downloaded'
          ? h('button', { class: 'btn primary', onclick: (e) => installUpdate(e.currentTarget) }, icon('refresh'), 'Riavvia e aggiorna')
          : a.status === 'available'
            ? h('button', { class: 'btn primary', onclick: openReleases }, icon('download'), 'Scarica')
            : h('button', {
              class: 'btn',
              disabled: a.status === 'unsupported' || a.status === 'checking' || a.status === 'downloading',
              onclick: (e) => run(() => api('POST', '/app/update/check'), { button: e.currentTarget }),
            }, icon('refresh'), 'Controlla ora')),
      a.releaseUrl ? h('div', null, h('a', { href: a.releaseUrl, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'Novità delle versioni su GitHub')) : null,
    ].filter(Boolean));
  }

  const off = on('app', render);
  render();
  return { el: body, destroy: off };
}
