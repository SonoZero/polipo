// Anteprima 3D di un file dell'archivio, prima di stamparlo, sul piatto di una delle stampanti.

import { h, icon, setText } from '../util.js';
import { printerList } from '../api.js';
import { openModal } from '../ui.js';
import { loadGcode } from './gcode-data.js';
import { createInteractive3D } from './preview3d.js';

/** Stampante con il piatto più adatto al file: ci sta dentro, e per i 3MF è una Bambu Lab. */
function bestPrinter(f) {
  const b = f.meta && f.meta.bounds;
  const list = printerList();
  const fits = (p) => {
    const v = p.config.volume;
    if (!b || !v) return true;
    return b.maxX <= v.x + 1 && b.maxY <= v.y + 1 && (b.maxZ || 0) <= v.z + 1;
  };
  const wanted = f.kind === '3mf' ? list.filter((p) => p.type === 'bambu') : list;
  return wanted.find(fits) || list.find(fits) || list[0] || null;
}

export function openFile3D(f) {
  const overlay = h('div', { class: 'overlay' }, 'Preparo l\'anteprima 3D...');
  const box = h('div', { class: 'viewer-canvas p3d', style: { height: 'min(62vh, 560px)' } }, overlay);
  const layerLabel = h('span', { class: 'dim num', style: { fontSize: '13px', minWidth: '120px' } });
  const slider = h('input', { type: 'range', class: 'grow', min: '0', max: '0', value: '0', 'aria-label': 'Layer', style: { accentColor: 'var(--accent)' } });
  const printers = printerList();
  let printer = bestPrinter(f);
  const plateSel = printers.length > 1
    ? h('select', { class: 'select', 'aria-label': 'Piatto della stampante', style: { width: 'auto' } },
      ...printers.map((p) => h('option', { value: p.id, selected: printer && p.id === printer.id }, `Piatto di ${p.config.name}`)))
    : null;

  let view = null;
  let data = null;
  let destroyed = false;

  const body = h('div', { class: 'stack' },
    box,
    h('div', { class: 'row', style: { gap: '12px' } }, layerLabel, slider),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      plateSel,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => view && view.reset('plate') }, icon('target', 'sm'), 'Centra'),
      h('button', { class: 'btn sm', onclick: () => view && view.reset('model') }, icon('cube', 'sm'), 'Pezzo')),
    h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Trascina per ruotare, rotella per lo zoom, tasto destro per spostare.'));

  openModal({
    title: f.name,
    size: 'wide',
    body,
    onClose: () => { destroyed = true; if (view) view.destroy(); },
  });

  function applyPlate() {
    if (!view) return;
    const b = f.meta && f.meta.bounds;
    // senza stampanti: un piatto appena più grande del pezzo
    const vol = printer ? printer.config.volume : {
      x: Math.max(100, Math.ceil(((b && b.maxX) || 200) / 10) * 10 + 10),
      y: Math.max(100, Math.ceil(((b && b.maxY) || 200) / 10) * 10 + 10),
      z: Math.max(100, Math.ceil(((b && b.maxZ) || 100) / 10) * 10 + 20),
    };
    view.scene.setVolume(vol, printer ? printer.config.originCenter : false);
    view.reset('plate');
  }

  function showLayer(i) {
    if (!data) return;
    const n = data.layers.length;
    const li = Math.max(0, Math.min(n - 1, i));
    if (li >= n - 1) view.scene.showAll();
    else view.scene.showUpToLayer(li);
    setText(layerLabel, `Layer ${li + 1} di ${n}`);
    view.request();
  }

  if (plateSel) plateSel.addEventListener('change', () => { printer = printers.find((p) => p.id === plateSel.value) || null; applyPlate(); });
  slider.addEventListener('input', () => showLayer(Number(slider.value)));
  box.addEventListener('dblclick', () => view && view.reset('plate'));

  Promise.all([
    createInteractive3D(box),
    loadGcode(f, (pct) => { if (!view) overlay.textContent = `Analisi del G-code... ${Math.round(pct * 100)}%`; }),
  ]).then(([v, d]) => {
    if (destroyed) { v.destroy(); return; }
    view = v;
    data = d;
    if (!d.layers.length) { overlay.textContent = 'Nessuna estrusione trovata nel file.'; return; }
    overlay.textContent = '';
    view.scene.setData(d);
    slider.max = String(d.layers.length - 1);
    slider.value = slider.max;
    applyPlate();
    showLayer(d.layers.length - 1);
  }).catch((err) => { if (!destroyed) overlay.textContent = err.message; });
}
