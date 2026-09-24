// Telecamera: quella integrata nella stampante (Bambu Lab P1/A1, Klipper, OctoPrint),
// una webcam USB collegata al PC oppure un flusso MJPEG / snapshot via URL.

import { h, icon } from '../util.js';
import { cameraUrl } from '../api.js';

function cameraFor(printer) {
  const caps = printer.capabilities || {};
  if (caps.webcam === 'builtin') {
    if (printer.type === 'bambu') return { type: 'url', url: cameraUrl(printer.id), stream: true };
    const w = printer.extra && printer.extra.webcam;
    if (!w) return { type: 'none', unsupported: true };
    return { type: 'url', url: w.stream || w.snapshot, stream: !!w.stream, flipH: w.flipH, flipV: w.flipV, rotate: w.rotate };
  }
  if (caps.webcam === 'custom') return printer.config.webcam || { type: 'none' };
  return { type: 'none', unsupported: true };
}

export function createWebcam(printer) {
  const box = h('div', { class: 'webcam-box' });
  const el = h('div', null, box);
  let stream = null;
  let snapTimer = null;
  let retryTimer = null;
  let destroyed = false;
  const cam = cameraFor(printer);

  const transform = [
    cam.rotate ? `rotate(${cam.rotate}deg)` : '',
    cam.flipH ? 'scaleX(-1)' : '',
    cam.flipV ? 'scaleY(-1)' : '',
  ].join(' ').trim();

  const message = (ic, title, text) => {
    box.replaceChildren(h('div', { class: 'empty' }, icon(ic), h('h3', { style: { color: '#e6e8eb' } }, title), text ? h('p', null, text) : null));
  };

  if (cam.type === 'local') {
    const video = h('video', { autoplay: true, muted: true, playsinline: true, style: { transform } });
    message('camera', 'Avvio della webcam…');
    const constraints = { video: cam.deviceId ? { deviceId: { exact: cam.deviceId }, width: { ideal: 1280 } } : { width: { ideal: 1280 } }, audio: false };
    navigator.mediaDevices.getUserMedia(constraints).then((s) => {
      stream = s;
      video.srcObject = s;
      box.replaceChildren(video);
    }).catch((err) => {
      message('alert', 'Webcam non disponibile', err.name === 'NotFoundError' ? 'La telecamera scelta non è collegata.' : err.message);
    });
  } else if (cam.type === 'url' && cam.url) {
    const snapshot = !cam.stream && /\.(jpe?g|png)(\?|$)|snapshot/i.test(cam.url);
    const img = h('img', { alt: 'Immagine della telecamera', style: { transform } });
    const load = () => { img.src = cam.url + (cam.url.includes('?') ? '&' : '?') + '_t=' + Date.now(); };
    img.onload = () => { if (!img.isConnected) box.replaceChildren(img); };
    img.onerror = () => {
      if (destroyed) return;
      message('alert', 'Telecamera non raggiungibile', printer.type === 'bambu'
        ? 'Controlla che la stampante sia connessa. Sulle P1P la telecamera è un accessorio. Riprovo tra qualche secondo.'
        : cam.url);
      if (!snapshot) retryTimer = setTimeout(load, 4000);
    };
    load();
    if (snapshot) snapTimer = setInterval(load, 1000);
    box.replaceChildren(img);
  } else if (cam.unsupported) {
    message('camera', 'Telecamera non disponibile', printer.type === 'bambu'
      ? 'Le Bambu Lab X1 e H2 trasmettono la telecamera in RTSP: guardala da Bambu Studio o da Bambu Handy.'
      : 'Questa stampante non ha una telecamera configurata.');
  } else {
    message('camera', 'Nessuna webcam configurata', 'Puoi aggiungerne una nella scheda Impostazioni di questa stampante.');
  }

  return {
    el,
    destroy() {
      destroyed = true;
      clearInterval(snapTimer);
      clearTimeout(retryTimer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const img = box.querySelector('img');
      if (img) img.src = '';
    },
  };
}

export async function listCameras() {
  try {
    // serve un permesso per leggere i nomi delle telecamere
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
  } catch (_) { /* nessuna telecamera o permesso negato */ }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Telecamera ${i + 1}` }));
  } catch (_) {
    return [];
  }
}
