'use strict';

// Unità rimovibili (schede SD, chiavette) per copiare il firmware delle schede a 32 bit.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function listRemovableDrives() {
  if (process.platform !== 'win32') return Promise.resolve([]);
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

/**
 * Copia il firmware nella radice dell'unità.
 * naming: 'firmware' (nome fisso firmware.bin: BTT, MKS) oppure 'unique' (nome sempre diverso: Creality 4.2.x).
 */
async function copyFirmwareToDrive(drive, srcPath, naming) {
  if (!/^[A-Z]:$/i.test(String(drive))) throw new Error('Unità non valida.');
  const drives = await listRemovableDrives();
  if (!drives.some((d) => d.drive.toUpperCase() === drive.toUpperCase())) {
    throw new Error(`L'unità ${drive} non è una scheda SD o una chiavetta collegata a questo PC.`);
  }
  const root = drive.toUpperCase() + '\\';
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
  return { drive: drive.toUpperCase(), name };
}

module.exports = { listRemovableDrives, copyFirmwareToDrive };
