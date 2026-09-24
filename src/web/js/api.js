// Comunicazione con il servizio Polipo: API REST + WebSocket, e stato condiviso.

const TOKEN = document.querySelector('meta[name="polipo-token"]').content;

export async function api(method, path, body) {
  const opts = { method, headers: { 'X-Polipo-Token': TOKEN } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || `Errore ${res.status}`);
  return data;
}

export function fileUrl(name, kind) {
  return `/api/files/${encodeURIComponent(name)}/${kind}?token=${TOKEN}`;
}

/** Carica un file con barra di avanzamento (XHR supporta upload.onprogress). */
export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Polipo-Token', TOKEN);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignora */ }
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
  const url = `ws://${location.host}/ws?token=${TOKEN}`;
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
      emit('settings');
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
  return store.files.find((f) => f.name === name) || null;
}
