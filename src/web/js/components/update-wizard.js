// Wizard dell'aggiornamento di SonoPrint: controllo, download con percentuale, installazione, fatto.
// Se al riavvio la versione non è cambiata lo dice e propone altre strade (installer visibile, download a mano).

import { h, icon, clear, fmtSize, fmtDuration } from '../util.js';
import { api, store, on, printerList } from '../api.js';
import { openModal, run } from '../ui.js';

const STEPS = ['Controllo', 'Download', 'Installazione', 'Fatto'];
let openInstance = null;

const usbPrinting = () => printerList().filter((p) => (p.type || 'usb') === 'usb' && (p.job || ['sending', 'printing', 'pausing', 'paused'].includes(p.state))).map((p) => p.config.name);

/** Apre il wizard (uno solo alla volta). check: avvia subito un controllo. */
export function openUpdateWizard({ check = false } = {}) {
  if (openInstance) { if (check) startCheck(); return; }
  const body = h('div', { class: 'uw' });
  const foot = h('div', { class: 'row', style: { width: '100%' } });
  let key = '';
  let close = null;
  const offs = [];

  function render() {
    const a = store.app || {};
    const printing = usbPrinting();
    const k = JSON.stringify([a.status, a.version, a.percent, a.transferred, a.error, a.installStuck, a.installMode, a.justUpdated, a.installFailed, printing]);
    if (k === key) return;
    key = k;
    const view = describe(a, printing);
    clear(body).append(
      h('div', { class: 'uw-versions' },
        h('img', { src: 'img/icon.svg', alt: '' }),
        h('div', null,
          h('div', { class: 'uw-title' }, view.title),
          h('div', { class: 'uw-sub num' }, view.versions))),
      stepper(view.step, view.stepState),
      view.panel);
    clear(foot).append(...[
      a.hasLog ? h('button', { class: 'btn ghost sm', onclick: () => run(() => api('POST', '/app/update/log')) }, icon('file', 'sm'), 'Registro') : null,
      h('span', { class: 'grow' }),
      ...view.actions,
    ].filter(Boolean));
  }

  function action(label, ic, cls, fn, disabled = false) {
    return h('button', { class: 'btn ' + cls, disabled, onclick: (e) => fn(e.currentTarget) }, ic ? icon(ic) : null, label);
  }
  const closeBtn = (label = 'Chiudi') => action(label, null, '', () => close());
  const install = (mode) => (b) => run(() => api('POST', '/app/update/install', { mode }), { button: b });
  const manual = () => action('Scarica a mano', 'external', '', () => { if (store.app.releaseUrl) window.open(store.app.releaseUrl, '_blank'); });

  function describe(a, printing) {
    const cur = a.current || '-';
    const versions = a.version && a.version !== cur ? `${cur} → ${a.version}` : `Versione ${cur}`;
    const base = { title: 'Aggiornamento', versions };

    if (a.justUpdated) {
      return { ...base, title: 'Aggiornamento riuscito', versions: `${a.justUpdated.from} → ${a.justUpdated.to}`, step: 3, stepState: 'done',
        panel: result('ok', `SonoPrint è aggiornato alla versione ${a.justUpdated.to}.`, h('a', { href: a.releaseUrl || '#', target: '_blank', rel: 'noopener' }, 'Cosa c\'è di nuovo')),
        actions: [closeBtn('Fatto')] };
    }
    if (a.installFailed && a.status !== 'installing') {
      const ready = a.status === 'downloaded';
      return { ...base, title: 'Aggiornamento non installato', versions: `${a.installFailed.from} → ${a.installFailed.to}`, step: 2, stepState: 'error',
        panel: h('div', { class: 'stack tight' },
          result('error', `L'aggiornamento alla versione ${a.installFailed.to} non è stato installato: SonoPrint si è chiuso ma è ripartito con la versione ${a.installFailed.from}.`),
          h('p', { class: 'dim uw-p' }, ready
            ? 'Puoi riprovare, oppure usare la finestra dell\'installer: mostra la sua barra di avanzamento e gli eventuali errori.'
            : 'Sto preparando di nuovo l\'aggiornamento scaricato...'),
          printing.length ? printingAlert(printing) : null),
        actions: [manual(),
          action('Usa l\'installer', 'upload', '', install('visible'), !ready),
          action('Riprova', 'refresh', 'primary', install('silent'), !ready)] };
    }

    switch (a.status) {
      case 'unsupported':
        return { ...base, step: 0, stepState: 'idle', panel: result('info', 'Gli aggiornamenti automatici funzionano nella versione installata di SonoPrint.'), actions: [closeBtn()] };
      case 'idle':
      case 'checking':
        return { ...base, title: 'Controllo', step: 0, stepState: 'run', panel: h('div', { class: 'uw-center' }, h('span', { class: 'spinner' }), h('span', null, 'Cerco la nuova versione su GitHub...')), actions: [closeBtn()] };
      case 'latest':
        return { ...base, title: 'Nessun aggiornamento', step: 0, stepState: 'done', panel: result('ok', `Hai già l'ultima versione (${cur}).`), actions: [closeBtn()] };
      case 'available':
        return { ...base, title: 'Nuova versione', step: 1, stepState: 'idle',
          panel: result('info', `È uscita la versione ${a.version}. La versione portable non si aggiorna da sola: scarica quella nuova e sostituisci il file.`),
          actions: [closeBtn('Più tardi'), action('Scarica', 'download', 'primary', () => window.open(a.releaseUrl, '_blank'))] };
      case 'downloading':
        return { ...base, title: 'Download', step: 1, stepState: 'run', panel: progressPanel(a), actions: [closeBtn('Continua in background')] };
      case 'downloaded':
        return { ...base, title: 'Pronta da installare', step: 2, stepState: 'idle',
          panel: h('div', { class: 'stack tight' },
            result('ok', `La versione ${a.version} è scaricata e pronta.`),
            h('p', { class: 'dim uw-p' }, 'Installa e riavvia: SonoPrint si chiude, installa la nuova versione e si riapre da solo. Ci vuole meno di un minuto e le stampanti in rete continuano a stampare.'),
            a.error ? h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, a.error)) : null,
            printing.length ? printingAlert(printing) : null),
          actions: [closeBtn('Più tardi'), action('Installa e riavvia', 'refresh', 'primary', install('silent'), printing.length > 0)] };
      case 'installing':
        if (a.installStuck) {
          return { ...base, title: 'Installazione non partita', step: 2, stepState: 'error',
            panel: h('div', { class: 'stack tight' },
              result('error', 'SonoPrint è ancora aperto: l\'installazione non è partita.'),
              h('p', { class: 'dim uw-p' }, 'Prova con la finestra dell\'installer: mostra la barra di avanzamento e chiude SonoPrint da sola. In alternativa scarica l\'installer e aprilo a mano.')),
            actions: [manual(), action('Usa l\'installer', 'upload', 'primary', install('visible'))] };
        }
        return { ...base, title: 'Installazione', step: 2, stepState: 'run',
          panel: h('div', { class: 'stack tight' },
            h('div', { class: 'uw-center' }, h('span', { class: 'spinner' }), h('span', null, a.installMode === 'visible' ? 'Si apre la finestra dell\'installer...' : `Installo la versione ${a.version}...`)),
            h('p', { class: 'dim uw-p' }, a.installMode === 'visible'
              ? 'Segui la finestra dell\'installer: alla fine SonoPrint si riapre.'
              : 'SonoPrint si chiude tra un attimo e si riapre da solo con la nuova versione.')),
          actions: [] };
      case 'error':
        return { ...base, title: 'Qualcosa non ha funzionato', step: a.version ? 1 : 0, stepState: 'error', panel: result('error', a.error || 'Qualcosa non ha funzionato.'),
          actions: [closeBtn(), manual(), action('Riprova', 'refresh', 'primary', () => startCheck())] };
      default:
        return { ...base, step: 0, stepState: 'idle', panel: h('div'), actions: [closeBtn()] };
    }
  }

  close = openModal({
    title: 'Aggiornamento di SonoPrint',
    body,
    footer: foot,
    onClose: () => {
      offs.forEach((fn) => fn());
      openInstance = null;
      const a = store.app || {};
      if (a.justUpdated || (a.installFailed && a.status !== 'installing')) api('POST', '/app/update/dismiss').catch(() => {});
    },
  });
  offs.push(on('app', render), on('printer', render));
  openInstance = { close };
  render();
  if (check) startCheck();
}

