// Webcam: telecamera USB collegata al PC oppure flusso MJPEG / snapshot via URL.

import { h, icon } from '../util.js';

export function createWebcam(config) {
  const box = h('div', { class: 'webcam-box' });
  const el = h('div', null, box);
  let stream = null;
  let snapTimer = null;
  const cam = config.webcam || { type: 'none' };

  const transform = [
    cam.rotate ? `rotate(${cam.rotate}deg)` : '',
    cam.flipH ? 'scaleX(-1)' : '',
    cam.flipV ? 'scaleY(-1)' : '',
  ].join(' ').trim();

  const message = (ic, title, text) => {
    box.replaceChildren(h('div', { class: 'empty' }, icon(ic), h('h3', { style: { color: '#ddd' } }, title), text ? h('p', null, text) : null));
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
    const snapshot = /\.(jpe?g|png)(\?|$)|snapshot/i.test(cam.url);
    const img = h('img', { alt: 'Webcam', style: { transform } });
    img.onerror = () => message('alert', 'Webcam non raggiungibile', cam.url);
    const load = () => { img.src = cam.url + (snapshot ? (cam.url.includes('?') ? '&' : '?') + '_t=' + Date.now() : ''); };
    load();
    if (snapshot) snapTimer = setInterval(load, 1000);
    box.replaceChildren(img);
  } else {
    message('camera', 'Nessuna webcam configurata', 'Puoi aggiungerne una nella scheda Impostazioni di questa stampante.');
  }

  return {
    el,
    destroy() {
      clearInterval(snapTimer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
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
