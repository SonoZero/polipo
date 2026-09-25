// Finestra mostrata all'avvio quando la chiusura precedente di SonoPrint ha fermato stampe USB.

import { h, icon, fmtPct, fmtDate } from '../util.js';
import { api, store } from '../api.js';
import { openModal } from '../ui.js';

const WHY = {
  logoff: 'Windows ha chiuso la sessione mentre SonoPrint stampava. Succede quando si esce dall\'account, anche dal Desktop remoto: uscendo, Windows chiude tutti i programmi, compreso SonoPrint.',
  shutdown: 'Il computer si è spento o riavviato mentre SonoPrint stampava.',
  crash: 'SonoPrint si è chiuso all\'improvviso mentre stampava: può essere un blocco del programma o del computer, oppure è mancata la corrente.',
};

const TIP = {
  logoff: 'Per lasciare una stampa in corso dal Desktop remoto chiudi la finestra del Desktop remoto con la X: la sessione resta aperta e SonoPrint continua a stampare. Non scegliere Esci dal menu Start. Da questa versione, se qualcuno prova a uscire dall\'account mentre SonoPrint stampa, Windows lo avvisa prima.',
  shutdown: 'Prima di spegnere o riavviare aspetta la fine della stampa. Da questa versione Windows avvisa prima di spegnere se SonoPrint sta stampando.',
  crash: 'Se succede di nuovo, il registro di SonoPrint aiuta a capire il perché: lo apri da Impostazioni, Informazioni, Registro.',
};

let open = false;

/** Mostra le stampe interrotte (una volta: chiudendo la finestra non ricompare). */
export function showInterruptedPrints() {
  const list = store.interrupted || [];
  if (open || !list.length) return;
  open = true;
  const cause = WHY[list[0].cause] ? list[0].cause : 'crash';
  const hot = list.some((x) => !x.virtual);

  openModal({
    title: list.length === 1 ? 'Una stampa si è interrotta' : 'Alcune stampe si sono interrotte',
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'stack tight' }, ...list.map((x) => h('div', { class: 'interrupted-item' },
        icon('alert', 'sm'),
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: 600 } }, x.file),
          h('div', { class: 'faint', style: { fontSize: '13px' } },
            `${x.printer}, si è fermata${typeof x.progress === 'number' ? ` al ${fmtPct(x.progress)}` : ''} (${fmtDate(x.finishedAt)})`))))),
      h('p', { style: { margin: 0 } }, WHY[cause]),
      hot ? h('div', { class: 'alert warn' }, icon('alert', 'sm'),
        h('div', null, 'La stampante potrebbe essere rimasta calda: se non la stai usando, spegni il riscaldamento dalla sua pagina.')) : null,
      h('p', { class: 'dim', style: { margin: 0, fontSize: '13px' } }, TIP[cause])),
    footer: (close) => [h('button', { class: 'btn primary', onclick: () => close() }, 'Ho capito')],
    onClose: () => {
      open = false;
      api('POST', '/interrupted/dismiss').catch(() => {});
    },
  });
}
