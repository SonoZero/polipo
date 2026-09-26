# SonoPrint

**SonoPrint** (prima si chiamava Polipo) è un'app per Windows e Mac che controlla **più stampanti 3D contemporaneamente**, in stile [OctoPrint](https://octoprint.org): via USB oppure in rete (Bambu Lab, Klipper, PrusaLink e OctoPrint).

*made by sonozero*

## Cosa sa fare

- **Più stampanti insieme**, anche di tipi diversi: ognuna con la sua connessione, la sua stampa e le sue impostazioni. La *Panoramica* le mostra tutte.
- **Stampanti in rete con ricerca automatica**: SonoPrint trova da solo le Bambu Lab, le stampanti Klipper, PrusaLink e OctoPrint nella rete di casa; basta premere **Aggiungi**.
- **Stampanti USB**: elenca le porte seriali (COM su Windows, `/dev/cu.*` su Mac), segnala quelle che sembrano stampanti (CH340, FTDI, STM32, Prusa...) e trova da solo il baudrate. Invio del G-code riga per riga con numeri di riga, checksum e reinvio automatico delle righe corrotte.
- **Centro aggiornamenti**: SonoPrint e il firmware o il software di ogni stampante in una pagina sola, con novità, avanzamento passo per passo e **Aggiorna tutto** (vedi sotto).
- **Pausa e ripresa sicure**, **annullamento** con script configurabile e **arresto di emergenza**.
- **Temperature** in tempo reale con grafico e preriscaldamento rapido (PLA, PETG, ABS, TPU... personalizzabili).
- **Controllo manuale**: movimento X/Y/Z, home, estrusione, ventola, velocità, flusso e cambio filamento.
- **Terminale** G-code con cronologia dei comandi.
- **Archivio file** condiviso da tutte le stampanti: `.gcode` e progetti `.gcode.3mf` di Bambu Studio e OrcaSlicer, con miniatura, tempo stimato, filamento, layer e ingombro.
- **Anteprima 3D** del pezzo sul piatto della stampante, che cresce seguendo la stampa in corso: nella scheda Anteprima (con la vista 2D layer per layer), come miniatura nella Panoramica e per ogni file nella pagina File.
- **Tempo rimanente e ora di fine**.
- **Telecamere**: webcam USB, flussi MJPEG/snapshot di rete, telecamera integrata delle Bambu P1 e A1 e telecamere di Klipper.
- **Cronologia** delle stampe con statistiche, **notifiche del sistema** a fine stampa, blocco della **sospensione** del computer durante le stampe USB.
- **Accesso dalla rete** dal browser di telefono, tablet o altri computer, con password.
- **Accesso dal telefono** con QR code e chiave segreta.
- **Temi chiaro e scuro**, interfaccia che funziona anche senza internet.
- **Stampante virtuale** che simula un firmware Marlin, per provare tutto senza stampante.

## Stampanti supportate

| Tipo | Cosa serve |
| --- | --- |
| **USB** (Marlin, Prusa, RepRapFirmware e derivati) | Cavo USB. Le stampe partono dal computer: se chiudi SonoPrint o il computer va in sospensione, la stampa si ferma. |
| **Bambu Lab** (X1, P1, A1, H2) | Sulla stampante, in *Impostazioni > WLAN*, attiva la **Modalità solo LAN** e la **Modalità sviluppatore** (senza, SonoPrint può solo leggere lo stato). Servono indirizzo IP e codice di accesso LAN (8 cifre, nella stessa pagina); il numero di serie SonoPrint lo legge da solo. |
| **Klipper** (Moonraker, come Mainsail e Fluidd) | Indirizzo della stampante, porta 7125 (se non risponde prova 80); la chiave API solo se Moonraker la richiede. |
| **PrusaLink** (MK4, MK3.9, Core One, MINI+, XL) | Indirizzo, nome utente (di solito `maker`) e password da *Impostazioni > Rete > PrusaLink* sulla stampante; con i firmware vecchi la chiave API. PrusaLink non permette di muovere gli assi né di impostare le temperature. |
| **OctoPrint** | Indirizzo e chiave API: premi **Chiedi l'accesso** e conferma nella pagina di OctoPrint, oppure crea una chiave in *Impostazioni > Application Keys*. |

Le stampanti in rete continuano a stampare da sole anche se chiudi SonoPrint.

## Uso

