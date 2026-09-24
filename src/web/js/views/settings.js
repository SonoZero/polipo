// Impostazioni generali dell'app.

import { h, icon, clear } from '../util.js';
import { api, store } from '../api.js';
import { run } from '../ui.js';
import { check } from './printer-form.js';
import { applyTheme, getThemePref } from '../theme.js';
import { createUpdateSettings } from '../updates.js';
import { createPortSettings, createRemoteSettings } from '../network.js';

export function mountSettings(container) {
  const s = JSON.parse(JSON.stringify(store.settings));
  const updates = createUpdateSettings();
  const portSettings = createPortSettings();
  const remoteSettings = createRemoteSettings();
  const presetsBox = h('div', { class: 'stack', style: { gap: '8px' } });

  function renderPresets() {
    clear(presetsBox);
    presetsBox.appendChild(h('div', { class: 'row faint', style: { fontSize: '12px', fontWeight: 600 } },
      h('span', { style: { width: '160px' } }, 'MATERIALE'), h('span', { style: { width: '110px' } }, 'UGELLO °C'), h('span', { style: { width: '110px' } }, 'PIATTO °C')));
    s.presets.forEach((pr, i) => {
      presetsBox.appendChild(h('div', { class: 'row' },
        h('input', { class: 'input', style: { width: '160px' }, value: pr.name, oninput: (e) => { pr.name = e.target.value; } }),
        h('input', { class: 'input num', type: 'number', style: { width: '110px' }, value: String(pr.hotend), oninput: (e) => { pr.hotend = Number(e.target.value); } }),
        h('input', { class: 'input num', type: 'number', style: { width: '110px' }, value: String(pr.bed), oninput: (e) => { pr.bed = Number(e.target.value); } }),
        h('button', { class: 'btn ghost icon-only', title: 'Rimuovi', onclick: () => { s.presets.splice(i, 1); renderPresets(); } }, icon('trash', 'sm'))));
    });
    presetsBox.appendChild(h('div', null,
      h('button', { class: 'btn sm', onclick: () => { s.presets.push({ name: 'Nuovo', hotend: 210, bed: 60 }); renderPresets(); } }, icon('plus', 'sm'), 'Aggiungi materiale')));
  }
  renderPresets();

  const themeSeg = h('div', { class: 'seg' });
  const renderTheme = () => {
    clear(themeSeg);
    for (const [v, label, ic] of [['dark', 'Scuro', 'moon'], ['light', 'Chiaro', 'sun'], ['system', 'Sistema', 'settings']]) {
      themeSeg.appendChild(h('button', { class: getThemePref() === v ? 'active' : '', onclick: () => { applyTheme(v); renderTheme(); } }, icon(ic, 'sm'), ' ', label));
    }
  };
  renderTheme();

  const notifHint = h('div', { class: 'hint' });
  const isElectron = navigator.userAgent.includes('Electron');

  container.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, 'Impostazioni'),
        h('div', { class: 'page-sub' }, 'Preferenze generali di Polipo. Le impostazioni di ogni stampante sono nella sua pagina.'))),
    h('div', { class: 'settings-form stack' },
      card('Aspetto', h('div', { class: 'field' }, h('label', null, 'Tema'), themeSeg)),
      card('Materiali per il preriscaldamento', presetsBox),
      card('Notifiche e risparmio energetico',
        check('Notifiche di Windows quando una stampa finisce o si interrompe', s.notifications, (v) => {
          s.notifications = v;
          if (v && !isElectron && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        }),
        notifHint,
        check('Impedisci a Windows di andare in sospensione durante la stampa', s.preventSleep, (v) => { s.preventSleep = v; }),
        h('div', { class: 'hint faint', style: { fontSize: '12px' } }, 'Importante: le stampe vengono inviate dal PC riga per riga. Se il PC va in sospensione o chiudi Polipo, la stampa si ferma.')),
      h('div', null, h('button', {
        class: 'btn primary',
        onclick: (e) => run(() => api('PUT', '/settings', { presets: s.presets, notifications: s.notifications, preventSleep: s.preventSleep }), { button: e.currentTarget, success: 'Impostazioni salvate' }),
      }, icon('check'), 'Salva impostazioni')),
      card('Rete', portSettings.el),
      card('Accesso dal telefono', remoteSettings.el),
      card('Aggiornamenti', updates.el),
      card('Informazioni',
        h('div', { class: 'row' },
          h('img', { src: 'img/icon.svg', alt: '', style: { width: '44px', height: '44px' } }),
          h('div', null,
            h('div', { style: { fontWeight: 700 } }, `Polipo ${store.app.current || ''}`),
            h('div', { class: 'dim', style: { fontSize: '13px' } }, 'Controllo di più stampanti 3D via USB, ispirato a OctoPrint. Compatibile con firmware Marlin, Prusa, RepRap e derivati.'),
            h('div', { class: 'made-by', style: { marginTop: '6px' } }, 'made by ', h('b', null, 'zonozero')))))));

  if (!isElectron && 'Notification' in window && Notification.permission === 'denied') {
    notifHint.textContent = 'Le notifiche sono bloccate dal browser.';
  }

  return { destroy() { updates.destroy(); portSettings.destroy(); remoteSettings.destroy(); } };
}

function card(title, ...children) {
  return h('div', { class: 'card settings-section' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, title)),
    h('div', { class: 'card-body stack' }, ...children));
}
