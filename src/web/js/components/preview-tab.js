// Scheda "Anteprima": vista 3D (pezzo sul piatto) oppure 2D (un layer alla volta).

import { h } from '../util.js';
import { createGcodeViewer } from './gcode-viewer.js';
import { createGcodeViewer3D } from './gcode-viewer-3d.js';

const PREF = 'sonoprint-preview-mode';

function savedMode() {
  try { return localStorage.getItem(PREF) === '2d' ? '2d' : '3d'; } catch (_) { return '3d'; }
}

export function createPreview(printerId) {
  let mode = savedMode();
  let comp = null;
  const body = h('div');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Tipo di anteprima' });
  const el = h('div', { class: 'stack' }, seg, body);

  function renderSeg() {
    seg.replaceChildren(...[['3d', '3D'], ['2d', '2D, layer per layer']].map(([m, label]) =>
      h('button', { class: m === mode ? 'active' : '', 'aria-pressed': m === mode ? 'true' : 'false', onclick: () => setMode(m) }, label)));
  }

  function setMode(m) {
    if (m === mode && comp) return;
    mode = m;
    try { localStorage.setItem(PREF, m); } catch (_) { /* preferenza non salvata */ }
    renderSeg();
    if (comp && comp.destroy) comp.destroy();
    comp = m === '3d' ? createGcodeViewer3D(printerId) : createGcodeViewer(printerId);
    body.replaceChildren(comp.el);
  }

  setMode(mode);

  return {
    el,
    onPrinterUpdate(p) { if (comp && comp.onPrinterUpdate) comp.onPrinterUpdate(p); },
    onFilesChanged() { if (comp && comp.onFilesChanged) comp.onFilesChanged(); },
    destroy() { if (comp && comp.destroy) comp.destroy(); },
  };
}