1. Apri SonoPrint e premi **Aggiungi stampante**: in alto compaiono quelle trovate in rete, altrimenti scegli il tipo e compila i dati.
2. Carica un file `.gcode` o `.gcode.3mf` nella pagina **File** (o trascinalo).
3. Premi **Stampa su...** e scegli la stampante, oppure dalla pagina della stampante **Scegli file da stampare**.

Se una stampante USB non si connette:
- chiudi Cura, PrusaSlicer, Arduino IDE o altri programmi che usano la stessa porta COM;
- installa il driver CH340 se la porta non compare (schede Creality e Anycubic più vecchie);
- prova un altro baudrate (le Anycubic i3 Mega usano 250000, quasi tutte le altre 115200).

## In background e all'avvio del computer

Le stampanti USB ricevono la stampa riga per riga da SonoPrint, quindi SonoPrint deve restare aperto fino alla fine. In **Impostazioni, Avvio e background**:

- **Resta attivo in background quando chiudi la finestra** (acceso di serie): chiudendo la finestra SonoPrint resta fra le icone accanto all'orologio, continua a stampare e resta raggiungibile dalla rete. Clic sull'icona per riaprirlo, clic destro e **Esci** per chiuderlo del tutto (con una stampa USB in corso chiede conferma).
- **Avvia SonoPrint quando accendi il computer**: parte nascosto all'accesso a Windows e collega da solo le stampanti con la connessione automatica. Su Mac parte e resta nel Dock.
- **Priorità alta durante le stampe USB** (Windows, acceso di serie): mentre una stampante USB stampa, SonoPrint ha la priorità alta (non "tempo reale", che può bloccare mouse e tastiera), Windows non lo mette in modalità efficienza anche con la finestra nascosta e, con "Impedisci al computer di andare in sospensione", il computer resta sveglio fino alla fine. Finite le stampe torna tutto normale.

Nessuna di queste impostazioni ferma i riavvii forzati di Windows Update: imposta l'**orario di attività** di Windows (Impostazioni, Windows Update, Opzioni avanzate) sulle ore in cui stampi, oppure sospendi gli aggiornamenti durante le stampe lunghe.

**Desktop remoto**: uscire dall'account di Windows (Start, Esci) chiude tutti i programmi, anche quelli in background, e quindi ferma le stampe USB. Per lasciare una stampa in corso chiudi la finestra del Desktop remoto con la X: la sessione resta aperta. Se qualcuno prova a uscire dall'account o a spegnere mentre SonoPrint stampa, SonoPrint lo blocca e Windows mostra che SonoPrint sta stampando.

