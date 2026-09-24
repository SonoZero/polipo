'use strict';

// Genera le icone dell'app per il telefono (mobile/assets) dal logo di Polipo.
//   npx electron scripts/make-mobile-icons.js

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'mobile', 'assets');
const DESKTOP_SVG = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'img', 'icon.svg'), 'utf8');

// sagoma del polipo (coordinate 0..64, come icon.svg)
const BODY = 'M32 11c-9.4 0-16 6.9-16 15.6 0 4.6 1.9 8.3 4.6 10.9-.9 4.5-3.2 7.6-6.6 9.4 4.6 1.6 9.1-.4 11.6-3.6.3 5.1-1.4 8.6-4 11 5 .3 8.4-3.2 9.3-7.6.3 0 .7.1 1.1.1s.8 0 1.1-.1c.9 4.4 4.3 7.9 9.3 7.6-2.6-2.4-4.3-5.9-4-11 2.5 3.2 7 5.2 11.6 3.6-3.4-1.8-5.7-4.9-6.6-9.4 2.7-2.6 4.6-6.3 4.6-10.9C48 17.9 41.4 11 32 11z';
const GRADIENT = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fb923c"/><stop offset="1" stop-color="#ea580c"/></linearGradient></defs>';
const EYES = '<circle cx="26" cy="27" r="3.2" fill="#9a3412"/><circle cx="38" cy="27" r="3.2" fill="#9a3412"/><circle cx="27" cy="26" r="1" fill="#fff"/><circle cx="39" cy="26" r="1" fill="#fff"/>';

// il polipo ridimensionato attorno al centro (per le aree sicure di Android)
const octopus = (scale, eyes = true, fill = '#fff') =>
  `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)"><path d="${BODY}" fill="${fill}"/>${eyes ? EYES : ''}</g>`;
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${inner}</svg>`;

const ICONS = [
  // iOS: quadrato pieno senza trasparenza (gli angoli li arrotonda il sistema)
  { file: 'icon.png', size: 1024, svg: svg(`${GRADIENT}<rect width="64" height="64" fill="url(#g)"/>${octopus(1.05)}`) },
  { file: 'android-icon-foreground.png', size: 1024, svg: svg(octopus(0.62)) },
  { file: 'android-icon-background.png', size: 1024, svg: svg(`${GRADIENT}<rect width="64" height="64" fill="url(#g)"/>`) },
  { file: 'android-icon-monochrome.png', size: 1024, svg: svg(octopus(0.62, false)) },
  { file: 'splash-icon.png', size: 1024, svg: DESKTOP_SVG },
  { file: 'favicon.png', size: 48, svg: DESKTOP_SVG },
];

app.whenReady().then(async () => {
  setTimeout(() => { console.error('Timeout'); app.exit(1); }, 30000);
  const win = new BrowserWindow({ show: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  fs.mkdirSync(OUT, { recursive: true });
  for (const icon of ICONS) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = ${icon.size}; c.height = ${icon.size};
        c.getContext('2d').drawImage(img, 0, 0, ${icon.size}, ${icon.size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('SVG non valido'));
      img.src = 'data:image/svg+xml;base64,${Buffer.from(icon.svg).toString('base64')}';
    })`);
    fs.writeFileSync(path.join(OUT, icon.file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('Creato', icon.file);
  }
  app.exit(0);
});
