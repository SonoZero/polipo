// Archivio dei file G-code, condiviso da tutte le stampanti.

import { h, icon, clear, fmtDuration, fmtSize, fmtFilament, fmtRelative, fmtDate } from '../util.js';
import { api, store, on, uploadFile, fileUrl } from '../api.js';
import { run, toast, confirmDialog } from '../ui.js';
import { printOnMenu, fileThumb } from '../actions.js';

export function mountFiles(container) {
  const offs = [];
  let query = '';
  let sort = 'recent';

  const fileInput = h('input', { type: 'file', accept: '.gcode,.gco,.g', multiple: true, hidden: true, onchange: (e) => { upload([...e.target.files]); e.target.value = ''; } });
  const uploads = h('div', { class: 'upload-progress stack', style: { gap: '8px' } });
  const listCard = h('div', { class: 'card file-list' });
  const drop = h('div', { class: 'dropzone' },
    icon('upload'),
    h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 650, color: 'var(--text)' } }, 'Trascina qui i file G-code'),
      h('div', { style: { fontSize: '13px' } }, 'Oppure scegli i file dal computer. Esporta dallo slicer (Cura, PrusaSlicer, Orca…) in formato .gcode.')),
    h('button', { class: 'btn primary', onclick: () => fileInput.click() }, icon('upload'), 'Scegli file'));

  const sortSel = h('select', { class: 'select', style: { width: '170px' }, onchange: (e) => { sort = e.target.value; render(); } },
    h('option', { value: 'recent' }, 'Più recenti'),
    h('option', { value: 'name' }, 'Nome'),
    h('option', { value: 'time' }, 'Durata'),
    h('option', { value: 'size' }, 'Dimensione'));

  container.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' },
        h('h1', { class: 'page-title' }, 'File G-code'),
        h('div', { class: 'page-sub' }, 'Un unico archivio per tutte le stampanti: carica una volta, stampa dove vuoi.')),
      h('input', { class: 'input', placeholder: 'Cerca…', style: { width: '220px' }, oninput: (e) => { query = e.target.value; render(); } }),
      sortSel,
      fileInput),
    drop, uploads, listCard);

  // trascinamento sull'intera pagina
  let dragDepth = 0;
  const onEnter = (e) => { if (hasFiles(e)) { dragDepth++; drop.classList.add('over'); } };
  const onLeave = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('over'); };
  const onOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('over');
    upload([...e.dataTransfer.files]);
  };
  document.addEventListener('dragenter', onEnter);
  document.addEventListener('dragleave', onLeave);
  document.addEventListener('dragover', onOver);
  document.addEventListener('drop', onDrop);

  async function upload(files) {
    for (const f of files) {
      if (!/\.(gcode|gco|g)$/i.test(f.name)) {
        toast('warn', 'File ignorato', `${f.name}: non è un file G-code.`);
        continue;
      }
      const bar = h('div');
      const pct = h('span', { class: 'faint num' }, '0%');
      const row = h('div', { class: 'card', style: { padding: '10px 14px' } },
        h('div', { class: 'row', style: { marginBottom: '6px' } }, h('span', { class: 'grow', style: { fontWeight: 600 } }, f.name), pct),
        h('div', { class: 'progress' }, bar));
      uploads.appendChild(row);
      try {
        const r = await uploadFile(f, (p) => { bar.style.width = (p * 100).toFixed(1) + '%'; pct.textContent = Math.round(p * 100) + '%'; });
        toast('success', 'File caricato', r.name !== f.name ? `Salvato come ${r.name}` : r.name, 3500);
      } catch (err) {
        toast('error', 'Caricamento non riuscito', `${f.name}: ${err.message}`);
      } finally {
        row.remove();
      }
    }
  }

  function render() {
    clear(listCard);
    let files = store.files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));
    const t = (f) => (f.meta && f.meta.estimatedTime) || 0;
    if (sort === 'name') files.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'time') files.sort((a, b) => t(b) - t(a));
    else if (sort === 'size') files.sort((a, b) => b.size - a.size);

    if (!store.files.length) {
      listCard.appendChild(h('div', { class: 'empty' }, icon('files'), h('h3', null, 'Nessun file ancora'), h('p', null, 'Carica il tuo primo G-code per stamparlo su una qualsiasi delle tue stampanti.')));
      return;
    }
    listCard.appendChild(h('div', { class: 'file-row head' },
      h('span'), h('span', null, 'Nome'), h('span', { class: 'opt' }, 'Tempo stimato'), h('span', { class: 'opt' }, 'Filamento'),
      h('span', { class: 'opt' }, 'Dimensione'), h('span', { class: 'opt' }, 'Stampe'), h('span')));
    if (!files.length) {
      listCard.appendChild(h('div', { class: 'empty' }, h('p', null, 'Nessun file corrisponde alla ricerca.')));
      return;
    }
    for (const f of files) listCard.appendChild(fileRow(f));
  }

  function fileRow(f) {
    const m = f.meta || {};
    const details = [];
    if (f.analyzing) details.push('Analisi in corso…');
    if (m.error) details.push('Analisi non riuscita');
    if (m.slicer) details.push(m.slicer);
    if (m.material) details.push(m.material);
    if (m.layerCount) details.push(`${m.layerCount} layer`);
    if (m.bounds) details.push(`${Math.round(m.bounds.maxX - m.bounds.minX)}×${Math.round(m.bounds.maxY - m.bounds.minY)}×${Math.round(m.bounds.maxZ)} mm`);
    if (m.nozzleTemp) details.push(`${m.nozzleTemp}°/${m.bedTemp || 0}°`);
    const last = f.prints && f.prints.last;
    return h('div', { class: 'file-row' },
      fileThumb(f),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'file-name', title: f.name }, f.name),
        h('div', { class: 'file-sub' }, h('span', null, `caricato ${fmtRelative(f.addedAt)}`), ...details.map((d) => h('span', null, d)))),
      h('span', { class: 'opt num' }, fmtDuration(m.estimatedTime, { short: true })),
      h('span', { class: 'opt num' }, fmtFilament(m.filamentLength, m.filamentWeight)),
      h('span', { class: 'opt num' }, fmtSize(f.size)),
      h('span', { class: 'opt num', title: last ? `Ultima: ${fmtDate(last.date)} su ${last.printer}` : 'Mai stampato' },
        f.prints && (f.prints.success || f.prints.failure)
          ? [h('span', { class: 'ok-count' }, `✓ ${f.prints.success}`), ' ', f.prints.failure ? h('span', { class: 'ko-count' }, `✗ ${f.prints.failure}`) : null]
          : h('span', { class: 'faint' }, '—')),
      h('div', { class: 'file-actions' },
        h('button', { class: 'btn primary sm', onclick: (e) => printOnMenu(e.currentTarget, f.name) }, icon('play', 'sm'), 'Stampa su…'),
        h('a', { class: 'btn sm icon-only ghost', title: 'Scarica', href: fileUrl(f.name, 'content'), download: f.name }, icon('download', 'sm')),
        h('button', {
          class: 'btn sm icon-only ghost', title: 'Elimina',
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Eliminare il file?', message: `"${f.name}" verrà eliminato definitivamente dall'archivio di Polipo.`, confirmLabel: 'Elimina', danger: true });
            if (ok) run(() => api('DELETE', `/files/${encodeURIComponent(f.name)}`));
          },
        }, icon('trash', 'sm'))));
  }

  render();
  offs.push(on('files', render));

  return {
    destroy() {
      offs.forEach((f) => f());
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('drop', onDrop);
    },
  };
}

function hasFiles(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}
