// Anteprima 2D del G-code layer per layer, con avanzamento della stampa in corso.

import { h, icon, clear, setText } from '../util.js';
import { store, fileByName } from '../api.js';
import { check } from '../views/printer-form.js';
import { loadGcode, getCached, fileKey, baseName, jobPos as posOf, layerAt } from './gcode-data.js';

export function createGcodeViewer(printerId) {
  const canvas = h('canvas');
  const overlay = h('div', { class: 'overlay' });
  const box = h('div', { class: 'viewer-canvas' }, canvas, overlay);
  const slider = h('input', { type: 'range', class: 'layer-slider', min: '0', max: '0', value: '0' });
  const layerLabel = h('div', { style: { fontWeight: 650 } });
  const zLabel = h('div', { class: 'dim num', style: { fontSize: '13px' } });
  const fileSelect = h('select', { class: 'select' });

  const opts = { travel: false, prev: true, follow: true };
  let data = null; // { layers, bounds }
  let loadedKey = '';
  let layer = 0;
  let view = null; // { scale, ox, oy }
  let raf = 0;
  let destroyed = false;
  let manualFile = null;

  const followCheck = check('Segui la stampa in corso', opts.follow, (v) => { opts.follow = v; syncFollow(); schedule(); });
  const side = h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('label', null, 'File'), fileSelect),
    h('div', { class: 'card', style: { padding: '12px 14px' } }, layerLabel, zLabel),
    h('div', { class: 'stack', style: { gap: '8px' } },
      followCheck,
      check('Mostra il layer precedente', opts.prev, (v) => { opts.prev = v; schedule(); }),
      check('Mostra gli spostamenti', opts.travel, (v) => { opts.travel = v; schedule(); })),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', title: 'Layer precedente', onclick: () => setLayer(layer - 1, true) }, icon('down', 'sm')),
      h('button', { class: 'btn sm', title: 'Layer successivo', onclick: () => setLayer(layer + 1, true) }, icon('up', 'sm')),
      h('button', { class: 'btn sm', title: 'Adatta alla vista', onclick: () => { view = null; schedule(); } }, icon('target', 'sm'), 'Centra')),
    h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Rotella per lo zoom, trascina per spostare.'));

  const el = h('div', { class: 'viewer' },
    h('div', { class: 'row', style: { alignItems: 'stretch', gap: '10px' } }, h('div', { class: 'grow' }, box), slider),
    side);

  slider.addEventListener('input', () => setLayer(Number(slider.value), true));
  fileSelect.addEventListener('change', () => { manualFile = fileSelect.value || null; ensureLoaded(); });

  // zoom e trascinamento
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!view) return;
    const r = box.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.ox = mx - (mx - view.ox) * f;
    view.oy = my - (my - view.oy) * f;
    view.scale *= f;
    schedule();
  }, { passive: false });
  let drag = null;
  box.addEventListener('mousedown', (e) => { if (view) drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }; box.style.cursor = 'grabbing'; });
  const onMove = (e) => { if (!drag) return; view.ox = drag.ox + e.clientX - drag.x; view.oy = drag.oy + e.clientY - drag.y; schedule(); };
  const onUp = () => { drag = null; box.style.cursor = ''; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  box.addEventListener('dblclick', () => { view = null; schedule(); });
  const ro = new ResizeObserver(() => { schedule(); });
  ro.observe(box);
  const onTheme = () => schedule();
  window.addEventListener('themechange', onTheme);

  function printer() { return store.printers.get(printerId); }

  function currentFileName() {
    const p = printer();
    if (manualFile) return manualFile;
    if (p && p.job) {
      const f = store.files.find((x) => baseName(x.name) === baseName(p.job.file));
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

  function ensureLoaded() {
    const name = currentFileName();
    const f = name ? fileByName(name) : null;
    renderFileSelect();
    if (!f) {
      data = null;
      loadedKey = '';
      overlay.textContent = 'Carica un file G-code per vederne l\'anteprima.';
      schedule();
      return;
    }
    const key = fileKey(f);
    if (key === loadedKey) return;
    loadedKey = key;
    data = null;
    view = null;
    const hit = getCached(f);
    if (hit) { onLoaded(hit); return; }
    overlay.textContent = 'Analisi del G-code...';
    loadGcode(f, (pct) => { if (key === loadedKey) overlay.textContent = `Analisi del G-code... ${Math.round(pct * 100)}%`; })
      .then((m) => { if (!destroyed && key === loadedKey) onLoaded(m); })
      .catch((err) => { if (!destroyed && key === loadedKey) overlay.textContent = 'Errore: ' + err.message; });
  }

  function onLoaded(result) {
    data = result;
    overlay.textContent = data.layers.length ? '' : 'Nessuna estrusione trovata nel file.';
    slider.max = String(Math.max(0, data.layers.length - 1));
    layer = data.layers.length - 1;
    syncFollow();
    setLayer(layer);
  }

  function isPrintingThis() {
    const p = printer();
    return !!(p && p.job && data && baseName(p.job.file) === baseName(currentFileName()));
  }

  const jobPos = (job) => posOf(job, data);

  function syncFollow() {
    if (!data || !opts.follow || !isPrintingThis()) return;
    const idx = layerAt(data, jobPos(printer().job));
    if (idx !== layer) setLayer(idx);
  }

  function setLayer(i, manual) {
    if (!data || !data.layers.length) { schedule(); return; }
    layer = Math.max(0, Math.min(data.layers.length - 1, i));
    if (manual && isPrintingThis()) {
      opts.follow = false;
      followCheck.querySelector('input').checked = false;
    }
    slider.value = String(layer);
    const l = data.layers[layer];
    setText(layerLabel, `Layer ${layer + 1} di ${data.layers.length}`);
    setText(zLabel, `Z ${l.z.toFixed(2).replace('.', ',')} mm`);
    schedule();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth, hh = box.clientHeight;
    if (!w || !hh) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);

    const p = printer();
    const vol = p ? p.config.volume : { x: 220, y: 220 };
    const center = p && p.config.originCenter;
    const bx0 = center ? -vol.x / 2 : 0, by0 = center ? -vol.y / 2 : 0;
    if (!view) {
      const scale = Math.min((w - 40) / vol.x, (hh - 40) / vol.y);
      view = { scale, ox: (w - vol.x * scale) / 2 - bx0 * scale, oy: (hh + vol.y * scale) / 2 + by0 * scale };
    }
    const sx = (x) => view.ox + x * view.scale;
    const sy = (y) => view.oy - y * view.scale;

    // piatto con griglia
    ctx.fillStyle = css('--surface-2');
    ctx.fillRect(sx(bx0), sy(by0 + vol.y), vol.x * view.scale, vol.y * view.scale);
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= vol.x; gx += 10) {
      ctx.strokeStyle = gx % 50 === 0 ? css('--border-strong') : css('--border');
      ctx.beginPath(); ctx.moveTo(Math.round(sx(bx0 + gx)) + 0.5, sy(by0)); ctx.lineTo(Math.round(sx(bx0 + gx)) + 0.5, sy(by0 + vol.y)); ctx.stroke();
    }
    for (let gy = 0; gy <= vol.y; gy += 10) {
      ctx.strokeStyle = gy % 50 === 0 ? css('--border-strong') : css('--border');
      ctx.beginPath(); ctx.moveTo(sx(bx0), Math.round(sy(by0 + gy)) + 0.5); ctx.lineTo(sx(bx0 + vol.x), Math.round(sy(by0 + gy)) + 0.5); ctx.stroke();
    }

    if (!data || !data.layers.length) return;
    const lw = Math.max(0.6, Math.min(3, 0.45 * view.scale));
    ctx.lineCap = 'round';

    if (opts.prev && layer > 0) {
      drawLayer(ctx, data.layers[layer - 1], { extrude: css('--text-faint'), alpha: 0.35, lw, sx, sy });
    }
    const printingThis = isPrintingThis();
    const filePos = printingThis ? jobPos(p.job) : Infinity;
    drawLayer(ctx, data.layers[layer], {
      extrude: css('--accent'), pending: printingThis ? css('--text-faint') : null,
      travel: opts.travel ? css('--info') : null, alpha: 1, lw, sx, sy, filePos,
    });

    // posizione dell'ugello durante la stampa
    if (printingThis) {
      const l = data.layers[layer];
      let last = -1;
      for (let i = 0; i < l.off.length; i++) { if (l.off[i] <= filePos) last = i; else break; }
      if (last >= 0 && last < l.off.length - 1) {
        const nx = sx(l.seg[last * 4 + 2]), ny = sy(l.seg[last * 4 + 3]);
        ctx.fillStyle = css('--accent');
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(nx, ny, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  }

  function drawLayer(ctx, l, o) {
    const n = l.type.length;
    ctx.globalAlpha = o.alpha;
    const pass = (color, filter, width, dash) => {
      if (!color) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (!filter(i)) continue;
        ctx.moveTo(o.sx(l.seg[i * 4]), o.sy(l.seg[i * 4 + 1]));
        ctx.lineTo(o.sx(l.seg[i * 4 + 2]), o.sy(l.seg[i * 4 + 3]));
      }
      ctx.stroke();
    };
    const fp = o.filePos === undefined ? Infinity : o.filePos;
    pass(o.travel, (i) => l.type[i] === 0, 0.7, [3, 3]);
    if (o.pending) pass(o.pending, (i) => l.type[i] === 1 && l.off[i] > fp, o.lw);
    pass(o.extrude, (i) => l.type[i] === 1 && l.off[i] <= fp, o.lw);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  ensureLoaded();

  return {
    el,
    onPrinterUpdate() {
      ensureLoaded();
      syncFollow();
      if (isPrintingThis()) schedule();
    },
    onFilesChanged() { ensureLoaded(); },
    destroy() {
      destroyed = true;
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('themechange', onTheme);
      cancelAnimationFrame(raf);
    },
  };
}
