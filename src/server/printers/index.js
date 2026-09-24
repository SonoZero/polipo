'use strict';

// Tipi di stampante supportati e creazione dell'oggetto giusto per ogni configurazione.

const { MarlinPrinter } = require('./marlin');
const { BambuPrinter } = require('./bambu');
const { KlipperPrinter } = require('./klipper');
const { PrusaLinkPrinter } = require('./prusalink');
const { OctoPrintPrinter } = require('./octoprint');

const TYPES = {
  usb: MarlinPrinter,
  bambu: BambuPrinter,
  klipper: KlipperPrinter,
  prusalink: PrusaLinkPrinter,
  octoprint: OctoPrintPrinter,
};

const TYPE_NAMES = Object.keys(TYPES);

function createPrinter(config, deps) {
  const Cls = TYPES[config.type] || MarlinPrinter;
  return new Cls(config, deps);
}

module.exports = { createPrinter, TYPES, TYPE_NAMES };
