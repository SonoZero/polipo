'use strict';

// Richieste HTTP verso le stampanti in rete: JSON, autenticazione Digest
// (PrusaLink) e caricamento di file grandi in streaming con avanzamento.

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

class HttpClient {
  /**
   * @param {object} opts { base: 'http://host:port', headers, digest: { username, password } }
   */
  constructor(opts) {
    this.base = opts.base.replace(/\/+$/, '');
    this.headers = opts.headers || {};
    this.digest = opts.digest || null;
    this._challenge = null;
    this._nc = 0;
  }

  url(path) {
    return this.base + path;
  }

  async json(method, path, body, opts = {}) {
    const res = await this.request(method, path, {
      ...opts,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(opts.headers || {}) },
    });
    return res;
  }

  /** Esegue una richiesta; ritorna { status, headers, text, data } (data = JSON se possibile). */
  async request(method, path, opts = {}) {
    let res = await this._send(method, path, opts);
    if (res.status === 401 && this.digest && /digest/i.test(res.headers['www-authenticate'] || '')) {
      this._challenge = parseChallenge(res.headers['www-authenticate']);
      this._nc = 0;
      res = await this._send(method, path, opts);
    }
    return res;
  }

  _authHeader(method, path) {
    if (!this.digest || !this._challenge) return {};
    const c = this._challenge;
    const { username, password } = this.digest;
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${username}:${c.realm}:${password}`);
    const ha2 = md5(`${method}:${path}`);
    const parts = [`username="${username}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${path}"`];
    let response;
    if (c.qop && /auth/.test(c.qop)) {
      const nc = (++this._nc).toString(16).padStart(8, '0');
      const cnonce = crypto.randomBytes(8).toString('hex');
      response = md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:auth:${ha2}`);
      parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
    } else {
      response = md5(`${ha1}:${c.nonce}:${ha2}`);
    }
    parts.push(`response="${response}"`);
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
    return { Authorization: 'Digest ' + parts.join(', ') };
  }

  _send(method, path, opts) {
    const target = new URL(this.url(path));
    const lib = target.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', ...this.headers, ...this._authHeader(method, target.pathname + target.search), ...(opts.headers || {}) };
    const body = opts.body;
    if (typeof body === 'string' || Buffer.isBuffer(body)) headers['Content-Length'] = Buffer.byteLength(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(target, { method, headers, timeout: opts.timeout || 8000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (text) { try { data = JSON.parse(text); } catch (_) { data = null; } }
          resolve({ status: res.statusCode, headers: res.headers, text, data });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      if (opts.stream) {
        opts.stream(req);
      } else {
        if (body !== undefined) req.write(body);
        req.end();
      }
    });
  }

  /**
   * Carica un file in streaming.
   * @param {object} o { method, path, filePath, fileName, multipart: { fileField, fields } | null,
   *                     headers, onProgress(frazione), timeout }
   */
  async upload(o) {
    const size = fs.statSync(o.filePath).size;
    const boundary = '----sonoprint' + crypto.randomBytes(12).toString('hex');
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    const headers = { ...(o.headers || {}) };
    if (o.multipart) {
      const parts = [];
      for (const [k, v] of Object.entries(o.multipart.fields || {})) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
      }
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${o.multipart.fileField || 'file'}"; filename="${o.fileName.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      head = Buffer.from(parts.join(''), 'utf8');
      tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/octet-stream';
    }
    headers['Content-Length'] = head.length + size + tail.length;

    // con il Digest serve prima una sfida valida: una richiesta leggera la ottiene
    if (this.digest && !this._challenge) await this.request('GET', o.probePath || '/api/version');

    const res = await this._send(o.method || 'POST', o.path, {
      headers,
      timeout: o.timeout || 120000,
      stream: (req) => {
        let sent = 0;
        req.write(head);
        const rs = fs.createReadStream(o.filePath, { highWaterMark: 256 * 1024 });
        rs.on('data', (chunk) => {
          sent += chunk.length;
          if (!req.write(chunk)) {
            rs.pause();
            req.once('drain', () => rs.resume());
          }
          if (o.onProgress) o.onProgress(size ? sent / size : 1);
        });
        rs.on('end', () => { req.write(tail); req.end(); });
        rs.on('error', (e) => req.destroy(e));
      },
    });
    return res;
  }
}

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
  let m;
  while ((m = re.exec(header))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

/** Messaggio comprensibile per gli errori di rete più comuni. */
function networkError(err, host) {
  const code = err && (err.code || (err.cause && err.cause.code));
  if (code === 'ECONNREFUSED') return `La stampante all'indirizzo ${host} rifiuta la connessione: controlla indirizzo e porta.`;
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN' || /timeout/i.test(String(err && err.message))) {
    return `La stampante all'indirizzo ${host} non risponde. È accesa e collegata alla stessa rete del computer?`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `L'indirizzo ${host} non esiste nella rete.`;
  return `Errore di rete con ${host}: ${err && err.message ? err.message : err}`;
}

/** "http://192.168.1.5:7125/" o "192.168.1.5" -> { host: '192.168.1.5', port: 7125 | null } */
function parseHost(input) {
  let s = String(input || '').trim();
  if (!s) return { host: '', port: null };
  s = s.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(s);
  if (!m) return { host: s, port: null };
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : null };
}

function hostLabel(host, port) {
  return port ? `${host}:${port}` : host;
}

module.exports = { HttpClient, networkError, parseHost, hostLabel, parseChallenge };
