'use strict';

// Stampanti in rete finte sul PC, per provare SonoPrint senza stampanti vere:
//   node scripts/fake-printers.js
// Bambu Lab P1S (MQTT 8883, FTPS 990, telecamera 6000, annunci SSDP), Klipper (7125),
// OctoPrint (5000) e PrusaLink (80, oppure 8080 se la 80 è occupata).

const dgram = require('dgram');
const { startFakeBambu, SERIAL } = require('../test/fakes/bambu');
const { startFakeMoonraker, startFakePrusaLink, startFakeOctoPrint } = require('../test/fakes/http-printers');

async function tryStart(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.log(`${label}: non avviata (${err.code || err.message})`);
    return null;
  }
}

(async () => {
  const bambu = await tryStart('Bambu Lab', () => startFakeBambu({ mqttPort: 8883, ftpPort: 990, cameraPort: 6000, stepMs: 5000 }));
  const klipper = await tryStart('Klipper', () => startFakeMoonraker({ port: 7125, stepMs: 4000 }));
  const octo = (await tryStart('OctoPrint (5000)', () => startFakeOctoPrint({ port: 5000, stepMs: 4000 })))
    || await tryStart('OctoPrint (5080)', () => startFakeOctoPrint({ port: 5080, stepMs: 4000 }));
  const prusa = (await tryStart('PrusaLink (80)', () => startFakePrusaLink({ port: 80, stepMs: 4000 })))
    || await tryStart('PrusaLink (8080)', () => startFakePrusaLink({ port: 8080, stepMs: 4000 }));

  if (bambu) {
    console.log(`Bambu Lab P1S   127.0.0.1  codice ${bambu.accessCode}  seriale ${SERIAL}`);
    const s = dgram.createSocket('udp4');
    const notify = Buffer.from([
      'NOTIFY * HTTP/1.1', 'HOST: 239.255.255.250:1990', 'Location: 127.0.0.1',
      'NT: urn:bambulab-com:device:3dprinter:1', `USN: ${SERIAL}`, 'DevModel.bambu.com: C12',
      'DevName.bambu.com: P1S di prova', 'DevConnect.bambu.com: lan', '', '',
    ].join('\r\n'));
    setInterval(() => { for (const port of [2021, 1990]) s.send(notify, port, '127.0.0.1', () => {}); }, 2000);
  }
  if (klipper) console.log(`Klipper         127.0.0.1:${klipper.port}`);
  if (octo) console.log(`OctoPrint       127.0.0.1:${octo.port}  chiave ${octo.apiKey}`);
  if (prusa) console.log(`PrusaLink       127.0.0.1:${prusa.port}  utente maker, password ${prusa.password}`);
  console.log('Ctrl+C per fermarle.');
})();
