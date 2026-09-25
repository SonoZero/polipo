// Impostazioni generali dell'app.

import { h, icon, clear } from '../util.js';
import { api, store, on, logout } from '../api.js';
import { run, toast } from '../ui.js';
import { check, toggle } from './printer-form.js';
import { applyTheme, getThemePref } from '../theme.js';
import { createUpdateSettings } from '../updates.js';
import { createPortSettings, createRemoteSettings, createLanSettings } from '../network.js';

const TAPS_FOR_DEVELOPER = 7;

export function mountSettings(container) {
  const s = JSON.parse(JSON.stringify(store.settings));
  const updates = createUpdateSettings();
  const portSettings = createPortSettings();
  // aperto dal browser di un altro dispositivo: niente sezioni riservate a questo computer
  const local = store.access !== 'lan';
  const lanSettings = local ? createLanSettings() : null;
  let remoteSettings = null;
  const offs = [];
  const presetsBox = h('div', { class: 'stack tight' });

  function renderPresets() {
    clear(presetsBox);
    presetsBox.appendChild(h('div', { class: 'row faint', style: { fontSize: '12px', fontWeight: 550 } },
      h('span', { style: { width: '160px' } }, 'Materiale'), h('span', { style: { width: '110px' } }, 'Ugello °C'), h('span', { style: { width: '110px' } }, 'Piatto °C')));
    s.presets.forEach((pr, i) => {
      presetsBox.appendChild(h('div', { class: 'row' },
        h('input', { class: 'input', style: { width: '160px' }, value: pr.name, 'aria-label': 'Materiale', oninput: (e) => { pr.name = e.target.value; } }),
        h('input', { class: 'input num', type: 'number', style: { width: '110px' }, value: String(pr.hotend), 'aria-label': 'Temperatura ugello', oninput: (e) => { pr.hotend = Number(e.target.value); } }),
        h('input', { class: 'input num', type: 'number', style: { width: '110px' }, value: String(pr.bed), 'aria-label': 'Temperatura piatto', oninput: (e) => { pr.bed = Number(e.target.value); } }),
        h('button', { class: 'btn ghost icon-only', title: 'Rimuovi', 'aria-label': 'Rimuovi materiale', onclick: () => { s.presets.splice(i, 1); renderPresets(); } }, icon('trash', 'sm'))));
    });
    presetsBox.appendChild(h('div', null,
      h('button', { class: 'btn sm', onclick: () => { s.presets.push({ name: 'Nuovo', hotend: 210, bed: 60 }); renderPresets(); } }, icon('plus', 'sm'), 'Aggiungi materiale')));
  }
  renderPresets();

  const themeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Tema' });
  const renderTheme = () => {
    clear(themeSeg);
    for (const [v, label, ic] of [['dark', 'Scuro', 'moon'], ['light', 'Chiaro', 'sun'], ['system', 'Come il sistema', 'monitor']]) {
      themeSeg.appendChild(h('button', { class: getThemePref() === v ? 'active' : '', onclick: () => { applyTheme(v); renderTheme(); } }, icon(ic, 'sm'), ' ', label));
    }
  };
  renderTheme();

  // app desktop: avvio con il computer e background (le applica il processo principale)
  const startupBox = h('div', { class: 'stack' });
  function renderStartup() {
    clear(startupBox);
    const d = store.desktop;
    if (!d) return;
    const st = store.settings;
    const save = async (patch, message) => {
      if (!await run(() => api('PUT', '/settings', patch), { success: message })) renderStartup();
    };
    startupBox.append(...[
      d.loginItem
        ? toggle('Avvia SonoPrint quando accendi il computer', st.startAtLogin, (v) => save({ startAtLogin: v },
          v ? 'SonoPrint partirà con il computer' : 'SonoPrint non partirà più con il computer'))
        : h('div', { class: 'dim' }, 'L\'avvio con il computer si imposta dalla versione installata di SonoPrint.'),
      d.loginItem ? h('div', { class: 'hint' }, d.tray
        ? 'Parte nascosto, in background: lo trovi fra le icone accanto all\'orologio. Le stampanti con la connessione automatica si collegano da sole.'
        : 'Parte con il computer e resta nel Dock. Le stampanti con la connessione automatica si collegano da sole.') : null,
      st.startAtLogin && d.loginBlocked
        ? h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, d.tray
          ? 'L\'avvio di SonoPrint è disattivato in Gestione attività di Windows. Per riattivarlo spegni e riaccendi qui l\'interruttore.'
          : 'macOS deve approvare l\'avvio di SonoPrint: apri Impostazioni di Sistema, Generali, Elementi login, e consenti SonoPrint.'))
        : null,
      d.tray ? toggle('Resta attivo in background quando chiudi la finestra', st.runInBackground, (v) => save({ runInBackground: v },
        v ? 'SonoPrint resterà attivo in background' : 'Chiudendo la finestra SonoPrint si chiuderà')) : null,
      d.tray ? h('div', { class: 'hint' }, 'Chiudendo la finestra SonoPrint continua a stampare con le stampanti USB e resta raggiungibile dalla rete. Per chiuderlo del tutto fai clic con il tasto destro sull\'icona accanto all\'orologio e scegli Esci.') : null,
    ].filter(Boolean));
  }
  renderStartup();

  const isElectron = navigator.userAgent.includes('Electron');
  const notifHint = h('div', { class: 'hint' });
  if (!isElectron && 'Notification' in window && Notification.permission === 'denied') notifHint.textContent = 'Le notifiche sono bloccate dal browser.';

  // modalità sviluppatore: si attiva toccando 7 volte il numero di versione
  const devSlot = h('div', { class: 'stack' });
  const devRow = h('div');
  function renderDeveloper() {
    const dev = !!store.settings.developer;
    if (remoteSettings) { remoteSettings.destroy(); remoteSettings = null; }
    clear(devSlot);
    clear(devRow);
    if (!dev) return;
    remoteSettings = createRemoteSettings();
    devSlot.append(card('Accesso dal telefono', remoteSettings.el));
    devRow.append(h('div', { class: 'row', style: { marginTop: '10px' } },
      toggle('Modalità sviluppatore', true, async (v) => {
        if (v) return;
        const r = await run(() => api('PUT', '/settings', { developer: false }));
        if (r) toast('info', 'Modalità sviluppatore disattivata', 'Anche l\'accesso dal telefono è stato spento.');
      })));
  }
  let taps = 0;
  let tapTimer = null;
  const version = h('div', { class: 'version-tap', style: { fontWeight: 650 }, onclick: async () => {
    if (store.settings.developer) return;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 1500);
    taps++;
    const left = TAPS_FOR_DEVELOPER - taps;
    if (left > 0 && left <= 3) toast('info', `Ancora ${left} ${left === 1 ? 'tocco' : 'tocchi'}`, 'per attivare la modalità sviluppatore.', 1200);
    if (left === 0) {
      taps = 0;
      const r = await run(() => api('PUT', '/settings', { developer: true }));
      if (r) toast('success', 'Modalità sviluppatore attiva', 'In questa pagina compare l\'accesso dal telefono.');
    }
  } }, `SonoPrint ${store.app.current || ''}`);

  container.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, 'Impostazioni'),
        h('div', { class: 'page-sub' }, 'Preferenze generali di SonoPrint. Quelle di ogni stampante sono nella sua pagina.'))),
    h('div', { class: 'settings-form stack' },
      card('Aspetto', h('div', { class: 'field' }, h('label', null, 'Tema'), themeSeg)),
      card('Materiali per il preriscaldamento', presetsBox),
      card('Notifiche e risparmio energetico',
        check('Notifiche del sistema quando una stampa finisce o si interrompe', s.notifications, (v) => {
          s.notifications = v;
          if (v && !isElectron && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        }),
        notifHint,
        check('Impedisci al computer di andare in sospensione mentre stampa una stampante USB', s.preventSleep, (v) => { s.preventSleep = v; }),
        h('div', { class: 'hint' }, 'Le stampanti USB ricevono la stampa dal computer riga per riga: se il computer va in sospensione o chiudi SonoPrint, la stampa si ferma. Le stampanti in rete continuano da sole.')),
      h('div', null, h('button', {
        class: 'btn primary',
        onclick: (e) => run(() => api('PUT', '/settings', { presets: s.presets, notifications: s.notifications, preventSleep: s.preventSleep }), { button: e.currentTarget, success: 'Impostazioni salvate' }),
      }, icon('check'), 'Salva impostazioni')),
      local && store.desktop ? card('Avvio e background', startupBox) : null,
      local ? card('Rete', portSettings.el) : null,
      local ? card('Accesso dalla rete', lanSettings.el) : card('Accesso dalla rete',
        h('div', { class: 'dim' }, 'Sei collegato a SonoPrint dalla rete, con la password. Porta, firmware da file e aggiornamento di SonoPrint si gestiscono dal computer su cui gira.'),
        h('div', null, h('button', { class: 'btn', onclick: () => logout() }, icon('unplug'), 'Esci'))),
      local ? devSlot : null,
      local ? card('Aggiornamenti', updates.el, h('div', null, h('a', { class: 'btn sm', href: '#/updates' }, icon('download', 'sm'), 'Centro aggiornamenti: app e stampanti'))) : null,
      card('Informazioni',
        h('div', { class: 'row', style: { alignItems: 'flex-start' } },
          h('img', { src: 'img/icon.svg', alt: '', style: { width: '48px', height: '48px', borderRadius: '12px' } }),
          h('div', null,
            version,
            h('div', { class: 'dim', style: { fontSize: '13px', maxWidth: '62ch' } }, 'Controlla più stampanti 3D insieme: via USB (Marlin, Prusa, RepRap) e in rete (Bambu Lab, Klipper, PrusaLink, OctoPrint).'),
            h('div', { class: 'made-by', style: { textAlign: 'left', marginTop: '8px' } }, 'made by ', h('b', null, 'sonozero')),
            local && store.desktop && store.desktop.logs
              ? h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: (e) => run(() => api('POST', '/app/logs'), { button: e.currentTarget }) }, icon('file', 'sm'), 'Registro'))
              : null,
            devRow)))));

  renderDeveloper();
  offs.push(on('settings', () => {
    const was = !!remoteSettings;
    if (was !== !!store.settings.developer) renderDeveloper();
    renderStartup();
  }));

  return {
    destroy() {
      offs.forEach((f) => f());
      updates.destroy();
      portSettings.destroy();
      if (lanSettings) lanSettings.destroy();
      if (remoteSettings) remoteSettings.destroy();
    },
  };
}

function card(title, ...children) {
  return h('section', { class: 'card settings-section' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title)),
    h('div', { class: 'card-body stack' }, ...children));
}
