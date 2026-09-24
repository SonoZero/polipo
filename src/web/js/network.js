// Impostazioni di rete: porta dell'interfaccia e accesso dall'app del telefono.

import { h, icon, clear } from './util.js';
import { api, store, on } from './api.js';
import { run, toast, confirmDialog } from './ui.js';
import { check } from './views/printer-form.js';

const isElectron = navigator.userAgent.includes('Electron');

/** Porta dell'interfaccia (cambia subito, senza fermare le stampe). */
export function createPortSettings() {
  const el = h('div', { class: 'stack' });

  function render() {
    const n = store.network;
    if (!n) return;
    clear(el);
    const input = h('input', { class: 'input num', type: 'number', min: '1024', max: '65535', value: String(n.configuredPort), style: { width: '130px' } });
    const apply = async (button) => {
      const port = Number(input.value);
      if (port === n.port) return toast('info', 'Nessuna modifica', `Polipo usa già la porta ${port}.`);
      const r = await run(() => api('PUT', '/settings', { port }), { button });
      if (!r) return;
      toast('success', 'Porta cambiata', `Polipo ora è su http://127.0.0.1:${port}`);
      // nell'app desktop la finestra viene ricaricata dal processo principale
      if (!isElectron) setTimeout(() => { location.href = `http://127.0.0.1:${port}/#/settings`; }, 1000);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    el.append(...[
      h('div', { class: 'field' },
        h('label', null, 'Porta dell\'interfaccia'),
        h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: (e) => apply(e.currentTarget) }, icon('check'), 'Applica')),
        h('div', { class: 'hint' }, `Indirizzo attuale: ${n.url} — le stampe in corso non vengono interrotte. Porte valide: da 1024 a 65535.`)),
      n.portFallback
        ? h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, `La porta ${n.configuredPort} era già occupata all'avvio, quindi Polipo sta usando la ${n.port}. Scegli una porta libera e premi Applica.`))
        : null,
    ].filter(Boolean));
  }

  const offs = [on('network', render), on('settings', render)];
  render();
  return { el, destroy() { offs.forEach((f) => f()); } };
}

/** Accesso dall'app Polipo sul telefono, con abbinamento tramite QR code. */
export function createRemoteSettings() {
  const el = h('div', { class: 'stack' });
  let pairing = null;
  let loading = false;
  let showKey = false;

  async function loadPairing() {
    if (loading) return;
    loading = true;
    try { pairing = await api('GET', '/remote'); } catch (err) { toast('error', 'Abbinamento non disponibile', err.message); }
    loading = false;
    render();
  }

  function render() {
    const enabled = !!(store.settings.remote && store.settings.remote.enabled);
    clear(el);
    el.append(
      check('Consenti l\'accesso dall\'app Polipo sul telefono', enabled, (v) => {
        run(() => api('PUT', '/settings', { remote: { enabled: v } }), { success: v ? 'Accesso dal telefono attivato' : 'Accesso dal telefono disattivato' });
      }),
      h('div', { class: 'hint faint', style: { fontSize: '12px' } },
        'Polipo si apre alla rete di casa, protetto da una chiave segreta che conosce solo il tuo telefono. La pagina web e le impostazioni di rete restano accessibili solo da questo PC.'));
    if (!enabled) { pairing = null; return; }
    if (!pairing) { loadPairing(); el.append(h('div', { class: 'dim' }, 'Preparo il codice di abbinamento…')); return; }

    const qr = h('div', { class: 'qr-box', html: pairing.qrSvg });
    const addresses = pairing.addresses.length
      ? pairing.addresses.map((a) => h('div', { class: 'row', style: { gap: '8px' } },
        h('span', { class: 'badge plain' }, { tailscale: 'Tailscale', vpn: 'VPN' }[a.kind] || 'Rete di casa'),
        h('span', { class: 'mono' }, `${a.address}:${pairing.port}`),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, a.name)))
      : [h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, 'Questo PC non sembra collegato a una rete: collegalo al Wi-Fi o via cavo.'))];

    el.append(h('div', { class: 'pair-grid' },
      h('div', { class: 'stack', style: { alignItems: 'center', gap: '8px' } }, qr,
        h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Inquadralo con l\'app Polipo')),
      h('div', { class: 'stack' },
        h('ol', { class: 'steps-list' },
          h('li', null, 'Apri l\'app ', h('b', null, 'Polipo'), ' sul telefono e tocca ', h('b', null, 'Abbina con QR code'), '.'),
          h('li', null, 'Inquadra il codice qui accanto. Telefono e PC devono essere sulla stessa rete Wi-Fi.'),
          h('li', null, 'Se Windows chiede di consentire l\'accesso alla rete a Polipo, scegli ', h('b', null, 'Reti private'), '.'),
          h('li', null, 'Fuori casa: installa ', h('a', { href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener' }, 'Tailscale'), ' (gratis) su PC e telefono; poi abbina di nuovo e l\'app userà anche l\'indirizzo Tailscale.')),
        h('div', { class: 'field' }, h('label', null, `Indirizzi di ${pairing.hostname}`), ...addresses),
        h('div', { class: 'field' },
          h('label', null, 'Chiave di accesso'),
          h('div', { class: 'row' },
            h('span', { class: 'mono grow', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, showKey ? pairing.key : '•'.repeat(24)),
            h('button', { class: 'btn sm', onclick: () => { showKey = !showKey; render(); } }, icon('eye', 'sm'), showKey ? 'Nascondi' : 'Mostra'),
            h('button', {
              class: 'btn sm outline-danger',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: 'Generare una nuova chiave?',
                  message: 'I telefoni già abbinati verranno scollegati e dovrai abbinarli di nuovo con il nuovo QR code. Fallo se pensi che qualcuno abbia visto la chiave.',
                  confirmLabel: 'Genera nuova chiave', danger: true,
                });
                if (!ok) return;
                const r = await run(() => api('POST', '/remote/key'), { success: 'Nuova chiave generata' });
                if (r) { pairing = r; render(); }
              },
            }, icon('refresh', 'sm'), 'Nuova chiave')),
          h('div', { class: 'hint' }, 'Per l\'abbinamento manuale nell\'app: indirizzo, porta e questa chiave.')))));
  }

  const offs = [
    on('settings', render),
    on('network', () => { if (pairing) loadPairing(); }),
  ];
  render();
  return { el, destroy() { offs.forEach((f) => f()); } };
}
