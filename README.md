# SonoPrint

**SonoPrint** (prima si chiamava Polipo) è un'app per Windows che controlla **più stampanti 3D contemporaneamente**, in stile [OctoPrint](https://octoprint.org): via USB oppure in rete (Bambu Lab, Klipper, PrusaLink e OctoPrint).

*made by sonozero*

## Cosa sa fare

- **Più stampanti insieme**, anche di tipi diversi: ognuna con la sua connessione, la sua stampa e le sue impostazioni. La *Panoramica* le mostra tutte.
- **Stampanti in rete con ricerca automatica**: SonoPrint trova da solo le Bambu Lab, le stampanti Klipper, PrusaLink e OctoPrint nella rete di casa; basta premere **Aggiungi**.
- **Stampanti USB**: elenca le porte COM, segnala quelle che sembrano stampanti (CH340, FTDI, STM32, Prusa...) e trova da solo il baudrate. Invio del G-code riga per riga con numeri di riga, checksum e reinvio automatico delle righe corrotte.
- **Aggiornamento del firmware e del software** per ogni tipo di stampante (vedi sotto).
- **Pausa e ripresa sicure**, **annullamento** con script configurabile e **arresto di emergenza**.
- **Temperature** in tempo reale con grafico e preriscaldamento rapido (PLA, PETG, ABS, TPU... personalizzabili).
- **Controllo manuale**: movimento X/Y/Z, home, estrusione, ventola, velocità, flusso e cambio filamento.
- **Terminale** G-code con cronologia dei comandi.
- **Archivio file** condiviso da tutte le stampanti: `.gcode` e progetti `.gcode.3mf` di Bambu Studio e OrcaSlicer, con miniatura, tempo stimato, filamento, layer e ingombro.
- **Anteprima G-code** layer per layer che segue la stampa in corso.
- **Tempo rimanente e ora di fine**.
- **Telecamere**: webcam USB, flussi MJPEG/snapshot di rete, telecamera integrata delle Bambu P1 e A1 e telecamere di Klipper.
- **Cronologia** delle stampe con statistiche, **notifiche di Windows** a fine stampa, blocco della **sospensione** del PC durante le stampe USB.
- **Accesso dal telefono** con QR code e chiave segreta.
- **Temi chiaro e scuro**, interfaccia che funziona anche senza internet.
- **Stampante virtuale** che simula un firmware Marlin, per provare tutto senza stampante.

## Stampanti supportate

| Tipo | Cosa serve |
| --- | --- |
| **USB** (Marlin, Prusa, RepRapFirmware e derivati) | Cavo USB. Le stampe partono dal PC: se chiudi SonoPrint o il PC va in sospensione, la stampa si ferma. |
| **Bambu Lab** (X1, P1, A1) | Sulla stampante attiva la **Modalità solo LAN** e la **Modalità sviluppatore**; servono indirizzo IP e codice di accesso LAN. |
| **Klipper** (Moonraker, come Mainsail e Fluidd) | Indirizzo della stampante; la chiave API solo se Moonraker la richiede. |
| **PrusaLink** (MK4, MK3.9, Core One, MINI+, XL) | Indirizzo, nome utente e password da *Impostazioni > Rete > PrusaLink* sulla stampante. PrusaLink non permette di muovere gli assi né di impostare le temperature. |
| **OctoPrint** | Indirizzo e chiave API: premi **Chiedi l'accesso** e conferma nella pagina di OctoPrint. |

Le stampanti in rete continuano a stampare da sole anche se chiudi SonoPrint.

## Uso

1. Apri SonoPrint e premi **Aggiungi stampante**: in alto compaiono quelle trovate in rete, altrimenti scegli il tipo e compila i dati.
2. Carica un file `.gcode` o `.gcode.3mf` nella pagina **File** (o trascinalo).
3. Premi **Stampa su...** e scegli la stampante, oppure dalla pagina della stampante **Scegli file da stampare**.

Se una stampante USB non si connette:
- chiudi Cura, PrusaSlicer, Arduino IDE o altri programmi che usano la stessa porta COM;
- installa il driver CH340 se la porta non compare (schede Creality e Anycubic più vecchie);
- prova un altro baudrate (le Anycubic i3 Mega usano 250000, quasi tutte le altre 115200).

## Aggiornamento del firmware

Dalla pagina di ogni stampante, scheda **Firmware**:

