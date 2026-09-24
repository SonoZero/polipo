'use strict';

// Copia nell'interfaccia le icone Phosphor usate, i font Geist e Three.js (da node_modules),
// così l'app funziona senza internet. Da rilanciare dopo aver aggiunto un'icona:
//   node scripts/build-assets.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const WEB = path.join(ROOT, 'src', 'web');

// nome usato nell'interfaccia -> nome dell'icona Phosphor
const ICONS = {
  grid: 'squares-four',
  file: 'file',
  files: 'files',
  history: 'clock-counter-clockwise',
  settings: 'gear-six',
  plus: 'plus',
  printer: 'printer',
  cube: 'cube',
  play: 'play',
  pause: 'pause',
  stop: 'stop',
  x: 'x',
  home: 'house',
  up: 'caret-up',
  down: 'caret-down',
  left: 'caret-left',
  right: 'caret-right',
  thermo: 'thermometer-simple',
  bed: 'waves',
  fan: 'fan',
  terminal: 'terminal-window',
  camera: 'camera',
  trash: 'trash',
  upload: 'upload-simple',
  download: 'download-simple',
  refresh: 'arrow-clockwise',
  plug: 'plug',
  unplug: 'plugs',
  alert: 'warning',
  check: 'check',
  checkCircle: 'check-circle',
  layers: 'stack',
  edit: 'pencil-simple',
  eye: 'eye',
  eyeOff: 'eye-slash',
  clock: 'clock',
  flag: 'flag-checkered',
  zap: 'lightning',
  power: 'power',
  droplet: 'drop',
  spool: 'disc',
  send: 'paper-plane-right',
  more: 'dots-three',
  search: 'magnifying-glass',
  motor: 'engine',
  target: 'crosshair',
  sun: 'sun',
  moon: 'moon',
  monitor: 'monitor',
  gauge: 'gauge',
  wifi: 'wifi-high',
  usb: 'usb',
  network: 'network',
  light: 'lightbulb',
  speed: 'speedometer',
  menu: 'list',
  chip: 'cpu',
  key: 'key',
  qr: 'qr-code',
  info: 'info',
  link: 'link-simple',
  external: 'arrow-square-out',
  broadcast: 'broadcast',
  phone: 'device-mobile',
  shield: 'shield-check',
  drive: 'hard-drive',
  copy: 'copy',
  fire: 'fire',
  sliders: 'sliders-horizontal',
  code: 'code',
};

function buildIcons() {
  const dir = path.join(NM, '@phosphor-icons', 'core', 'assets', 'regular');
  const out = {};
  for (const [name, phosphor] of Object.entries(ICONS)) {
    const svg = fs.readFileSync(path.join(dir, phosphor + '.svg'), 'utf8');
    const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)[1].trim();
    out[name] = inner;
  }
  const lines = Object.entries(out).map(([k, v]) => `  ${k}: '${v.replace(/'/g, "\\'")}',`);
  const js = `// Generato da scripts/build-assets.js: icone Phosphor (licenza MIT), peso "regular".\n\nexport const ICONS = {\n${lines.join('\n')}\n};\n`;
  fs.writeFileSync(path.join(WEB, 'js', 'icons.js'), js);
  console.log(`icone: ${Object.keys(out).length}`);
}

function copyFonts() {
  const dest = path.join(WEB, 'fonts');
  fs.mkdirSync(dest, { recursive: true });
  const files = [
    ['@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', 'geist-latin.woff2'],
    ['@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2', 'geist-latin-ext.woff2'],
    ['@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2', 'geist-mono-latin.woff2'],
  ];
  for (const [src, name] of files) fs.copyFileSync(path.join(NM, src), path.join(dest, name));
  fs.copyFileSync(path.join(NM, '@fontsource-variable/geist/LICENSE'), path.join(dest, 'OFL.txt'));
  console.log(`font: ${files.length}`);
}

// Three.js per l'anteprima 3D: senza bundler, quindi gli import di "three" diventano percorsi relativi
function copyThree() {
  const dest = path.join(WEB, 'vendor', 'three');
  fs.mkdirSync(dest, { recursive: true });
  const src = path.join(NM, 'three');
  fs.copyFileSync(path.join(src, 'build', 'three.module.js'), path.join(dest, 'three.module.js'));
  fs.copyFileSync(path.join(src, 'build', 'three.core.js'), path.join(dest, 'three.core.js'));
  const orbit = fs.readFileSync(path.join(src, 'examples', 'jsm', 'controls', 'OrbitControls.js'), 'utf8')
    .replace(/from ['"]three['"]/g, "from './three.module.js'");
  fs.writeFileSync(path.join(dest, 'OrbitControls.js'), '// Three.js OrbitControls, licenza MIT (vedi LICENSE)\n' + orbit);
  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dest, 'LICENSE'));
  console.log('three: ' + require(path.join(src, 'package.json')).version);
}

buildIcons();
copyFonts();
copyThree();
