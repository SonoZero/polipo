# Crediti e licenze di terze parti

SonoPrint (licenza MIT, vedi [LICENSE](LICENSE)) include o usa i seguenti lavori di altri.

## Inclusi nell'app

### Icone Phosphor

Le icone in `src/web/js/icons.js` vengono da [Phosphor Icons](https://phosphoricons.com) (`@phosphor-icons/core`).

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Three.js

L'anteprima 3D usa [Three.js](https://threejs.org) (`src/web/vendor/three/`), Copyright 2010-2026 three.js authors, con licenza MIT. Il testo completo è in [`src/web/vendor/three/LICENSE`](src/web/vendor/three/LICENSE).

### Font Geist e Geist Mono

Copyright 2024 The Geist Project Authors ([vercel/geist-font](https://github.com/vercel/geist-font)), con licenza SIL Open Font License 1.1. Il testo completo è in [`src/web/fonts/OFL.txt`](src/web/fonts/OFL.txt).

### Certificati di Bambu Lab

`src/server/printers/certs/bambu-ca.pem` contiene i certificati **pubblici** delle autorità di Bambu Lab, raccolti dai progetti [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) e [ha-bambulab](https://github.com/greghesp/ha-bambulab). Servono solo a verificare che dall'altra parte ci sia davvero una stampante Bambu Lab.

## Librerie npm

Installate con l'app, ognuna con la propria licenza (inclusa nel suo pacchetto):

| Libreria | Licenza | Uso |
| --- | --- | --- |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | aggiornamenti automatici |
| [serialport](https://serialport.io) | MIT | stampanti USB |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket (interfaccia e Moonraker) |
| [mqtt](https://github.com/mqttjs/MQTT.js) | MIT | stampanti Bambu Lab |
| [basic-ftp](https://github.com/patrickjuchli/basic-ftp) | MIT | file sulla scheda SD delle Bambu Lab |
| [multicast-dns](https://github.com/mafintosh/multicast-dns) | MIT | ricerca di OctoPrint e Klipper in rete |
| [qrcode](https://github.com/soldair/node-qrcode) | MIT | QR code per l'abbinamento del telefono |

L'app desktop è costruita con [Electron](https://www.electronjs.org) (MIT) ed [electron-builder](https://www.electron.build) (MIT).

## Protocolli documentati da altri

SonoPrint parla con le stampanti in rete seguendo la documentazione pubblica dei protocolli. Nessun codice è stato copiato da questi progetti:

- [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) e [ha-bambulab](https://github.com/greghesp/ha-bambulab) per Bambu Lab (MQTT, FTPS, telecamera, SSDP);
- [documentazione di Moonraker](https://moonraker.readthedocs.io) per Klipper;
- [documentazione dell'API di OctoPrint](https://docs.octoprint.org/en/master/api/);
- [Prusa-Firmware-Buddy](https://github.com/prusa3d/Prusa-Firmware-Buddy) e la documentazione di PrusaLink.

Bambu Lab, Prusa, Klipper, OctoPrint e gli altri nomi citati sono marchi dei rispettivi proprietari. SonoPrint non è affiliato a nessuno di loro.
