'use strict';

// Unità rimovibili (schede SD, chiavette) per copiare il firmware delle schede a 32 bit.
// Windows: dischi rimovibili (lettere di unità). Mac: volumi in /Volumes che si possono espellere.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function listRemovableDrives() {
  if (process.platform === 'win32') return listWindows();
  if (process.platform === 'darwin') return listMac();
  return Promise.resolve([]);
}

function listWindows() {
  const script = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object DeviceID,VolumeName,FreeSpace,Size,FileSystem | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      let data;
      try { data = JSON.parse(String(stdout).trim() || '[]'); } catch (_) { return resolve([]); }
      const list = (Array.isArray(data) ? data : [data]).filter((d) => d && d.DeviceID && d.Size);
      resolve(list.map((d) => ({
        drive: d.DeviceID,
        label: d.VolumeName || 'Disco rimovibile',
        size: d.Size || null,
        free: d.FreeSpace || null,
        fileSystem: d.FileSystem || null,
      })));
    });
  });
}

async function listMac() {
  let names = [];
  try { names = fs.readdirSync('/Volumes'); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const vol = path.join('/Volumes', name);
    try {
      if (fs.realpathSync(vol) === '/') continue; // il disco di sistema
      const info = await diskInfo(vol);
      if (!info.ejectable && !info.removable) continue;
      const st = fs.statfsSync(vol);
      out.push({ drive: vol, label: name, size: st.blocks * st.bsize, free: st.bavail * st.bsize, fileSystem: info.fileSystem });
    } catch (_) { /* volume non leggibile: si salta */ }
  }
  return out;
}

/** Dati di un volume da `diskutil info -plist` (espellibile, rimovibile, file system). */
function diskInfo(vol) {
  return new Promise((resolve) => {
    execFile('diskutil', ['info', '-plist', vol], { timeout: 10000 }, (err, stdout) => {
      const xml = err ? '' : String(stdout);
      const bool = (key) => new RegExp(`<key>${key}</key>\\s*<true/>`).test(xml);
      const str = (key) => { const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml); return m ? m[1] : null; };
      resolve({
        ejectable: bool('Ejectable'),
        removable: bool('RemovableMedia') || bool('RemovableMediaOrExternalDevice'),
        fileSystem: str('FilesystemName') || str('FilesystemType'),
      });
    });
  });
}

/**
 * Copia il firmware nella radice dell'unità.
 * naming: 'firmware' (nome fisso firmware.bin: BTT, MKS) oppure 'unique' (nome sempre diverso: Creality 4.2.x).
 */
async function copyFirmwareToDrive(drive, srcPath, naming) {
  const value = String(drive || '');
  const validFormat = process.platform === 'darwin' ? /^\/Volumes\/[^/]+$/.test(value) : /^[A-Z]:$/i.test(value);
  if (!validFormat) throw new Error('Unità non valida.');
  const drives = await listRemovableDrives();
  const found = drives.find((d) => d.drive.toUpperCase() === value.toUpperCase());
  if (!found) throw new Error(`L'unità ${value} non è una scheda SD o una chiavetta collegata a questo computer.`);
  const root = process.platform === 'win32' ? found.drive.toUpperCase() + '\\' : found.drive;
  let name = 'firmware.bin';
  if (naming === 'unique') {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    name = `firmware-${stamp}.bin`;
  }
  const dest = path.join(root, name);
  await fs.promises.copyFile(srcPath, dest);
  const a = fs.statSync(srcPath).size;
  const b = fs.statSync(dest).size;
  if (a !== b) throw new Error('La copia sulla scheda SD è incompleta: riprova.');
  return { drive: process.platform === 'win32' ? found.drive.toUpperCase() : found.drive, name };
}

module.exports = { listRemovableDrives, copyFirmwareToDrive };
