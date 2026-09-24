'use strict';

// Converte src/web/img/icon.svg in build/icon.png (512x512) usando Electron.
//   npx electron scripts/make-icon.js

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SIZE = 512;
const out = path.join(__dirname, '..', 'build', 'icon.png');

app.whenReady().then(async () => {
  setTimeout(() => { console.error('Timeout: icona non generata'); app.exit(1); }, 20000);
  const svg = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'img', 'icon.svg'));
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false },
  });
  // l'SVG viene disegnato su un canvas e restituito come PNG con trasparenza
  await win.loadURL('data:text/html,<html><body></body></html>');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${SIZE}; c.height = ${SIZE};
      c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG non valido'));
    img.src = 'data:image/svg+xml;base64,${svg.toString('base64')}';
  })`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('Creato', out);
  app.exit(0);
});
