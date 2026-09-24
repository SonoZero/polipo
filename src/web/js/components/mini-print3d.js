// Miniatura 3D del pezzo in stampa, per le carte della Panoramica. Finché il 3D non è pronto
// (o se il PC non ha WebGL) resta visibile la miniatura dello slicer.

import { h } from '../util.js';
import { store } from '../api.js';
import { loadGcode, jobPos } from './gcode-data.js';
import { createMini3D } from './preview3d.js';

const REDRAW_MS = 700;

export function createMiniPrint3D(thumbEl, file, printerId) {
  const canvas = h('canvas', { class: 'p3d-mini-canvas', 'aria-hidden': 'true' });
  thumbEl.classList.add('p3d-mini');
  thumbEl.appendChild(canvas);
  let mini = null;
  let data = null;
  let lastPos = -1;
  let timer = null;
  let lastDraw = 0;
  let destroyed = false;
  const ro = new ResizeObserver(() => { if (mini) mini.draw(); });
  ro.observe(canvas);

  Promise.all([loadGcode(file), createMini3D(canvas)]).then(([d, m]) => {
    if (destroyed) { m.destroy(); return; }
    if (!d.layers.length) { m.destroy(); return; }
    data = d;
    mini = m;
    const p = store.printers.get(printerId);
    if (p) mini.scene.setVolume(p.config.volume || {}, p.config.originCenter);
    mini.scene.setData(data);
    mini.scene.setGhost(true);
    mini.scene.frame('model');
    update(p);
    mini.draw();
    thumbEl.classList.add('ready');
  }).catch(() => { /* resta la miniatura dello slicer */ });

  function update(p) {
    if (!mini || !p || !p.job) return;
    const pos = jobPos(p.job, data);
    if (pos === lastPos) return;
    lastPos = pos;
    mini.scene.showProgress(pos);
    const wait = REDRAW_MS - (Date.now() - lastDraw);
    if (wait <= 0) { lastDraw = Date.now(); mini.draw(); return; }
    if (!timer) timer = setTimeout(() => { timer = null; lastDraw = Date.now(); if (mini) mini.draw(); }, wait);
  }

  return {
    update,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      ro.disconnect();
      if (mini) mini.destroy();
    },
  };
}
