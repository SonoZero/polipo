// G-code analizzato in layer (dal worker), condiviso tra anteprima 2D, 3D, Panoramica e File:
// ogni file viene scaricato e analizzato una volta sola.

import { store, fileUrl, fileByName } from '../api.js';

const MAX_CACHED = 4;
const cache = new Map(); // chiave -> risultato
const pending = new Map(); // chiave -> { promise, listeners }

export function fileKey(f) {
  return f.name + '|' + f.size + '|' + f.addedAt;
}

export function getCached(f) {
  return f ? cache.get(fileKey(f)) || null : null;
}

/** Analizza un file dell'archivio. onProgress(pct) riceve l'avanzamento da 0 a 1. */
export function loadGcode(f, onProgress) {
  const key = fileKey(f);
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return Promise.resolve(v);
  }
  let job = pending.get(key);
  if (!job) {
    const listeners = new Set();
    const promise = new Promise((resolve, reject) => {
      const worker = new Worker('js/components/gcode-worker.js');
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') listeners.forEach((fn) => fn(m.pct));
        else if (m.type === 'done') {
          worker.terminate();
          pending.delete(key);
          cache.set(key, m);
          while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
          resolve(m);
        } else if (m.type === 'error') {
          worker.terminate();
          pending.delete(key);
          reject(new Error(m.message));
        }
      };
      worker.postMessage({ url: new URL(fileUrl(f.name, 'content'), location.href).href });
    });
    job = { promise, listeners };
    pending.set(key, job);
  }
  if (onProgress) job.listeners.add(onProgress);
  return job.promise.finally(() => { if (onProgress) job.listeners.delete(onProgress); });
}

export function baseName(name) {
  return String(name || '').replace(/(\.gcode)?\.3mf$|\.(gcode|gco|g)$/i, '');
}

/** File dell'archivio che la stampante sta stampando, se c'è. */
export function fileForJob(job) {
  if (!job || !job.file) return null;
  const b = baseName(job.file);
  const f = store.files.find((x) => baseName(x.name) === b);
  return f ? fileByName(f.name) || f : null;
}

/** Punto del file raggiunto: esatto per le stampanti USB, stimato per quelle in rete. */
export function jobPos(job, data) {
  if (job.filePos !== undefined && job.filePos !== null) return job.filePos;
  if (job.layer && data.layers.length) {
    const next = data.layers[Math.min(job.layer, data.layers.length)];
    return next ? next.start - 1 : (data.size || Infinity);
  }
  return Math.round((job.progress || 0) * (data.size || 0));
}

/** Indice del layer che contiene il punto del file indicato. */
export function layerAt(data, pos) {
  let lo = 0, hi = data.layers.length - 1, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (data.layers[mid].start <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}
