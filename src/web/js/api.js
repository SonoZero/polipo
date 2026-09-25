// Comunicazione con il servizio SonoPrint: API REST + WebSocket, e stato condiviso.

// token della sessione locale: c'è solo sul computer; i browser della rete usano il cookie dell'accesso
const TOKEN = document.querySelector('meta[name="sonoprint-token"]').content;
const authHeaders = () => (TOKEN ? { 'X-SonoPrint-Token': TOKEN } : {});
const tokenQuery = (sep) => (TOKEN ? `${sep}token=${TOKEN}` : '');

/** Aperto dal browser di un altro dispositivo della rete (con la password). */
export const FROM_LAN = !TOKEN;

export async function api(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  // accesso dalla rete scaduto o password cambiata: si torna alla pagina di accesso
  if (res.status === 401 && data && data.login) { location.reload(); return new Promise(() => {}); }
  if (!res.ok) throw new Error((data && data.error) || `Errore ${res.status}`);
  return data;
}

/** Esce dall'accesso dalla rete (solo per i browser degli altri dispositivi). */
export async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* si ricarica comunque */ }
  location.reload();
}

export function cameraUrl(printerId) {
  return `/api/printers/${encodeURIComponent(printerId)}/camera${tokenQuery('?')}`;
}

export function fileUrl(name, kind) {
  return `/api/files/${encodeURIComponent(name)}/${kind}${tokenQuery('?')}`;
}

/** Carica un file nell'archivio con barra di avanzamento. */
export function uploadFile(file, onProgress) {
  return uploadTo('/files?name=' + encodeURIComponent(file.name), file, onProgress);
}

/** Invia un file a un indirizzo delle API (XHR supporta upload.onprogress). */
export function uploadTo(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    if (TOKEN) xhr.setRequestHeader('X-SonoPrint-Token', TOKEN);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignora */ }
      if (xhr.status === 401 && data && data.login) { location.reload(); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `Errore ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Caricamento non riuscito.'));
    xhr.send(file);
  });
}

// --- stato condiviso --------------------------------------------------------------

export const store = {
  connected: false,
  ready: false,
  printers: new Map(),
  order: [],
  files: [],
  settings: {},
  history: [],
  temps: {}, // id -> [samples]
  logs: {}, // id -> [entries]
  app: { current: '', status: 'unsupported' }, // versione e stato degli aggiornamenti
  network: null, // porta in uso e accesso dal telefono
  access: FROM_LAN ? 'lan' : 'local', // da dove è aperta l'interfaccia: questo computer o un browser della rete
  desktop: null, // app desktop: avvio con il computer e background (null nel browser senza app)
  interrupted: [], // stampe fermate dalla chiusura improvvisa precedente
};

const listeners = new Map(); // evento -> Set(fn)

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

function emit(event, ...args) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) { try { fn(...args); } catch (e) { console.error(e); } }
}

function setPrinters(list) {
  const ids = list.map((p) => p.id);
  store.printers = new Map(list.map((p) => [p.id, p]));
  store.order = ids;
  for (const id of Object.keys(store.temps)) if (!store.printers.has(id)) delete store.temps[id];
}

// --- WebSocket --------------------------------------------------------------------

let ws = null;
let retry = 0;
const logSubs = new Map(); // id -> numero di iscritti

export function connectSocket() {
  const url = `ws://${location.host}/ws${tokenQuery('?')}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    retry = 0;
    store.connected = true;
    emit('connection', true);
    for (const id of logSubs.keys()) ws.send(JSON.stringify({ type: 'subscribe-log', id }));
  };
  ws.onclose = () => {
    store.connected = false;
    emit('connection', false);
    // dalla rete, un rifiuto ripetuto può voler dire accesso scaduto: la prima richiesta lo scopre
    if (FROM_LAN && retry === 2) api('GET', '/network').catch(() => {});
    setTimeout(connectSocket, Math.min(5000, 500 * 2 ** retry++));
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handle(msg);
  };
}

function handle(msg) {
  switch (msg.type) {
    case 'hello':
      setPrinters(msg.printers);
      store.files = msg.files;
      store.settings = msg.settings;
      store.history = msg.history;
      store.temps = msg.temps || {};
      if (msg.app) store.app = msg.app;
      if (msg.network) store.network = msg.network;
      store.access = msg.access || 'local';
      store.desktop = msg.desktop || null;
      store.interrupted = msg.interrupted || [];
      store.ready = true;
      emit('printers');
      emit('files');
      emit('settings');
      emit('history');
      emit('app');
      emit('ready');
      break;
    case 'app':
      store.app = msg.app;
      emit('app');
      break;
    case 'network':
      store.network = msg.network;
      emit('network');
      break;
    case 'printers':
      setPrinters(msg.printers);
      emit('printers');
      break;
    case 'printer':
      if (!store.printers.has(msg.printer.id)) return;
      store.printers.set(msg.printer.id, msg.printer);
      emit('printer', msg.printer);
      break;
    case 'temp': {
      const arr = store.temps[msg.id] || (store.temps[msg.id] = []);
      arr.push(msg.sample);
      const cutoff = Date.now() - 30 * 60 * 1000;
      while (arr.length && arr[0].t < cutoff) arr.shift();
      emit('temp', msg.id, msg.sample);
      break;
    }
    case 'files':
      store.files = msg.files;
      emit('files');
      break;
    case 'settings':
      store.settings = msg.settings;
      if ('desktop' in msg) store.desktop = msg.desktop;
      emit('settings');
      break;
    case 'interrupted':
      store.interrupted = msg.interrupted || [];
      emit('interrupted');
      break;
    case 'history':
      store.history = msg.history;
      emit('history');
      break;
    case 'log-init':
      store.logs[msg.id] = msg.lines.slice();
      emit('log-init', msg.id);
      break;
    case 'log': {
      const arr = store.logs[msg.id] || (store.logs[msg.id] = []);
      arr.push(...msg.lines);
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
      emit('log', msg.id, msg.lines);
      break;
    }
    case 'notify':
      emit('notify', msg);
      break;
    default:
      break;
  }
}

export function subscribeLog(id) {
  logSubs.set(id, (logSubs.get(id) || 0) + 1);
  if (logSubs.get(id) === 1 && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe-log', id }));
  return () => {
    const n = (logSubs.get(id) || 1) - 1;
    if (n <= 0) {
      logSubs.delete(id);
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'unsubscribe-log', id }));
    } else logSubs.set(id, n);
  };
}

export function printerList() {
  return store.order.map((id) => store.printers.get(id)).filter(Boolean);
}

export function fileByName(name) {
  const exact = store.files.find((f) => f.name === name);
  if (exact || !name) return exact || null;
  // le stampanti in rete a volte riportano il nome senza estensione
  const base = (n) => String(n).replace(/(\.gcode)?\.3mf$|\.(gcode|gco|g)$/i, '');
  return store.files.find((f) => base(f.name) === base(name)) || null;
}