Se SonoPrint si chiude durante una stampa (uscita dall'account, spegnimento, blocco), al riavvio la stampa compare nella **Cronologia** con il motivo e una finestra lo spiega. Il registro di avvii e chiusure è in `%APPDATA%\SonoPrint\logs\sonoprint.log` (**Impostazioni, Informazioni, Registro**).

## Centro aggiornamenti

La pagina **Aggiornamenti** del menu raccoglie tutto; il numero accanto alla voce dice quanti aggiornamenti ci sono.

- **SonoPrint**: versione installata e nuova, novità della nuova versione, avanzamento del download e **Riavvia e aggiorna**.
- **Ogni stampante**: firmware o software installato, cosa c'è di nuovo, quando è stato controllato e l'avanzamento con il registro. **Dettagli** apre gli stessi strumenti della scheda Firmware.
- **Aggiorna tutto** installa uno alla volta quello che SonoPrint sa fare da solo (Klipper, OctoPrint e alla fine l'app), saltando le stampanti che stanno stampando. Il firmware da file (USB, Bambu Lab, Prusa) resta da fare a mano, con le istruzioni nei dettagli.
- Il controllo parte da solo quando una stampante si connette e ogni 6 ore; **Controlla tutto** lo rifà subito.

## Aggiornamento del firmware

Dalla pagina di ogni stampante, scheda **Firmware** (oppure dai dettagli nel centro aggiornamenti):

- **USB, schede a 8 bit** (ATmega2560, 1284P, 328P con bootloader): SonoPrint scrive il file `.hex` via USB e rilegge ogni pagina per verificarla.
- **USB, schede a 32 bit** (Creality 4.2.x, BTT SKR, MKS): SonoPrint copia il file `.bin` sulla scheda SD inserita nel computer con il nome giusto (sempre diverso per Creality, `firmware.bin` per BTT e MKS); rimetti la scheda nella stampante e riaccendila.
- **Bambu Lab**: aggiornamento offline. SonoPrint copia il pacchetto ufficiale sulla microSD della stampante, poi lo avvii dallo schermo in *Impostazioni > Firmware* (le P1 devono avere almeno il firmware 01.07, le A1 almeno il 01.04).
- **Klipper**: update manager di Moonraker (Klipper, Moonraker, Mainsail o Fluidd, pacchetti del sistema), un componente alla volta o tutto insieme.
- **OctoPrint**: aggiornamento di OctoPrint e dei plugin (serve la chiave di un amministratore).
- **PrusaLink**: SonoPrint mostra la versione installata e l'ultima pubblicata da Prusa; l'aggiornamento si fa con la chiavetta USB.

Per Marlin e Prusa SonoPrint confronta la versione installata con l'ultima pubblicata su GitHub.

> Prima di scrivere un firmware su una stampante USB salva le sue impostazioni (comando `M503` nel terminale) e controlla che il file sia fatto per la tua scheda. SonoPrint non tocca il bootloader, quindi se qualcosa va storto si può riprovare, ma con un firmware sbagliato la stampante non funziona finché non rimetti quello giusto.

## Accesso dalla rete

Per usare SonoPrint dal browser di un altro dispositivo (telefono, tablet, un altro computer) collegato alla stessa rete:

1. Sul computer apri **Impostazioni > Accesso dalla rete**, scegli una **password** (almeno 6 caratteri) e attiva **Apri SonoPrint agli altri dispositivi della rete**.
2. Sotto compaiono gli indirizzi da aprire, per esempio `http://192.168.1.16:5723/`, e un QR code da inquadrare con la fotocamera del telefono.
3. Su Windows premi **Consenti nel firewall** se SonoPrint lo propone: Windows chiede la conferma da amministratore e aggiunge la regola per le reti private. Se la tua rete di casa risulta "pubblica", in Windows impostala come privata.
4. Dall'altro dispositivo apri l'indirizzo ed entra con la password: resti collegato per 30 giorni, oppure premi **Esci** in basso a sinistra.

Dalla rete si usa SonoPrint come sul computer, tranne le cose delicate che restano solo sul computer: porta, accesso dalla rete, ricerca delle stampanti, firmware da file e installazione degli aggiornamenti. La password è salvata cifrata; cambiandola, chi era collegato deve rientrare. Spegnendo l'accesso dalla rete SonoPrint torna raggiungibile solo dal computer.

## Accesso dal telefono

L'accesso dal telefono è una funzione per sviluppatori ed è nascosta: in **Impostazioni > Informazioni** tocca **7 volte** il numero di versione per attivare la modalità sviluppatore. Compare la sezione **Accesso dal telefono**: SonoPrint si apre alla rete di casa e mostra un QR code da inquadrare con l'app per il telefono. Spegnendo la modalità sviluppatore si spegne anche l'accesso dal telefono.

- L'accesso è protetto da una **chiave segreta** casuale contenuta nel QR code; si può rigenerare in qualsiasi momento (i telefoni abbinati andranno riabbinati).
- Dalla rete si raggiungono solo le API per l'app: la pagina web di SonoPrint, la porta e le impostazioni di rete restano accessibili **solo dal computer**.
- Al primo avvio Windows può chiedere di consentire l'accesso alla rete: scegli **Reti private**. Su Mac scegli **Consenti** quando chiede di cercare dispositivi nella rete locale.
- **Fuori casa**: installa [Tailscale](https://tailscale.com/download) su computer e telefono; è più sicuro che aprire porte sul router.

## Aggiornamenti dell'app

La versione installata (`SonoPrint-Setup-x.y.z.exe`) si aggiorna da sola dalle [Release di GitHub](../../releases):

- controlla all'avvio e ogni 6 ore (o da **Impostazioni > Aggiornamenti > Controlla ora**);
- scarica la nuova versione in background e mostra **Riavvia e aggiorna** nella barra laterale;
- se una stampa USB è in corso non interrompe nulla: l'aggiornamento si installa a fine stampa o alla chiusura dell'app.

La versione portable (`SonoPrint-Portable-x.y.z.exe`) non può sostituirsi da sola: avvisa quando esce una nuova versione e apre la pagina di download.

Il **wizard dell'aggiornamento** mostra ogni passo (controllo, download con percentuale, installazione) e, dopo il riavvio, dice se l'aggiornamento è andato a buon fine. Il registro è in `%APPDATA%\SonoPrint\logs\updater.log` su Windows e in `~/Library/Application Support/SonoPrint/logs/updater.log` su Mac.

## SonoPrint su Mac

Dalle [Release](../../releases) scarica il file per il tuo Mac:

- `SonoPrint-x.y.z-arm64.dmg` per i Mac con chip Apple (M1, M2, M3, M4...);
- `SonoPrint-x.y.z-x64.dmg` per i Mac con processore Intel.

Apri il DMG e trascina SonoPrint nella cartella **Applicazioni**: da lì si aggiorna da solo, come su Windows. L'app è firmata e notarizzata da Apple, quindi si apre senza avvisi.

- Chiudendo la finestra SonoPrint resta aperto nel Dock e le stampe USB continuano; si esce con **Cmd+Q**, che chiede conferma se una stampa USB è in corso.
- Le stampanti USB compaiono come `/dev/cu.usbserial-...` o `/dev/cu.usbmodem...`. Per le schede con chip CH340 sui Mac più vecchi può servire il driver del produttore.
- Al primo uso macOS chiede il permesso di cercare dispositivi nella **rete locale** (serve per trovare le stampanti in rete) e, se usi una webcam USB, quello per la **telecamera**.
- I dati sono in `~/Library/Application Support/SonoPrint/data`.

### Arrivi da Polipo?

SonoPrint è il nuovo nome di Polipo.

- **Versione installata**: riceve SonoPrint come un normale aggiornamento. L'installer riconosce Polipo e lo sostituisce, senza lasciare due app.
- **Versione portable**: scarica `SonoPrint-Portable` dalle Release.
- **Dati**: al primo avvio SonoPrint copia stampanti, file e cronologia da `%APPDATA%\Polipo\data`. La cartella di Polipo resta dov'è: cancellala tu quando hai controllato che è tutto a posto.
- **App per il telefono**: va abbinata di nuovo.

### Pubblicare una nuova versione

```bash
npm version minor        # 0.1.1 -> 0.2.0 (oppure: patch / major), crea commit e tag
git push --follow-tags   # GitHub Actions compila e pubblica la Release
```

Il workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) esegue i test su Windows e su Mac, controlla che il tag corrisponda alla versione, compila installer e portable per Windows e DMG e ZIP per Mac (Apple Silicon e Intel), e mette tutto in una sola Release insieme a `latest.yml` e `latest-mac.yml` (i file che le app leggono per sapere se c'è un aggiornamento). Perché gli aggiornamenti funzionino il repository deve essere **pubblico**. Da **Actions > Release > Run workflow** si può compilare tutto senza pubblicare, per provare.

### Firma Apple per la versione Mac

Su Mac un'app si aggiorna da sola solo se è firmata con un certificato **Developer ID** e notarizzata da Apple (serve l'Apple Developer Program). Il workflow firma e notarizza quando trova questi segreti in **Settings > Secrets and variables > Actions** del repository:

| Segreto | Cosa contiene |
| --- | --- |
| `MAC_CERTIFICATE` | certificato "Developer ID Application" esportato come `.p12`, in base64 |
| `MAC_CERTIFICATE_PASSWORD` | la password scelta esportando il `.p12` |
| `APPLE_API_KEY` | il contenuto del file `AuthKey_XXXXXXXXXX.p8` (App Store Connect API) |
| `APPLE_API_KEY_ID` | il Key ID di quella chiave |
| `APPLE_API_ISSUER` | l'Issuer ID mostrato nella stessa pagina |

Senza segreti la versione per Mac viene compilata ma non firmata, e non viene pubblicata: la Release contiene solo Windows e il workflow lo segnala.

Se fai un **fork** e pubblichi le tue versioni, cambia `repository.url` e `build.publish` in [`package.json`](package.json) con il tuo repository, altrimenti le copie installate continueranno a cercare gli aggiornamenti qui.

## Limiti noti

- **Bambu Lab**: si stampa solo il primo piatto del 3MF; con l'AMS i filamenti usano gli slot in ordine (1, 2, 3, 4), senza scelta manuale; la telecamera funziona su P1 e A1 (le X1 e H2 usano RTSP, non supportato); delle H2D con due ugelli si vede solo il primo; niente riscaldamento della camera. I file `.gcode.3mf` si stampano solo sulle Bambu Lab.
- **Klipper**: fino a due estrusori.
- **PrusaLink**: niente temperature, movimenti né terminale (limite di PrusaLink).
- **OctoPrint**: il terminale invia i comandi, le risposte si vedono in OctoPrint.
- **Stampanti in rete**: il tipo di una stampante non si cambia; va rimossa e aggiunta di nuovo.
- **Ricerca**: guarda solo la rete del computer (al massimo 254 indirizzi per scheda di rete); le stampanti in altre reti si aggiungono scrivendo l'indirizzo IP.
- **Firmware USB**: solo schede AVR con bootloader (ATmega2560, 1280, 1284P, 644P, 328P); le schede senza bootloader richiedono un programmatore ISP; le schede a 32 bit si aggiornano con la scheda SD.

## Sicurezza

- Codici di accesso, password e chiavi API delle stampanti sono salvati in `%APPDATA%\SonoPrint\data\config.json`, come fa OctoPrint. Non vengono mai mandati all'interfaccia né al telefono.
- Con le Bambu Lab la connessione è verificata con i certificati di Bambu Lab. I firmware vecchi usano un certificato non firmato: SonoPrint lo memorizza alla prima connessione e poi accetta solo quello. Chi fosse già nella tua rete in quel primo momento potrebbe intercettare il codice di accesso: fai la prima connessione da una rete di cui ti fidi.
- Ricerca in rete, caricamento del firmware, schede SD, porta, accesso dalla rete, accesso dal telefono e avvio con il computer si gestiscono solo dal computer.
- L'accesso dalla rete chiede una password (salvata come hash scrypt), limita i tentativi sbagliati e usa un cookie di sessione valido solo per l'indirizzo di SonoPrint: un sito esterno non può usarlo.

## Sviluppo

Serve [Node.js](https://nodejs.org) 20 o superiore.

```bash
npm install                     # dipendenze
npm start                       # avvia l'app desktop
npm run server                  # solo il servizio, interfaccia su http://127.0.0.1:5723
npm test                        # test automatici (stampante virtuale e stampanti in rete finte)
npm run dist                    # Windows: installer e versione portable in dist/ (senza pubblicarli)
npm run dist:mac                # Mac (solo da un Mac): DMG e ZIP in dist/
node scripts/fake-printers.js   # stampanti in rete finte sul PC (Bambu, Klipper, PrusaLink, OctoPrint)
node scripts/make-sample.js     # crea un G-code di esempio in samples/
node scripts/build-assets.js    # copia icone, font e Three.js in src/web (dopo aver aggiunto un'icona o aggiornato three)
```

### Struttura

```
src/
  main.js                 finestra Electron, icona accanto all'orologio, avvio con il computer, notifiche, registro
  print-guard.js          priorità alta, niente modalità efficienza e computer sveglio durante le stampe USB
  updater.js              aggiornamenti automatici dalle Release di GitHub
  server/
    index.js              server HTTP + WebSocket (token per il PC, chiave per il telefono)
    manager.js            elenco stampanti, configurazione, cronologia, stampe interrotte
    discovery.js          ricerca delle stampanti in rete (SSDP, mDNS, controllo degli indirizzi)
    printers/             un modulo per tipo: marlin (USB), bambu, klipper, prusalink, octoprint
    firmware/             scrittura via USB delle schede AVR, schede SD, ultime versioni da GitHub
    transport.js          porta seriale (serialport) o stampante virtuale
    virtual-printer.js    simulatore di firmware Marlin
    files.js, threemf.js  archivio file, analisi del G-code e dei progetti .gcode.3mf
    gcode.js              parsing di risposte e file G-code
  web/                    interfaccia (HTML/CSS/JS senza framework)
    js/components/        anteprima 2D e 3D (preview3d.js), firmware, terminale, telecamera
    js/views/updates.js   centro aggiornamenti
    vendor/three/         Three.js per l'anteprima 3D (copiato da scripts/build-assets.js)
test/                     test automatici (node --test) con stampanti finte in test/fakes
```

I dati (stampanti, file caricati, cronologia) sono in `%APPDATA%\SonoPrint\data` su Windows e in `~/Library/Application Support/SonoPrint/data` su Mac.

## Crediti

Anteprima 3D con [Three.js](https://threejs.org) (MIT), icone [Phosphor](https://phosphoricons.com) (MIT), font [Geist](https://github.com/vercel/geist-font) (SIL OFL 1.1) e le librerie elencate in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), insieme alle fonti della documentazione dei protocolli delle stampanti.
