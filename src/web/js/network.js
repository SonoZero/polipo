// Impostazioni di rete: porta dell'interfaccia e accesso dall'app del telefono.

import { h, icon, clear, IS_MAC } from './util.js';
import { api, store, on } from './api.js';
import { run, toast, confirmDialog } from './ui.js';
import { check, toggle } from './views/printer-form.js';

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
      if (port === n.port) return toast('info', 'Nessuna modifica', `SonoPrint usa già la porta ${port}.`);
      const r = await run(() => api('PUT', '/settings', { port }), { button });
      if (!r) return;
      toast('success', 'Porta cambiata', `SonoPrint ora è su http://127.0.0.1:${port}`);
      // nell'app desktop la finestra viene ricaricata dal processo principale
      if (!isElectron) setTimeout(() => { location.href = `http://127.0.0.1:${port}/#/settings`; }, 1000);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    el.append(...[
      h('div', { class: 'field' },
        h('label', null, 'Porta dell\'interfaccia'),
        h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: (e) => apply(e.currentTarget) }, icon('check'), 'Applica')),
        h('div', { class: 'hint' }, `Indirizzo attuale: ${n.url}. Le stampe in corso non vengono interrotte. Porte valide: da 1024 a 65535.`)),
      n.portFallback
        ? h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, `La porta ${n.configuredPort} era già occupata all'avvio, quindi SonoPrint sta usando la ${n.port}. Scegli una porta libera e premi Applica.`))
        : null,
    ].filter(Boolean));
  }

  const offs = [on('network', render), on('settings', render)];
  render();
  return { el, destroy() { offs.forEach((f) => f()); } };
}

