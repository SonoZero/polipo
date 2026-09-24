'use strict';

// Trasporti: porta seriale reale (USB) oppure stampante virtuale.
// Entrambi espongono open() / write(line) / close() e l'evento 'line'.

const { EventEmitter } = require('events');
const { VirtualPrinter } = require('./virtual-printer');

const VIRTUAL_PORT = 'VIRTUAL';

let serialportModule = null;
function serialport() {
  if (!serialportModule) serialportModule = require('serialport');
  return serialportModule;
}

class SerialTransport extends EventEmitter {
  constructor(path, baudRate) {
    super();
    this.path = path;
    this.baudRate = baudRate;
    this.port = null;
  }

  open() {
    const { SerialPort, ReadlineParser } = serialport();
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false });
      port.open((err) => {
        if (err) return reject(new Error(friendlySerialError(err, this.path)));
        this.port = port;
        const parser = port.pipe(new ReadlineParser({ delimiter: '\n', encoding: 'latin1' }));
        parser.on('data', (line) => this.emit('line', String(line).replace(/\r$/, '')));
        port.on('close', () => this.emit('close'));
        port.on('error', (e) => this.emit('error', e));
        resolve();
      });
    });
  }

  write(line) {
    if (!this.port || !this.port.isOpen) return false;
    this.port.write(line + '\n', 'latin1');
    return true;
  }

  close() {
    return new Promise((resolve) => {
      const port = this.port;
      this.port = null;
      if (!port || !port.isOpen) return resolve();
      port.removeAllListeners('close');
      port.close(() => resolve());
    });
  }
}

class VirtualTransport extends EventEmitter {
  constructor(options) {
    super();
    this.options = options || {};
    this.printer = null;
  }

  open() {
    this.printer = new VirtualPrinter(this.options);
    this.printer.on('line', (l) => this.emit('line', l));
    this.printer.start();
    return Promise.resolve();
  }

  write(line) {
    if (!this.printer) return false;
    this.printer.write(line);
    return true;
  }

  close() {
    if (this.printer) {
      this.printer.stop();
      this.printer.removeAllListeners();
      this.printer = null;
    }
    return Promise.resolve();
  }
}

function friendlySerialError(err, path) {
  const msg = String(err && err.message || err);
  if (/Access denied|access is denied|EACCES|Accesso negato/i.test(msg)) {
    return `La porta ${path} è già in uso da un altro programma (Cura, PrusaSlicer, Arduino IDE…?). Chiudilo e riprova.`;
  }
  if (/File not found|cannot find|ENOENT|Impossibile trovare/i.test(msg)) {
    return `La porta ${path} non esiste più: la stampante è stata scollegata?`;
  }
  return `Impossibile aprire ${path}: ${msg}`;
}

async function listPorts() {
  const { SerialPort } = serialport();
  let ports = [];
  try {
    ports = await SerialPort.list();
  } catch (_) {
    ports = [];
  }
  if (process.platform === 'darwin') {
    // su macOS ogni porta c'è due volte: si usa /dev/cu.* (la /dev/tty.* aspetta un segnale che le stampanti non danno)
    ports = ports
      .map((p) => ({ ...p, path: String(p.path).replace(/^\/dev\/tty\./, '/dev/cu.') }))
      .filter((p, i, all) => all.findIndex((q) => q.path === p.path) === i)
      .filter((p) => !/Bluetooth-Incoming-Port|debug-console|wlan-debug/i.test(p.path));
  }
  const out = ports.map((p) => ({
    path: p.path,
    label: p.friendlyName || [p.manufacturer, p.path].filter(Boolean).join(' '),
    manufacturer: p.manufacturer || null,
    vendorId: p.vendorId || null,
    productId: p.productId || null,
    likelyPrinter: isLikelyPrinter(p),
  }));
  out.sort((a, b) => (b.likelyPrinter - a.likelyPrinter) || a.path.localeCompare(b.path, undefined, { numeric: true }));
  out.push({ path: VIRTUAL_PORT, label: 'Stampante virtuale (simulazione)', virtual: true });
  return out;
}

// Chip USB-seriale usati dalle schede delle stampanti 3D
const PRINTER_USB_IDS = new Set([
  '1a86', // CH340/CH341 (Creality, Anycubic, …)
  '0403', // FTDI
  '10c4', // CP210x
  '2341', '2a03', '1b4f', // Arduino / Mega 2560
  '0483', // STM32 (SKR, Creality 32 bit)
  '1d50', // OpenMoko (Marlin/Klipper USB)
  '2c99', // Prusa Research
  '16c0', // Teensy / Printrboard
  '1eaf', // Maple
  '2e8a', // Raspberry Pi RP2040
]);

function isLikelyPrinter(p) {
  return !!(p.vendorId && PRINTER_USB_IDS.has(String(p.vendorId).toLowerCase()));
}

function createTransport(port, baudRate, virtualOptions) {
  if (port === VIRTUAL_PORT) return new VirtualTransport(virtualOptions);
  return new SerialTransport(port, baudRate);
}

module.exports = { createTransport, listPorts, VIRTUAL_PORT, SerialTransport, VirtualTransport };