- **USB, schede a 8 bit** (ATmega2560, 1284P, 328P con bootloader): SonoPrint scrive il file `.hex` via USB e rilegge ogni pagina per verificarla.
- **USB, schede a 32 bit**: copia il file `.bin` sulla scheda SD con il nome giusto; al riavvio la stampante lo installa.
- **Bambu Lab**: aggiornamento offline tramite scheda microSD nella stampante (le P1 devono avere almeno il firmware 01.07, le A1 almeno il 01.04).
- **Klipper**: update manager di Moonraker (Klipper, Moonraker, interfacce e sistema).
- **PrusaLink** e **OctoPrint**: controllo della versione e aggiornamento del software di OctoPrint.

Per Marlin e Prusa SonoPrint confronta la versione installata con l'ultima pubblicata su GitHub.

## Accesso dal telefono

In **Impostazioni > Accesso dal telefono** SonoPrint si apre alla rete di casa e mostra un QR code da inquadrare con l'app per il telefono.

- L'accesso è protetto da una **chiave segreta** casuale contenuta nel QR code; si può rigenerare in qualsiasi momento (i telefoni abbinati andranno riabbinati).
- Dalla rete si raggiungono solo le API per l'app: la pagina web di SonoPrint, la porta e le impostazioni di rete restano accessibili **solo dal PC**.
- Al primo avvio Windows può chiedere di consentire l'accesso alla rete: scegli **Reti private**.
- **Fuori casa**: installa [Tailscale](https://tailscale.com/download) su PC e telefono; è più sicuro che aprire porte sul router.

## Aggiornamenti dell'app

La versione installata (`SonoPrint-Setup-x.y.z.exe`) si aggiorna da sola dalle [Release di GitHub](../../releases):

- controlla all'avvio e ogni 6 ore (o da **Impostazioni > Aggiornamenti > Controlla ora**);
- scarica la nuova versione in background e mostra **Riavvia e aggiorna** nella barra laterale;
- se una stampa USB è in corso non interrompe nulla: l'aggiornamento si installa a fine stampa o alla chiusura dell'app.

Chi ha installato Polipo riceve l'aggiornamento a SonoPrint come un normale aggiornamento; stampanti, file e cronologia vengono copiati alla prima apertura.

La versione portable (`SonoPrint-Portable-x.y.z.exe`) non può sostituirsi da sola: avvisa quando esce una nuova versione e apre la pagina di download.

### Pubblicare una nuova versione

```bash
npm version minor        # 0.1.1 -> 0.2.0 (oppure: patch / major), crea commit e tag
git push --follow-tags   # GitHub Actions compila e pubblica la Release
```

Il workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) esegue i test, controlla che il tag corrisponda alla versione, compila installer e portable e li pubblica nella Release insieme a `latest.yml` (il file che le app leggono per sapere se c'è un aggiornamento). Perché gli aggiornamenti funzionino il repository deve essere **pubblico**.

Se fai un **fork** e pubblichi le tue versioni, cambia `repository.url` e `build.publish` in [`package.json`](package.json) con il tuo repository, altrimenti le copie installate continueranno a cercare gli aggiornamenti qui.

## Sviluppo

Serve [Node.js](https://nodejs.org) 20 o superiore.

```bash
npm install                     # dipendenze
npm start                       # avvia l'app desktop
npm run server                  # solo il servizio, interfaccia su http://127.0.0.1:5723
npm test                        # test automatici (stampante virtuale e stampanti in rete finte)
npm run dist                    # crea installer e versione portable in dist/ (senza pubblicarli)
node scripts/fake-printers.js   # stampanti in rete finte sul PC (Bambu, Klipper, PrusaLink, OctoPrint)
node scripts/make-sample.js     # crea un G-code di esempio in samples/
node scripts/build-assets.js    # copia icone e font in src/web dopo aver aggiunto un'icona
```

### Struttura

```
src/
  main.js                 finestra Electron, notifiche, blocco sospensione, conferma di chiusura
  updater.js              aggiornamenti automatici dalle Release di GitHub
  server/
    index.js              server HTTP + WebSocket (token per il PC, chiave per il telefono)
    manager.js            elenco stampanti, configurazione, cronologia
    discovery.js          ricerca delle stampanti in rete (SSDP, mDNS, controllo degli indirizzi)
    printers/             un modulo per tipo: marlin (USB), bambu, klipper, prusalink, octoprint
    firmware/             scrittura via USB delle schede AVR, schede SD, ultime versioni da GitHub
    transport.js          porta seriale (serialport) o stampante virtuale
    virtual-printer.js    simulatore di firmware Marlin
    files.js, threemf.js  archivio file, analisi del G-code e dei progetti .gcode.3mf
    gcode.js              parsing di risposte e file G-code
  web/                    interfaccia (HTML/CSS/JS senza framework)
test/                     test automatici (node --test) con stampanti finte in test/fakes
```

I dati (stampanti, file caricati, cronologia) sono in `%APPDATA%\SonoPrint\data`.
