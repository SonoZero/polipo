'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notesToBlocks } = require('../src/updater');
const { summarizeFirmware } = require('../src/server/printers/base');
const { startServer } = require('../src/server');
const { startFakeMoonraker } = require('./fakes/http-printers');

function until(fn, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let ok = false;
      try { ok = fn(); } catch (_) { ok = false; }
      if (ok) { clearInterval(t); resolve(); } else if (Date.now() - start > timeout) { clearInterval(t); reject(new Error('timeout')); }
    }, 25);
  });
}

test('note di rilascio: solo testo, titoli ed elenchi', () => {
  const html = '<p>Polipo diventa <strong>SonoPrint</strong>.</p>\n<h2>Novit&agrave;</h2>\n<ul>\n<li><strong>Stampanti</strong> Bambu &amp; Klipper</li>\n<li>Logo &lt;nuovo&gt; &#8211; ok</li>\n</ul><script>alert(1)</script>';
  assert.deepStrictEqual(notesToBlocks(html), [
    { type: 'p', text: 'Polipo diventa SonoPrint.' },
    { type: 'h', text: 'Novità' },
    { type: 'li', text: 'Stampanti Bambu & Klipper' },
    { type: 'li', text: 'Logo <nuovo> – ok' },
  ]);
  assert.deepStrictEqual(notesToBlocks('## Novità\n- **uno**\n- due `x`\ntesto'), [
    { type: 'h', text: 'Novità' },
    { type: 'li', text: 'uno' },
    { type: 'li', text: 'due x' },
    { type: 'p', text: 'testo' },
  ]);
  assert.deepStrictEqual(notesToBlocks(null), []);
  assert.deepStrictEqual(notesToBlocks([{ version: '0.3.0', note: '<li>una</li>' }]), [{ type: 'li', text: 'una' }]);
});

test('riepilogo degli aggiornamenti per ogni tipo di stampante', () => {
  const k = summarizeFirmware({
    kind: 'klipper', current: { version: 'v0.12.0' }, canInstall: true,
    components: [
      { name: 'system', label: 'Sistema operativo', available: true },
      { name: 'klipper', label: 'Klipper', remote: 'v0.12.1', available: true },
      { name: 'mainsail', label: 'Mainsail', available: false },
    ],
  });
  assert.strictEqual(k.available, 2);
  assert.deepStrictEqual(k.items, ['Sistema operativo', 'Klipper v0.12.1']);
  assert.strictEqual(k.automatic, true);
  // Marlin generico: solo un avviso, non conta come aggiornamento da fare
  const m = summarizeFirmware({ kind: 'marlin', current: { name: 'Marlin 2.0.9', version: '2.0.9' }, latest: { version: '2.1.2.5' }, updateAvailable: true });
  assert.strictEqual(m.available, 0);
  assert.strictEqual(m.advisory, true);
  const p = summarizeFirmware({ kind: 'prusalink', current: { version: '6.1.0' }, latest: { version: '6.2.0' }, updateAvailable: true });
  assert.deepStrictEqual([p.available, p.automatic, p.latest], [1, false, '6.2.0']);
});

test('centro aggiornamenti: riepilogo alla connessione e controllo di tutto', async () => {
  const fake = await startFakeMoonraker();
  const srv = await startServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sonoprint-upd-')), port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const T = { 'X-SonoPrint-Token': srv.token, 'Content-Type': 'application/json' };
  try {
    const add = await fetch(`${base}/api/printers`, { method: 'POST', headers: T, body: JSON.stringify({ type: 'klipper', name: 'Voron', net: { host: '127.0.0.1', port: fake.port } }) });
    const id = (await add.json()).id;
    const p = srv.manager.get(id);
    await p.connect();
    // dopo la connessione il riepilogo arriva da solo (con qualche secondo di ritardo)
    await until(() => p.updates && p.updates.checkedAt, 12000);
    assert.strictEqual(p.snapshot().updates.available, 2);

    p.setUpdateSummary(null);
    const r = await fetch(`${base}/api/updates/check`, { method: 'POST', headers: T });
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.app.status, 'unsupported');
    const snap = body.printers.find((x) => x.id === id);
    assert.strictEqual(snap.updates.available, 2);
    assert.deepStrictEqual(snap.updates.items, ['Sistema operativo', 'Klipper v0.12.0-310']);

    // aggiornamento completato: il riepilogo si ricontrolla da solo
    fake.state.upgrades.length = 0;
    await p.installFirmware('full');
    await until(() => p.task && p.task.status === 'done');
    const before = p.updates.checkedAt;
    await until(() => p.updates.checkedAt > before, 12000);
    assert.deepStrictEqual(fake.state.upgrades, ['full']);
  } finally {
    await srv.close();
    await fake.close();
  }
});
