// Web Worker: scarica e analizza un file G-code dividendolo in layer di segmenti,
// così l'interfaccia resta fluida anche con file grandi.

self.onmessage = async (ev) => {
  const { url } = ev.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Impossibile scaricare il file (' + res.status + ')');
    const total = Number(res.headers.get('Content-Length')) || 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('latin1');
    const parser = createParser();
    let buffered = '';
    let offset = 0; // byte (latin1: 1 carattere = 1 byte)
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let nl;
      let start = 0;
      while ((nl = buffered.indexOf('\n', start)) >= 0) {
        const line = buffered.slice(start, nl);
        offset += nl - start + 1;
        parser.line(line, offset);
        start = nl + 1;
      }
      buffered = buffered.slice(start);
      if (total && Date.now() - lastReport > 150) {
        lastReport = Date.now();
        self.postMessage({ type: 'progress', pct: offset / total });
      }
    }
    if (buffered) { offset += buffered.length; parser.line(buffered, offset); }
    const result = parser.finish();
    const transfer = [];
    for (const l of result.layers) transfer.push(l.seg.buffer, l.type.buffer, l.off.buffer);
    self.postMessage({ type: 'done', ...result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

function createParser() {
  let x = 0, y = 0, z = 0, e = 0;
  let relative = false, relativeE = false;
  const layers = [];
  let cur = null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function newLayer(zz, off) {
    cur = { z: zz, start: off, seg: [], type: [], off: [] };
    layers.push(cur);
  }

  function addSeg(x1, y1, x2, y2, extrude, off) {
    if (!cur) newLayer(z, off);
    cur.seg.push(x1, y1, x2, y2);
    cur.type.push(extrude ? 1 : 0);
    cur.off.push(off);
    if (extrude) {
      if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
      if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
    }
  }

  function num(cmd, letter) {
    const i = cmd.indexOf(letter);
    if (i < 0) return null;
    const m = /^-?\d*\.?\d+/.exec(cmd.slice(i + 1));
    return m ? parseFloat(m[0]) : null;
  }

  function line(raw, off) {
    let s = raw;
    const semi = s.indexOf(';');
    if (semi >= 0) s = s.slice(0, semi);
    s = s.trim().toUpperCase();
    if (!s) return;
    // G0/G1/G2/G3
    const c0 = s.charCodeAt(0);
    if (c0 === 71 /* G */) {
      const code = /^G(\d+)/.exec(s);
      if (!code) return;
      const g = parseInt(code[1], 10);
      if (g === 0 || g === 1 || g === 2 || g === 3) {
        const args = s.slice(code[0].length);
        const px = num(args, 'X'), py = num(args, 'Y'), pz = num(args, 'Z'), pe = num(args, 'E');
        const nx = px === null ? x : (relative ? x + px : px);
        const ny = py === null ? y : (relative ? y + py : py);
        const nz = pz === null ? z : (relative ? z + pz : pz);
        let extrude = false;
        if (pe !== null) {
          const de = relativeE ? pe : pe - e;
          e = relativeE ? e + pe : pe;
          extrude = de > 0;
        }
        const moving = nx !== x || ny !== y;
        // un nuovo layer inizia con la prima estrusione a una Z diversa
        if (extrude && moving) {
          if (!cur) newLayer(nz, off);
          else if (Math.abs(nz - cur.z) > 1e-4) {
            if (cur.hasExtrusion) newLayer(nz, off);
            else cur.z = nz;
          }
        }
        if (moving) {
          if (g === 2 || g === 3) {
            arc(x, y, nx, ny, num(args, 'I') || 0, num(args, 'J') || 0, g === 2, extrude, off);
          } else {
            addSeg(x, y, nx, ny, extrude, off);
          }
          if (extrude && cur) cur.hasExtrusion = true;
        }
        x = nx; y = ny; z = nz;
        return;
      }
      if (g === 90) { relative = false; relativeE = false; return; }
      if (g === 91) { relative = true; relativeE = true; return; }
      if (g === 92) {
        const pe = num(s, 'E'); if (pe !== null) e = pe;
        const px = num(s, 'X'); if (px !== null) x = px;
        const py = num(s, 'Y'); if (py !== null) y = py;
        const pz = num(s, 'Z'); if (pz !== null) z = pz;
        return;
      }
      if (g === 28) { x = 0; y = 0; z = 0; return; }
      return;
    }
    if (c0 === 77 /* M */) {
      const m = parseInt(s.slice(1), 10);
      if (m === 82) relativeE = false;
      else if (m === 83) relativeE = true;
    }
  }

  function arc(x1, y1, x2, y2, i, j, clockwise, extrude, off) {
    const cx = x1 + i, cy = y1 + j;
    const r = Math.hypot(i, j);
    let a1 = Math.atan2(y1 - cy, x1 - cx);
    let a2 = Math.atan2(y2 - cy, x2 - cx);
    if (clockwise) { if (a2 >= a1) a2 -= Math.PI * 2; } else if (a2 <= a1) a2 += Math.PI * 2;
    const steps = Math.max(2, Math.min(64, Math.ceil(Math.abs(a2 - a1) * r / 1)));
    let px = x1, py = y1;
    for (let k = 1; k <= steps; k++) {
      const a = a1 + ((a2 - a1) * k) / steps;
      const nx = k === steps ? x2 : cx + r * Math.cos(a);
      const ny = k === steps ? y2 : cy + r * Math.sin(a);
      addSeg(px, py, nx, ny, extrude, off);
      px = nx; py = ny;
    }
  }

  function finish() {
    // scarta i layer senza estrusione (es. spostamenti finali)
    const out = layers.filter((l) => l.hasExtrusion).map((l) => ({
      z: l.z,
      start: l.start,
      seg: new Float32Array(l.seg),
      type: new Uint8Array(l.type),
      off: new Uint32Array(l.off),
    }));
    return { layers: out, bounds: isFinite(minX) ? { minX, minY, maxX, maxY } : null };
  }

  return { line, finish };
}
