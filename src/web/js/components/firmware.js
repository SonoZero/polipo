// Scheda "Firmware": versione installata e aggiornamento, diverso per ogni tipo di stampante.
// USB: file .hex scritto dalla porta seriale (8 bit) o .bin copiato sulla scheda SD (32 bit).
// Bambu Lab: file offline copiato sulla scheda SD della stampante.
// Klipper e OctoPrint: aggiornamento del software dalla loro interfaccia.
// PrusaLink: controllo della versione e istruzioni.

import { h, icon, clear, fmtDate } from '../util.js';
import { api, store, uploadTo } from '../api.js';
import { run, toast, confirmDialog } from '../ui.js';

export function createFirmware(id) {
  const P = () => store.printers.get(id);
  const taskBox = h('div');
  const content = h('div', { class: 'fw-grid' },
    h('div', { class: 'skeleton', style: { height: '220px', borderRadius: '16px' } }),
    h('div', { class: 'skeleton', style: { height: '220px', borderRadius: '16px' } }));
  const el = h('div', { class: 'stack' }, taskBox, content);
  let info = null;
  let taskKey = '';
  let destroyed = false;

  async function load(refresh) {
    const r = await run(() => api('GET', `/printers/${id}/firmware${refresh ? '?refresh=1' : ''}`));
    if (destroyed) return;
    if (!r) {
      clear(content).append(card('Firmware', 'chip', h('div', { class: 'dim' }, 'Informazioni non disponibili: connetti la stampante e riprova.'),
        h('div', null, h('button', { class: 'btn', onclick: () => load(true) }, icon('refresh'), 'Riprova'))));
      return;
    }
    info = r;
    render();
  }

  function render() {
    clear(content);
    const kind = info.kind;
    if (kind === 'marlin') renderMarlin();
    else if (kind === 'bambu') renderBambu();
    else if (kind === 'klipper' || kind === 'octoprint') renderComponents();
    else if (kind === 'prusalink') renderPrusa();
  }

  const refreshBtn = () => h('button', { class: 'btn sm ghost', onclick: (e) => { e.currentTarget.disabled = true; load(true); } }, icon('refresh', 'sm'), 'Controlla di nuovo');

  // --- stampanti USB (Marlin) -------------------------------------------------------

  function renderMarlin() {
    const fw = info.current;
    const busy = P().isPrinting || ['sending', 'printing', 'pausing', 'paused'].includes(P().state);
    content.append(
      card('Firmware installato', 'chip',
        fw ? h('div', null, h('div', { class: 'fw-version' }, fw.name ? fw.name.split(' (')[0] : 'Sconosciuto'),
          h('dl', { class: 'kv', style: { marginTop: '12px' } },
            h('dt', null, 'Macchina'), h('dd', null, fw.machine || '-'),
            h('dt', null, 'Porta'), h('dd', null, info.port || '-')))
          : h('div', { class: 'dim' }, 'Connetti la stampante per leggere la versione del firmware (comando M115).'),
        info.latest ? h('div', { class: info.updateAvailable ? 'alert info' : 'alert success' }, icon(info.updateAvailable ? 'info' : 'checkCircle', 'sm'),
          h('div', null, info.updateAvailable ? `È uscito Marlin ${info.latest.version}. ` : `Hai già l'ultima versione di Marlin (${info.latest.version}). `,
            info.updateAvailable ? 'Usa però il firmware preparato per la tua stampante: lo trovi sul sito del produttore, oppure compilalo da Marlin con la configurazione della tua scheda.' : null,
            ' ', h('a', { href: info.latest.url, target: '_blank', rel: 'noopener' }, 'Note di rilascio'))) : null,
        h('div', null, refreshBtn())),
      card('Aggiorna il firmware', 'upload',
        h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, 'Durante l\'aggiornamento non spegnere la stampante e non staccare il cavo. Dopo, controlla le impostazioni (passi, PID) e rifai il livellamento.')),
        hexOption(busy),
        binOption(busy)));
  }

  function hexOption(busy) {
    const input = h('input', { type: 'file', accept: '.hex', hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const ok = await confirmDialog({
        title: 'Scrivere il nuovo firmware?',
        message: `SonoPrint scollega la stampante, scrive ${f.name} sulla scheda dalla porta ${info.port} e lo verifica. Ci vogliono uno o due minuti.`,
        confirmLabel: 'Scrivi il firmware',
      });
      if (!ok) return;
      await run(() => uploadTo(`/printers/${id}/firmware/upload?name=${encodeURIComponent(f.name)}`, f));
    } });
    return h('div', { class: 'stack tight' },
      h('div', { style: { fontWeight: 600 } }, 'Schede a 8 bit: file .hex'),
      h('div', { class: 'dim', style: { fontSize: '13px' } }, 'ATmega2560 (Anycubic i3 Mega, RAMPS, Prusa MK3) o ATmega1284P con bootloader. Il file viene scritto dal cavo USB e poi riletto per verificarlo.'),
      h('div', null, input, h('button', { class: 'btn', disabled: busy || !info.canInstall, onclick: () => input.click() }, icon('upload'), 'Scegli il file .hex')));
  }

  function binOption(busy) {
    let drive = info.drives && info.drives[0] ? info.drives[0].drive : '';
    let naming = 'unique';
    const driveSel = h('select', { class: 'select', 'aria-label': 'Scheda SD', onchange: (e) => { drive = e.target.value; } });
    const fillDrives = (list) => {
      clear(driveSel);
      if (!list.length) driveSel.append(h('option', { value: '' }, 'Nessuna scheda SD trovata'));
      for (const d of list) driveSel.append(h('option', { value: d.drive }, `${d.drive} ${d.label}`));
      drive = list[0] ? list[0].drive : '';
      driveSel.value = drive;
    };
    fillDrives(info.drives || []);
    const namingSel = h('select', { class: 'select', 'aria-label': 'Nome del file', onchange: (e) => { naming = e.target.value; } },
      h('option', { value: 'unique' }, 'Nome sempre diverso (Creality 4.2.x e simili)'),
      h('option', { value: 'firmware' }, 'firmware.bin (BTT SKR, MKS e simili)'));
    const input = h('input', { type: 'file', accept: '.bin', hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!drive) return toast('warn', 'Inserisci la scheda SD della stampante nel computer');
      const r = await run(() => uploadTo(`/printers/${id}/firmware/upload?name=${encodeURIComponent(f.name)}&drive=${encodeURIComponent(drive)}&naming=${naming}`, f));
      if (r && r.name) toast('success', 'Firmware copiato', `${r.drive}${r.drive.startsWith('/') ? '/' : '\\'}${r.name}`);
    } });
    return h('div', { class: 'stack tight' },
      h('div', { style: { fontWeight: 600, marginTop: '6px' } }, 'Schede a 32 bit: file .bin sulla scheda SD'),
      h('div', { class: 'dim', style: { fontSize: '13px' } }, 'Inserisci nel computer la scheda SD della stampante: SonoPrint copia il file con il nome giusto. Poi rimetti la scheda nella stampante spenta e accendila.'),
      h('div', { class: 'grid-2' },
        h('div', { class: 'input-group' }, driveSel, h('button', { class: 'btn icon-only', title: 'Cerca schede SD', 'aria-label': 'Cerca schede SD', onclick: async () => fillDrives((await run(() => api('GET', '/drives'))) || []) }, icon('refresh'))),
        namingSel),
      h('div', null, input, h('button', { class: 'btn', disabled: busy, onclick: () => input.click() }, icon('drive'), 'Scegli il file .bin')));
  }

  // --- Bambu Lab ---------------------------------------------------------------------

  function renderBambu() {
    const fw = info.current;
    const input = h('input', { type: 'file', accept: '.zip,.bin,.sig', hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      await run(() => uploadTo(`/printers/${id}/firmware/upload?name=${encodeURIComponent(f.name)}`, f));
    } });
    content.append(
      card('Firmware installato', 'chip',
        fw && fw.version ? h('div', null, h('div', { class: 'fw-version' }, fw.version), h('div', { class: 'dim', style: { fontSize: '13px' } }, info.model || fw.name || 'Bambu Lab'),
          fw.modules && fw.modules.length ? h('dl', { class: 'kv', style: { marginTop: '12px' } },
            ...fw.modules.slice(0, 8).flatMap((m) => [h('dt', null, m.name), h('dd', { class: 'mono' }, m.version)])) : null)
          : h('div', { class: 'dim' }, 'Connetti la stampante per leggere la versione del firmware.'),
        h('div', null, h('a', { class: 'btn sm', href: info.downloadUrl, target: '_blank', rel: 'noopener' }, icon('external', 'sm'), 'Firmware sul sito di Bambu Lab'))),
      card('Aggiornamento offline', 'upload',
        h('ol', { class: 'help-steps' },
          h('li', null, 'Scarica il pacchetto ', h('b', null, 'offline'), ' per il tuo modello dal sito di Bambu Lab. Non rinominarlo e non estrarlo.'),
          h('li', null, 'Sceglilo qui: SonoPrint lo copia sulla scheda microSD della stampante.'),
          h('li', null, 'Sullo schermo della stampante apri ', h('b', null, 'Impostazioni > Firmware'), ' e avvia l\'aggiornamento dalla scheda SD.')),
        h('div', { class: 'hint' }, 'Serve una scheda microSD inserita nella stampante. Per l\'aggiornamento offline le P1 devono avere almeno il firmware 01.07 e le A1 almeno il 01.04.'),
        h('div', null, input, h('button', { class: 'btn primary', disabled: !info.canInstall, onclick: () => input.click() }, icon('upload'), 'Scegli il file del firmware'))));
  }

  // --- Klipper e OctoPrint -------------------------------------------------------------

  function renderComponents() {
    const comps = info.components || [];
    const available = comps.filter((c) => c.available);
    const list = h('div', { class: 'comp-list' });
    for (const c of comps) {
      const detail = c.name === 'system'
        ? (c.updates ? `${c.updates} pacchetti da aggiornare` : 'aggiornato')
        : [c.version || '-', c.available && c.remote ? `nuova: ${c.remote}` : null, c.dirty ? 'modificato a mano' : null].filter(Boolean).join(', ');
      list.append(h('div', { class: 'comp' },
        h('div', { style: { minWidth: 0 } }, h('b', null, c.label), h('div', null, h('span', null, detail))),
        c.available
          ? h('button', { class: 'btn sm', disabled: !info.canInstall || c.possible === false, onclick: (e) => install(c.name, c.label, e.currentTarget) }, icon('download', 'sm'), 'Aggiorna')
          : h('span', { class: 'chip' }, icon('check'), 'Aggiornato')));
    }
    content.append(
      card(info.kind === 'klipper' ? 'Software della stampante' : 'Software di OctoPrint', 'chip',
        info.error ? h('div', { class: 'alert warn' }, icon('alert', 'sm'), h('div', null, info.error)) : null,
        comps.length ? list : (info.error ? null : h('div', { class: 'dim' }, 'Nessun componente da controllare.')),
        h('div', { class: 'row' },
          available.length ? h('button', { class: 'btn primary', disabled: !info.canInstall, onclick: (e) => install('full', 'tutto', e.currentTarget) }, icon('download'), available.length > 1 ? `Aggiorna tutto (${available.length})` : 'Aggiorna') : null,
          refreshBtn())),
      card('Come funziona', 'info',
        h('div', { class: 'dim', style: { fontSize: '13px' } }, info.kind === 'klipper'
          ? 'SonoPrint usa l\'update manager di Moonraker, lo stesso di Mainsail e Fluidd. Durante l\'aggiornamento Klipper può riavviarsi: non avviare stampe finché non ha finito.'
          : 'SonoPrint usa il plugin Software Update di OctoPrint. Alla fine OctoPrint si riavvia e SonoPrint si ricollega da solo.'),
        info.current && info.current.version ? h('dl', { class: 'kv' }, h('dt', null, info.kind === 'klipper' ? 'Klipper' : 'OctoPrint'), h('dd', null, info.current.version)) : null));
  }

  async function install(name, label, button) {
    const ok = await confirmDialog({
      title: name === 'full' ? 'Aggiornare tutto?' : `Aggiornare ${label}?`,
      message: 'L\'aggiornamento può durare qualche minuto e riavviare il software della stampante.',
      confirmLabel: 'Aggiorna',
    });
    if (!ok) return;
    await run(() => api('POST', `/printers/${id}/firmware/install`, { name }), { button });
  }

  // --- PrusaLink ------------------------------------------------------------------------

  function renderPrusa() {
    const fw = info.current;
    content.append(
      card('Firmware installato', 'chip',
        h('div', { class: 'fw-version' }, fw && fw.version ? fw.version : 'Sconosciuto'),
        info.latest ? h('div', { class: info.updateAvailable ? 'alert info' : 'alert success' }, icon(info.updateAvailable ? 'info' : 'checkCircle', 'sm'),
          h('div', null, info.updateAvailable ? `È disponibile il firmware ${info.latest.version}` : `Hai l'ultima versione pubblicata (${info.latest.version})`,
            info.latest.publishedAt ? `, uscito il ${fmtDate(info.latest.publishedAt).split(',')[0]}. ` : '. ',
            h('a', { href: info.latest.url, target: '_blank', rel: 'noopener' }, 'Novità'))) : h('div', { class: 'dim' }, 'Non riesco a controllare l\'ultima versione: serve internet.'),
        h('div', null, refreshBtn())),
      card('Come aggiornare', 'upload',
        h('ol', { class: 'help-steps' },
          h('li', null, 'Scarica il file ', h('b', null, '.bbf'), ' per il tuo modello dalla pagina dei driver di Prusa.'),
          h('li', null, 'Copialo su una chiavetta USB e inseriscila nella stampante.'),
          h('li', null, 'Riavvia la stampante: all\'accensione ti chiede di aggiornare.')),
        h('div', null, h('a', { class: 'btn sm', href: info.downloadUrl, target: '_blank', rel: 'noopener' }, icon('external', 'sm'), 'Driver e firmware Prusa'))));
  }

  // --- operazione in corso ----------------------------------------------------------------

  function renderTask(p) {
    const t = p.task;
    const key = t ? [t.kind, t.status, t.message, t.lines ? t.lines.length : 0, Math.round((t.progress || 0) * 100)].join('|') : '';
    if (key === taskKey) return;
    const wasRunning = taskKey.includes('|running|');
    taskKey = key;
    clear(taskBox);
    if (!t || t.kind !== 'firmware') {
      if (wasRunning) load(false);
      return;
    }
    const cls = t.status === 'error' ? 'alert error' : t.status === 'done' ? 'alert success' : 'alert info';
    const running = t.status === 'running';
    taskBox.append(h('section', { class: 'card' }, h('div', { class: 'card-body stack tight' },
      h('div', { class: cls }, running ? h('span', { class: 'spinner' }) : icon(t.status === 'error' ? 'alert' : 'checkCircle', 'sm'),
        h('div', { class: 'grow' }, t.message || 'Aggiornamento in corso…'),
        running ? null : h('button', { class: 'btn sm ghost', onclick: () => run(() => api('POST', `/printers/${id}/task/clear`)) }, 'Chiudi')),
      running ? h('div', { class: 'progress' + (t.progress === null || t.progress === undefined ? ' indeterminate' : '') }, h('div', { style: { width: ((t.progress || 0) * 100).toFixed(1) + '%' } })) : null,
      t.lines && t.lines.length ? h('div', { class: 'task-log' }, t.lines.slice(-60).join('\n')) : null)));
    if (!running && wasRunning) load(false);
  }

  load(false);
  renderTask(P());

  return {
    el,
    onPrinterUpdate(p) { renderTask(p); },
    destroy() { destroyed = true; },
  };
}

function card(title, ic, ...children) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, icon(ic), title)),
    h('div', { class: 'card-body stack' }, ...children));
}
