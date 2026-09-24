'use strict';

// Avvia solo il servizio Polipo (senza finestra): l'interfaccia si apre nel browser.
//   npm run server        ->  http://127.0.0.1:5723/  (o la porta scelta nelle impostazioni)
//   PORT=6000 npm run server   per forzare una porta

const path = require('path');
const { startServer } = require('../src/server');

(async () => {
  const dataDir = process.env.POLIPO_DATA || path.join(__dirname, '..', 'data');
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  const srv = await startServer({ dataDir, port });
  console.log(`Polipo in esecuzione su ${srv.url}  (dati in ${dataDir})`);
  srv.events.on('url-changed', (url) => console.log(`Polipo ora è su ${url}`));
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
