// Anteprima 3D nella scheda Anteprima: il pezzo sul piatto della stampante, che cresce con la stampa.

import { h, icon, clear, setText, fmtPct } from '../util.js';
import { store, fileByName } from '../api.js';
import { check } from '../views/printer-form.js';
import { loadGcode, getCached, fileKey, baseName, jobPos } from './gcode-data.js';
import { createInteractive3D } from './preview3d.js';

export function createGcodeViewer3D(printerId) {
  const overlay = h('div', { class: 'overlay' });
  const box = h('div', { class: 'viewer-canvas p3d' }, overlay);
  const slider = h('input', { type: 'range', class: 'layer-slider', min: '0', max: '0', value: '0', 'aria-label': 'Layer' });
  const layerLabel = h('div', { style: { fontWeight: 650 } });
  const zLabel = h('div', { class: 'dim num', style: { fontSize: '13px' } });
  const fileSelect = h('select', { class: 'select', 'aria-label': 'File' });

  const opts = { follow: true, ghost: true };
  let view = null;
  let data = null;
  let loadedKey = '';
  let layer = 0;
  let manualFile = null;
  let destroyed = false;
  let lastShown = '';

  const followCheck = check('Segui la stampa in corso', opts.follow, (v) => { opts.follow = v; refresh(); });
  const side = h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { for: 'p3d-file' }, 'File'), fileSelect),
    h('div', { class: 'card', style: { padding: '12px 14px' } }, layerLabel, zLabel),
    h('div', { class: 'stack', style: { gap: '8px' } },
      followCheck,
      check('Mostra il resto del pezzo in trasparenza', opts.ghost, (v) => { opts.ghost = v; if (view) { view.scene.setGhost(v); view.request(); } })),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', title: 'Layer precedente', 'aria-label': 'Layer precedente', onclick: () => setLayer(layer - 1) }, icon('down', 'sm')),
      h('button', { class: 'btn sm', title: 'Layer successivo', 'aria-label': 'Layer successivo', onclick: () => setLayer(layer + 1) }, icon('up', 'sm')),
      h('button', { class: 'btn sm', onclick: () => view && view.reset('plate') }, icon('target', 'sm'), 'Centra'),
      h('button', { class: 'btn sm', onclick: () => view && view.reset('model') }, icon('cube', 'sm'), 'Pezzo')),
    h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Trascina per ruotare, rotella per lo zoom, tasto destro per spostare.'));
  fileSelect.id = 'p3d-file';

  const el = h('div', { class: 'viewer' },
    h('div', { class: 'row', style: { alignItems: 'stretch', gap: '10px' } }, h('div', { class: 'grow' }, box), slider),
    side);

  slider.addEventListener('input', () => setLayer(Number(slider.value)));
  fileSelect.addEventListener('change', () => { manualFile = fileSelect.value || null; ensureLoaded(); });
  box.addEventListener('dblclick', () => view && view.reset('plate'));

  overlay.textContent = 'Preparo l\'anteprima 3D...';
  createInteractive3D(box).then((v) => {
    if (destroyed) { v.destroy(); return; }
    view = v;
    applyVolume();
    if (data) onLoaded(data);
    else { view.reset('plate'); ensureLoaded(); }
  }).catch((err) => { overlay.textContent = err.message; });

  function printer() { return store.printers.get(printerId); }

  function currentFileName() {
    const p = printer();
    if (manualFile) return manualFile;
    if (p && p.job) {
      const f = fileByName(p.job.file);
      if (f) return f.name;
    }
    return store.files[0] ? store.files[0].name : null;
  }

  let selectKey = '';
  function renderFileSelect() {
    const p = printer();
    const selected = currentFileName();
    const key = store.files.map((f) => f.name).join('\n') + '|' + (p && p.job ? p.job.file : '') + '|' + selected;
    if (key === selectKey) return;
    selectKey = key;
    clear(fileSelect);
    if (!store.files.length) fileSelect.appendChild(h('option', { value: '' }, 'Nessun file caricato'));
    for (const f of store.files) {
      const label = p && p.job && baseName(p.job.file) === baseName(f.name) ? `${f.name} (in stampa)` : f.name;
      fileSelect.appendChild(h('option', { value: f.name }, label));
    }
    if (selected) fileSelect.value = selected;
  }

  function applyVolume() {
    const p = printer();
    if (view && p && view.scene.setVolume(p.config.volume || {}, p.config.originCenter)) view.request();
  }

  function ensureLoaded() {
    const name = currentFileName();
    const f = name ? fileByName(name) : null;
    renderFileSelect();
    if (!f) {
      data = null;
      loadedKey = '';
      if (view) { view.scene.setData(null); view.request(); }
      overlay.textContent = 'Carica un file G-code per vederne l\'anteprima.';
      setText(layerLabel, 'Nessun file');
      setText(zLabel, '');
      return;
    }
    const key = fileKey(f);
    if (key === loadedKey) return;
    loadedKey = key;
    data = null;
    const hit = getCached(f);
    if (hit) { onLoaded(hit); return; }
    overlay.textContent = 'Analisi del G-code...';
    loadGcode(f, (pct) => { if (key === loadedKey) overlay.textContent = `Analisi del G-code... ${Math.round(pct * 100)}%`; })
      .then((m) => { if (!destroyed && key === loadedKey) onLoaded(m); })
      .catch((err) => { if (!destroyed && key === loadedKey) overlay.textContent = 'Errore: ' + err.message; });
  }

  function onLoaded(result) {
    data = result;
    if (!view) return;
    overlay.textContent = data.layers.length ? '' : 'Nessuna estrusione trovata nel file.';
    view.scene.setData(data);
    view.scene.setGhost(opts.ghost);
    slider.max = String(Math.max(0, data.layers.length - 1));
    layer = data.layers.length - 1;
    lastShown = '';
    view.reset('plate');
    refresh();
  }

  function isPrintingThis() {
    const p = printer();
    return !!(p && p.job && data && baseName(p.job.file) === baseName(currentFileName()));
  }

  /** Aggiorna quello che si vede: stampa in corso, layer scelto o pezzo intero. */
  function refresh() {
    if (!view || !data || !data.layers.length) return;
    const p = printer();
    if (opts.follow && isPrintingThis()) {
      const pos = jobPos(p.job, data);
      const key = 'p' + pos;
      if (key === lastShown) return;
      lastShown = key;
      layer = view.scene.showProgress(pos);
      updateLabels(p.job.progress);
    } else {
      const key = 'l' + layer;
      if (key === lastShown) return;
      lastShown = key;
      if (layer >= data.layers.length - 1) view.scene.showAll();
      else view.scene.showUpToLayer(layer);
      updateLabels(null);
    }
    view.request();
  }

  function updateLabels(progress) {
    slider.value = String(layer);
    const l = data.layers[layer];
    setText(layerLabel, `Layer ${layer + 1} di ${data.layers.length}`);
    setText(zLabel, `Z ${l.z.toFixed(2).replace('.', ',')} mm` + (progress !== null && progress !== undefined ? `, ${fmtPct(progress)} stampato` : ''));
  }

  function setLayer(i) {
    if (!data || !data.layers.length) return;
    layer = Math.max(0, Math.min(data.layers.length - 1, i));
    if (isPrintingThis() && opts.follow) {
      opts.follow = false;
      followCheck.querySelector('input').checked = false;
    }
    refresh();
  }

  ensureLoaded();

  return {
    el,
    onPrinterUpdate() {
      applyVolume();
      ensureLoaded();
      refresh();
    },
    onFilesChanged() { ensureLoaded(); },
    destroy() {
      destroyed = true;
      if (view) view.destroy();
    },
  };
}