function startCheck() {
  const a = store.app || {};
  if (['checking', 'downloading', 'downloaded', 'installing', 'unsupported'].includes(a.status)) return;
  api('POST', '/app/update/check').catch(() => {});
}

function stepper(current, state) {
  return h('ol', { class: 'uw-steps' }, ...STEPS.map((label, i) => {
    let cls = 'todo';
    if (i < current) cls = 'done';
    else if (i === current) cls = state === 'done' ? 'done' : state === 'error' ? 'error' : state === 'run' ? 'run' : 'now';
    const mark = cls === 'done' ? icon('check', 'sm') : cls === 'error' ? icon('alert', 'sm') : cls === 'run' ? h('span', { class: 'spinner' }) : h('span', null, String(i + 1));
    return h('li', { class: 'uw-step ' + cls, 'aria-current': i === current ? 'step' : null }, h('span', { class: 'uw-dot' }, mark), h('span', { class: 'uw-label' }, label));
  }));
}

function progressPanel(a) {
  const pct = Math.max(0, Math.min(100, a.percent || 0));
  const bits = [];
  if (a.total) bits.push(`${fmtSize(a.transferred || 0)} di ${fmtSize(a.total)}`);
  if (a.bytesPerSecond) bits.push(`${fmtSize(a.bytesPerSecond)}/s`);
  if (a.total && a.bytesPerSecond && a.transferred < a.total) bits.push(`manca circa ${fmtDuration(Math.ceil((a.total - a.transferred) / a.bytesPerSecond), { short: true })}`);
  return h('div', { class: 'uw-progress' },
    h('div', { class: 'uw-pct num', 'aria-live': 'polite' }, `${pct}`, h('small', null, '%')),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Download dell\'aggiornamento' }, h('div', { style: { width: pct + '%' } })),
    h('div', { class: 'faint num uw-meta' }, bits.join(', ') || 'Avvio del download...'),
    h('p', { class: 'dim uw-p' }, 'Puoi chiudere questa finestra: il download continua in background e ti avviso quando è pronto.'));
}

function result(kind, text, extra) {
  const ic = kind === 'ok' ? 'checkCircle' : kind === 'error' ? 'alert' : 'info';
  return h('div', { class: 'uw-result ' + kind }, icon(ic), h('div', null, h('div', null, text), extra ? h('div', { style: { marginTop: '4px' } }, extra) : null));
}

function printingAlert(names) {
  return h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, `Stanno stampando via USB: ${names.join(', ')}. Installa a fine stampa: chiudendo SonoPrint quelle stampe si fermerebbero.`));
}