/** Accesso dall'app SonoPrint sul telefono, con abbinamento tramite QR code. */
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
      check('Consenti l\'accesso dall\'app SonoPrint sul telefono', enabled, (v) => {
        run(() => api('PUT', '/settings', { remote: { enabled: v } }), { success: v ? 'Accesso dal telefono attivato' : 'Accesso dal telefono disattivato' });
      }),
      h('div', { class: 'hint faint', style: { fontSize: '12px' } },
        'SonoPrint si apre alla rete di casa, protetto da una chiave segreta che conosce solo il tuo telefono. La pagina web e le impostazioni di rete restano accessibili solo da questo computer.'));
    if (!enabled) { pairing = null; return; }
    if (!pairing) { loadPairing(); el.append(h('div', { class: 'dim' }, 'Preparo il codice di abbinamento…')); return; }

    const qr = h('div', { class: 'qr-box', html: pairing.qrSvg });
    const addresses = pairing.addresses.length
      ? pairing.addresses.map((a) => h('div', { class: 'row', style: { gap: '8px' } },
        h('span', { class: 'badge plain' }, { tailscale: 'Tailscale', vpn: 'VPN' }[a.kind] || 'Rete di casa'),
        h('span', { class: 'mono' }, `${a.address}:${pairing.port}`),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, a.name)))
      : [h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, 'Questo computer non sembra collegato a una rete: collegalo al Wi-Fi o via cavo.'))];

    el.append(h('div', { class: 'pair-grid' },
      h('div', { class: 'stack', style: { alignItems: 'center', gap: '8px' } }, qr,
        h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Inquadralo con l\'app SonoPrint')),
      h('div', { class: 'stack' },
        h('ol', { class: 'steps-list' },
          h('li', null, 'Apri l\'app ', h('b', null, 'SonoPrint'), ' sul telefono e tocca ', h('b', null, 'Abbina con QR code'), '.'),
          h('li', null, 'Inquadra il codice qui accanto. Telefono e computer devono essere sulla stessa rete Wi-Fi.'),
          IS_MAC
            ? h('li', null, 'Se macOS chiede di permettere a SonoPrint di trovare dispositivi nella rete locale, scegli ', h('b', null, 'Consenti'), '.')
            : h('li', null, 'Se Windows chiede di consentire l\'accesso alla rete a SonoPrint, scegli ', h('b', null, 'Reti private'), '.'),
          h('li', null, 'Fuori casa: installa ', h('a', { href: 'https://tailscale.com/download', target: '_blank', rel: 'noopener' }, 'Tailscale'), ' (gratis) su computer e telefono; poi abbina di nuovo e l\'app userà anche l\'indirizzo Tailscale.')),
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

/**
 * Accesso dai browser degli altri dispositivi della rete (telefono, tablet, altri computer),
 * protetto da una password. Mostra gli indirizzi da aprire, un QR code e lo stato del firewall.
 */
export function createLanSettings() {
  const el = h('div', { class: 'stack' });
  let info = null;
  let loading = false;
  let password = '';

  async function loadInfo() {
    if (loading) return;
    loading = true;
    try { info = await api('GET', '/lan'); } catch (err) { toast('error', 'Accesso dalla rete', err.message); }
    loading = false;
    render();
  }

  async function allowFirewall(button) {
    const r = await run(() => api('POST', '/firewall/allow'), { button });
    if (!r) return;
    info = { ...info, firewall: { ...info.firewall, ...r } };
    toast(r.allowed ? 'success' : 'warn', r.allowed ? 'Firewall a posto' : 'Firewall', r.allowed ? 'SonoPrint è consentito nelle reti private.' : 'La regola non risulta ancora attiva: riprova.');
    render();
  }

  function firewallBlock() {
    const fw = info && info.firewall;
    if (!fw) return null;
    if (!fw.supported) {
      return IS_MAC
        ? h('div', { class: 'hint' }, 'Se il firewall di macOS è attivo, alla prima connessione chiede se consentire le connessioni in entrata a SonoPrint: scegli Consenti.')
        : null;
    }
    if (fw.error) return h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, fw.error));
    const parts = [];
    const allowButton = () => h('button', { class: 'btn sm', onclick: (e) => allowFirewall(e.currentTarget) }, icon('shield', 'sm'), 'Consenti nel firewall');
    if (fw.blocked) {
      parts.push(h('div', { class: 'alert error' }, icon('alert', 'sm'),
        h('div', { class: 'grow' }, 'Il firewall di Windows blocca SonoPrint: gli altri dispositivi non riescono a collegarsi.'), allowButton()));
    } else if (fw.allowed) {
      parts.push(h('div', { class: 'alert success' }, icon('shield', 'sm'), h('div', null, 'Il firewall di Windows consente SonoPrint nelle reti private.')));
    } else {
      parts.push(h('div', { class: 'alert warn' }, icon('alert', 'sm'),
        h('div', { class: 'grow' }, 'Il firewall di Windows non ha ancora un permesso per SonoPrint: gli altri dispositivi potrebbero non riuscire a collegarsi.'), allowButton()));
    }
    if (fw.publicHome && fw.publicHome.length) {
      parts.push(h('div', { class: 'hint' }, `In Windows la rete "${fw.publicHome.join('", "')}" è impostata come pubblica, e SonoPrint è consentito solo nelle reti private. Se è la tua rete di casa, apri Impostazioni di Windows, Rete e Internet, e impostala come privata.`));
    }
    return h('div', { class: 'stack tight' }, ...parts);
  }

  function render() {
    const lan = store.settings.lan || {};
    const enabled = !!lan.enabled;
    clear(el);

    const pwInput = h('input', {
      class: 'input', type: 'password', autocomplete: 'new-password', id: 'lan-password',
      placeholder: lan.hasPassword ? 'Salvata: scrivine una nuova per cambiarla' : 'Almeno 6 caratteri',
      value: password, oninput: (e) => { password = e.target.value; },
    });
    const savePassword = async (button) => {
      if (password.length < 6) { toast('warn', 'Password troppo corta', 'Usa almeno 6 caratteri.'); pwInput.focus(); return; }
      const r = await run(() => api('PUT', '/settings', { lan: { password } }), { button });
      if (!r) return;
      password = '';
      toast('success', 'Password salvata', enabled ? 'Chi era collegato dalla rete deve entrare di nuovo con la password nuova.' : 'Ora puoi aprire SonoPrint alla rete.');
    };

    el.append(
      toggle('Apri SonoPrint agli altri dispositivi della rete', enabled, async (v) => {
        if (v && !lan.hasPassword && password.length < 6) {
          toast('warn', 'Scegli prima una password', 'Serve per entrare dagli altri dispositivi: almeno 6 caratteri.');
          render();
          el.querySelector('#lan-password').focus();
          return;
        }
        const body = { lan: { enabled: v } };
        if (v && password.length >= 6) body.lan.password = password;
        const r = await run(() => api('PUT', '/settings', body), { success: v ? 'Accesso dalla rete attivato' : 'Accesso dalla rete disattivato' });
        if (!r) { render(); return; }
        password = '';
        info = null;
      }),
      h('div', { class: 'hint' }, 'Da telefono, tablet o un altro computer collegato alla stessa rete apri l\'indirizzo nel browser ed entra con la password. Porta, firmware da file e aggiornamento di SonoPrint restano solo su questo computer.'),
      h('div', { class: 'field' },
        h('label', { for: 'lan-password' }, 'Password per entrare dalla rete'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, pwInput),
          h('button', { class: 'btn', onclick: (e) => savePassword(e.currentTarget) }, icon('key'), 'Salva password'))));

    if (!enabled) { info = null; return; }
    if (!info) { loadInfo(); el.append(h('div', { class: 'dim' }, 'Preparo gli indirizzi...')); return; }

    const urls = info.urls || [];
    const labels = { lan: 'Rete di casa', tailscale: 'Tailscale', vpn: 'VPN' };
    const copy = (url) => navigator.clipboard.writeText(url).then(() => toast('success', 'Indirizzo copiato', url), () => {});
    el.append(h('div', { class: 'pair-grid' },
      info.qrSvg
        ? h('div', { class: 'stack', style: { alignItems: 'center', gap: '8px' } },
          h('div', { class: 'qr-box', html: info.qrSvg }),
          h('div', { class: 'faint', style: { fontSize: '12px', textAlign: 'center' } }, 'Inquadralo con la fotocamera del telefono'))
        : h('div'),
      h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', null, 'Indirizzi da aprire nel browser'),
          urls.length
            ? h('div', { class: 'lan-urls' }, ...urls.map((u) => h('div', { class: 'lan-url' },
              h('span', { class: 'badge plain' }, labels[u.kind] || u.kind),
              h('a', { class: 'mono', href: u.url, target: '_blank', rel: 'noopener' }, u.url),
              h('button', { class: 'btn sm ghost icon-only', title: 'Copia', 'aria-label': `Copia ${u.url}`, onclick: () => copy(u.url) }, icon('copy', 'sm')))))
            : h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, 'Nessun indirizzo di rete: controlla che il computer sia collegato al Wi-Fi o via cavo.'))),
        firewallBlock(),
        h('div', null, h('button', { class: 'btn sm ghost', onclick: () => { info = null; render(); } }, icon('refresh', 'sm'), 'Controlla di nuovo')))));
  }

  const offs = [
    on('settings', render),
    on('network', () => { if (info) { info = null; render(); } }),
  ];
  render();
  return { el, destroy() { offs.forEach((f) => f()); } };
}
