# 🐙 Polipo

**Polipo** è un'app per Windows che controlla **più stampanti 3D contemporaneamente** via USB, in stile [OctoPrint](https://octoprint.org).
Il nome viene da *octopus* → polipo, e *poli-* = più stampanti.

## Cosa sa fare

- **Più stampanti insieme**: ognuna con la sua connessione USB, la sua stampa e le sue impostazioni. La *Panoramica* le mostra tutte.
- **Connessione USB automatica**: elenca le porte COM, segnala con ★ quelle che sembrano stampanti (CH340, FTDI, STM32, Prusa…) e trova da solo il baudrate.
- **Stampa da PC**: invio del G-code riga per riga con numeri di riga, checksum e reinvio automatico delle righe corrotte (come OctoPrint).
- **Pausa / ripresa sicure**: in pausa ritrae il filamento e alza l'ugello (opzionale: parcheggio della testina); alla ripresa ripristina posizione, estrusione e velocità.
- **Annullamento** con script configurabile (spegne i riscaldatori, alza l'ugello, spegne i motori) e **arresto di emergenza** (M112).
- **Temperature** in tempo reale con grafico, impostazione dei target e preriscaldamento rapido (PLA, PETG, ABS, TPU… personalizzabili).
- **Controllo manuale**: movimento X/Y/Z, home, estrusione/retrazione, ventola, velocità (M220) e flusso (M221), cambio filamento (M600).
- **Terminale** G-code con cronologia dei comandi e filtro delle righe di stampa.
- **Archivio file** condiviso da tutte le stampanti, con trascinamento, miniatura dello slicer, tempo stimato, filamento, layer e ingombro.
- **Anteprima G-code** layer per layer che segue la stampa in corso.
- **Tempo rimanente e ora di fine** (usa i comandi M73 di PrusaSlicer/Orca, i commenti di Cura o la stima dello slicer).
- **Webcam** USB collegata al PC oppure flusso MJPEG/snapshot di rete.
- **Cronologia** delle stampe con statistiche, **notifiche di Windows** a fine stampa, blocco della **sospensione** del PC durante la stampa.
- **Stampante virtuale** che simula un firmware Marlin, per provare tutto senza stampante.

Compatibile con i firmware che parlano G-code via seriale: **Marlin** (Creality, Anycubic, Artillery, Elegoo, Sovol…), **Prusa**, **RepRapFirmware** e derivati.

> ⚠️ Le stampe partono dal PC: se chiudi Polipo o il PC va in sospensione, la stampa si ferma. Polipo chiede conferma prima di chiudersi e impedisce la sospensione mentre stampa.

## Uso

1. Collega la stampante al PC con il cavo USB e accendila.
2. Apri Polipo → **Aggiungi stampante** → scegli nome, modello (il volume di stampa si compila da solo) e porta USB → **Salva e connetti**.
3. Carica un file `.gcode` nella pagina **File G-code** (o trascinalo).
4. Premi **Stampa su…** e scegli la stampante, oppure dalla pagina della stampante **Scegli file da stampare**.

Se la connessione non riesce:
- chiudi Cura, PrusaSlicer, Arduino IDE o altri programmi che usano la stessa porta COM;
- installa il driver CH340 se la porta non compare (schede Creality/Anycubic più vecchie);
- prova un altro baudrate (le Anycubic i3 Mega usano 250000, quasi tutte le altre 115200).

## Aggiornamenti

La versione installata (`Polipo-Setup-x.y.z.exe`) si aggiorna da sola dalle [Release di GitHub](../../releases):

- controlla all'avvio e ogni 6 ore (o da **Impostazioni → Aggiornamenti → Controlla ora**);
- scarica la nuova versione in background e mostra **Riavvia e aggiorna** nella barra laterale;
- se una stampa è in corso non interrompe nulla: l'aggiornamento si installa a fine stampa o alla chiusura di Polipo.

La versione portable (`Polipo-Portable-x.y.z.exe`) non può sostituirsi da sola: avvisa quando esce una nuova versione e apre la pagina di download.

### Pubblicare una nuova versione

```bash
npm version patch        # 0.1.0 -> 0.1.1 (oppure: minor / major), crea commit e tag v0.1.1
git push --follow-tags   # GitHub Actions compila e pubblica la Release
```

Il workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) esegue i test, controlla che il tag corrisponda alla versione, compila installer e portable e li pubblica nella Release insieme a `latest.yml` (il file che le app leggono per sapere se c'è un aggiornamento). Perché gli aggiornamenti funzionino il repository deve essere **pubblico**.

## Sviluppo

Serve [Node.js](https://nodejs.org) 20 o superiore.

```bash
npm install                     # dipendenze
node node_modules/electron/install.js   # solo se Electron non ha scaricato il suo eseguibile
npm start                       # avvia l'app desktop
npm run server                  # solo il servizio, interfaccia su http://127.0.0.1:5723
npm test                        # test del protocollo con la stampante virtuale
npm run dist                    # crea installer e versione portable in dist/ (senza pubblicarli)
node scripts/make-sample.js     # crea un G-code di esempio in samples/
```

### Struttura

```
src/
  main.js                 finestra Electron, notifiche, blocco sospensione, conferma di chiusura
  updater.js              aggiornamenti automatici dalle Release di GitHub
  server/
    index.js              server HTTP + WebSocket (solo localhost, protetto da token)
    manager.js            elenco stampanti, configurazione, cronologia
    printer.js            protocollo Marlin: connessione, coda comandi, resend, stampa, pausa
    transport.js          porta seriale (serialport) o stampante virtuale
    virtual-printer.js    simulatore di firmware Marlin
    files.js              archivio G-code e analisi dei file
    gcode.js              parsing di risposte e file G-code
  web/                    interfaccia (HTML/CSS/JS senza framework)
test/                     test automatici (node --test)
```

I dati (stampanti, file caricati, cronologia) sono in `%APPDATA%\Polipo\data`.
