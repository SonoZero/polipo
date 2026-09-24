// Grafico delle temperature disegnato su canvas.

import { h } from '../util.js';
import { store } from '../api.js';

const SERIES_COLORS = { T0: '--hotend', T1: '--hotend-2', T2: '--chamber', T3: '--warning', B: '--bed', C: '--chamber' };

export function createTempChart(printerId) {
  const canvas = h('canvas');
  const el = h('div', { class: 'chart-wrap' }, canvas);
  let windowMs = 10 * 60 * 1000;
  let raf = 0;

  const ro = new ResizeObserver(() => schedule());
  ro.observe(el);
  const onTheme = () => schedule();
  window.addEventListener('themechange', onTheme);

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const hgt = el.clientHeight;
    if (!w || !hgt) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    const now = Date.now();
    const samples = (store.temps[printerId] || []).filter((s) => s.t >= now - windowMs - 5000);
    const pad = { l: 36, r: 10, t: 8, b: 20 };
    const pw = w - pad.l - pad.r;
    const ph = hgt - pad.t - pad.b;

    const keys = new Set();
    let max = 60;
    for (const s of samples) {
      for (const [k, v] of Object.entries(s)) {
        if (k === 't' || !Array.isArray(v)) continue;
        keys.add(k);
        if (v[0] !== null) max = Math.max(max, v[0]);
        if (v[1]) max = Math.max(max, v[1]);
      }
    }
    const step = max > 200 ? 50 : 25;
    const yMax = Math.ceil((max + 10) / step) * step;
    const x = (t) => pad.l + ((t - (now - windowMs)) / windowMs) * pw;
    const y = (v) => pad.t + ph - (v / yMax) * ph;

    // griglia
    ctx.font = '11px ' + css('--font');
    ctx.fillStyle = css('--text-faint');
    ctx.strokeStyle = css('--border');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= yMax; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillText(v + '°', pad.l - 6, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const minutes = windowMs / 60000;
    const tickEvery = minutes <= 5 ? 1 : minutes <= 10 ? 2 : 5;
    for (let m = 0; m <= minutes; m += tickEvery) {
      const xx = x(now - m * 60000);
      ctx.fillText(m === 0 ? 'ora' : `-${m} min`, Math.min(Math.max(xx, pad.l + 14), w - pad.r - 14), pad.t + ph + 5);
    }

    if (!samples.length) {
      ctx.fillStyle = css('--text-faint');
      ctx.textBaseline = 'middle';
      ctx.fillText('Nessun dato: connetti la stampante per vedere le temperature', pad.l + pw / 2, pad.t + ph / 2);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph + 1);
    ctx.clip();
    for (const k of keys) {
      const color = css(SERIES_COLORS[k] || '--text-dim');
      // target (tratteggiato)
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      path(ctx, samples, k, 1, x, y);
      // valore reale
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      path(ctx, samples, k, 0, x, y);
    }
    ctx.restore();
  }

  function path(ctx, samples, key, idx, x, y) {
    ctx.beginPath();
    let started = false;
    let lastT = 0;
    for (const s of samples) {
      const v = s[key] && s[key][idx];
      // i target a 0 (riscaldatore spento) non si disegnano
      if (v === null || v === undefined || (idx === 1 && v === 0)) { started = false; continue; }
      const xx = x(s.t);
      const yy = y(v);
      // interrompi la linea se mancano dati per più di 15 s (stampante disconnessa)
      if (!started || s.t - lastT > 15000) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
      started = true;
      lastT = s.t;
    }
    ctx.stroke();
  }

  const tick = setInterval(schedule, 2000);
  schedule();

  return {
    el,
    redraw: schedule,
    setWindow(minutes) { windowMs = minutes * 60000; schedule(); },
    destroy() {
      clearInterval(tick);
      ro.disconnect();
      window.removeEventListener('themechange', onTheme);
      cancelAnimationFrame(raf);
    },
  };
}
